import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { Clock, Context, Effect, Layer, Schema } from "effect";
import {
  CandidateExclusion,
  KeyPolicy,
  type AnalyticsSnapshot,
  type ApiKeyPublic,
  type ClassificationReuse,
  type ClassifierMode,
  type ClassifierQualification,
  type ClassifierSource,
  type KeyPolicy as KeyPolicyType,
} from "../domain.ts";
import {
  AuthFailed,
  ConcurrentLimit,
  Conflict,
  DatabaseError,
  InvalidInput,
  KeyExpired,
  KeyNotFound,
  KeyRevoked,
  PepperMismatch,
  RateLimited,
  StaleVersion,
} from "../errors.ts";
import {
  apiKeys,
  auditLog,
  batchItems,
  batchJobs,
  rateLimits,
  requests,
  settings,
} from "../db/schema.ts";
import { SqliteDatabase, type ControlPlaneSession } from "../db/sqlite.ts";
import {
  apiKeyDigest,
  generateApiKey,
  parseApiKey,
  pepperFingerprint,
  timingSafeEqualHex,
} from "./crypto.ts";
import { queryAnalyticsSnapshot, type AnalyticsQuery } from "./analytics.ts";
import {
  AUDIT_RETENTION_MS,
  MAINTENANCE_INTERVAL_MS,
  REQUEST_LEASE_MS,
  REQUEST_RETENTION_MS,
  type Admission,
  type CreatedKey,
  type FinalizeOutcome,
  type KeyList,
  type KeyUsage,
  type ListedKey,
  type RecentRequest,
  type RecentRequestList,
  type UsageSummary,
} from "./types.ts";

const PEPPER_SETTING = "pepper_fingerprint";
const MAINTENANCE_SETTING = "last_maintenance_at";
const DUMMY_TOKEN = `jrv_${"0".repeat(24)}.${"A".repeat(43)}`;

export type RepoError =
  | DatabaseError
  | InvalidInput
  | AuthFailed
  | KeyNotFound
  | KeyRevoked
  | KeyExpired
  | StaleVersion
  | Conflict
  | RateLimited
  | ConcurrentLimit
  | PepperMismatch;

type KeyPolicyUpdate = Omit<KeyPolicyType, "overloadAction"> &
  Partial<Pick<KeyPolicyType, "overloadAction">>;

export class KeyRepository extends Context.Service<
  KeyRepository,
  {
    createKey(input: {
      name: string;
      expiresAt: number | null;
      policy: KeyPolicyType;
    }): Effect.Effect<CreatedKey, RepoError>;
    getKey(id: string): Effect.Effect<ApiKeyPublic, RepoError>;
    listKeys(input: { cursor?: string | null; limit?: number }): Effect.Effect<KeyList, RepoError>;
    updateKey(input: {
      id: string;
      expectedVersion: number;
      name: string;
      expiresAt: number | null;
      policy: KeyPolicyUpdate;
    }): Effect.Effect<ApiKeyPublic, RepoError>;
    revokeKey(id: string): Effect.Effect<ApiKeyPublic, RepoError>;
    rotateKey(input: { id: string; expectedVersion: number }): Effect.Effect<CreatedKey, RepoError>;
    admit(rawKey: string): Effect.Effect<Admission, RepoError>;
    admitByKeyId(keyId: string): Effect.Effect<Admission, RepoError>;
    authenticate(rawKey: string): Effect.Effect<ApiKeyPublic, RepoError>;
    recheck(admission: Admission): Effect.Effect<Admission, RepoError>;
    finalize(admission: Admission, outcome: FinalizeOutcome): Effect.Effect<void, RepoError>;
    attach(admission: Admission, itemId: string): Effect.Effect<void, RepoError>;
    defer(
      admission: Admission,
      itemId: string,
      metadata: Omit<FinalizeOutcome, "status">,
      deadlineAt: number,
    ): Effect.Effect<void, RepoError>;
    recheckDeferred(admission: Admission): Effect.Effect<void, RepoError>;
    finalizeDeferred(
      keyId: string,
      requestId: string,
      outcome: FinalizeOutcome,
    ): Effect.Effect<void, RepoError>;
    finalizeInterrupted(keyId: string, itemId: string): Effect.Effect<void, RepoError>;
    usageSummary(input: {
      since?: number;
      until?: number;
      keyId?: string;
    }): Effect.Effect<UsageSummary, RepoError>;
    recentRequests(input: {
      cursor?: string | null;
      limit?: number;
      keyId?: string;
      since?: number;
      until?: number;
      priority?: "high" | "medium" | "low";
      deploymentId?: string;
    }): Effect.Effect<RecentRequestList, RepoError>;
    analytics(
      input: AnalyticsQuery,
      qualifications: readonly ClassifierQualification[],
    ): Effect.Effect<AnalyticsSnapshot, RepoError>;
  }
>()("dymoo/llm-router/keys/KeyRepository") {}

function persistenceFailure(): DatabaseError {
  return new DatabaseError({ message: "persistence failure" });
}
function mapRepoError(cause: unknown): RepoError {
  if (
    cause instanceof DatabaseError ||
    cause instanceof InvalidInput ||
    cause instanceof AuthFailed ||
    cause instanceof KeyNotFound ||
    cause instanceof KeyRevoked ||
    cause instanceof KeyExpired ||
    cause instanceof StaleVersion ||
    cause instanceof Conflict ||
    cause instanceof RateLimited ||
    cause instanceof ConcurrentLimit ||
    cause instanceof PepperMismatch
  ) {
    return cause;
  }
  return persistenceFailure();
}

function decodePolicyJson(json: string): KeyPolicyType {
  try {
    return Schema.decodeUnknownSync(KeyPolicy)(JSON.parse(json) as unknown);
  } catch {
    throw new InvalidInput({ message: "stored policy is invalid" });
  }
}

function encodePolicy(policy: KeyPolicyType): string {
  return JSON.stringify(Schema.decodeUnknownSync(KeyPolicy)(policy));
}

function requireName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 128) {
    throw new InvalidInput({ message: "invalid key name" });
  }
  return trimmed;
}

function utcMinute(now: number): number {
  return Math.floor(now / 60_000);
}

function encodeCursor(left: number, right: string): string {
  return Buffer.from(`${left}\t${right}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { left: number; right: string } {
  try {
    const [left, right] = Buffer.from(cursor, "base64url").toString("utf8").split("\t");
    if (left === undefined || right === undefined || right.length === 0) {
      throw new Error("empty");
    }
    const parsed = Number(left);
    if (!Number.isInteger(parsed)) {
      throw new Error("nan");
    }
    return { left: parsed, right };
  } catch {
    throw new InvalidInput({ message: "invalid cursor" });
  }
}

function toPublic(row: typeof apiKeys.$inferSelect, policy: KeyPolicyType): ApiKeyPublic {
  return {
    id: row.id,
    prefix: row.prefix,
    name: row.name,
    policy,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    lastUsedAt: row.lastUsedAt,
    version: row.version,
  };
}

function emptyUsage(): KeyUsage {
  return {
    requestCount: 0,
    runningCount: 0,
    successCount: 0,
    errorCount: 0,
    abandonedCount: 0,
    promptTokens: null,
    completionTokens: null,
  };
}

function addKnown(sum: number | null, value: number | null | undefined): number | null {
  if (value === null || value === undefined) {
    return sum;
  }
  return (sum ?? 0) + value;
}

function assertActive(row: typeof apiKeys.$inferSelect, now: number): void {
  if (row.revokedAt !== null) {
    throw new KeyRevoked({ message: "key revoked" });
  }
  if (row.expiresAt !== null && row.expiresAt <= now) {
    throw new KeyExpired({ message: "key expired" });
  }
}

function recoverStale(tx: ControlPlaneSession, now: number): void {
  tx.update(requests)
    .set({ status: "abandoned", finishedAt: now })
    .where(
      and(
        eq(requests.status, "running"),
        eq(requests.deferred, 0),
        lte(requests.leaseExpiresAt, now),
      ),
    )
    .run();
}

/** The accounting columns shared by ordinary finalization and remote-deferred
 * finalization. A missing field means "preserve the value already written by
 * assessment/planning"; explicit nulls therefore remain unknown rather than
 * becoming zero. */
function requestOutcomeFields(
  lease: typeof requests.$inferSelect,
  outcome: Omit<FinalizeOutcome, "status">,
) {
  return {
    deploymentId: outcome.deploymentId ?? lease.deploymentId,
    promptTokens: outcome.promptTokens ?? lease.promptTokens,
    completionTokens: outcome.completionTokens ?? lease.completionTokens,
    reasoningTokens: outcome.reasoningTokens ?? lease.reasoningTokens,
    cachedInputTokens: outcome.cachedInputTokens ?? lease.cachedInputTokens,
    ttftMs: outcome.ttftMs ?? lease.ttftMs,
    generationElapsedMs: outcome.generationElapsedMs ?? lease.generationElapsedMs,
    providerReportedUsd: outcome.providerReportedUsd ?? lease.providerReportedUsd,
    estimatedCostUsd: outcome.estimatedCostUsd ?? lease.estimatedCostUsd,
    estimatedCacheSavingsUsd: outcome.estimatedCacheSavingsUsd ?? lease.estimatedCacheSavingsUsd,
    localComputeEstimatedUsd: outcome.localComputeEstimatedUsd ?? lease.localComputeEstimatedUsd,
    priceVersion: outcome.priceVersion ?? lease.priceVersion,
    trajectoryHash: outcome.trajectoryHash ?? lease.trajectoryHash,
    errorCode: outcome.errorCode ?? lease.errorCode,
    classifierBackend: outcome.classifierBackend ?? lease.classifierBackend,
    classifierModelRevision: outcome.modelRevision ?? lease.classifierModelRevision,
    classifierSource: outcome.source ?? lease.classifierSource,
    classifierInputTokens: outcome.classifierInputTokens ?? lease.classifierInputTokens,
    classifierElapsedMs: outcome.classifierElapsedMs ?? lease.classifierElapsedMs,
    classifierReuse: outcome.reuse ?? lease.classifierReuse,
    location: outcome.location ?? lease.location,
    transport: outcome.transport ?? lease.transport,
    boundary: outcome.boundary ?? lease.boundary,
    saturation: outcome.saturation === undefined ? lease.saturation : outcome.saturation ? 1 : 0,
    queueWaitMs: outcome.queueWaitMs ?? lease.queueWaitMs,
    decisionReason: outcome.decisionReason ?? lease.decisionReason,
    selectionReasonCode: outcome.selectionReasonCode ?? lease.selectionReasonCode,
    selectionReasonDetail: outcome.selectionReasonDetail ?? lease.selectionReasonDetail,
    exclusionJson: outcome.exclusionJson ?? lease.exclusionJson,
    taskKind: outcome.taskKind ?? lease.taskKind,
    difficulty: outcome.difficulty ?? lease.difficulty,
    requestedEffort: outcome.requestedEffort ?? lease.requestedEffort,
    decodeTps: outcome.decodeTps ?? lease.decodeTps,
    cacheObservation: outcome.cacheObservation ?? lease.cacheObservation,
    costSource: outcome.costSource ?? lease.costSource,
    decisionTraceJson: outcome.decisionTraceJson ?? lease.decisionTraceJson,
  };
}

/** Remote generation has not happened at defer time. Keep planned deployment
 * and all classifier/decision facts, but never turn unknown generation facts
 * into a guessed zero or a local price. */
function remoteDeferredFields(
  metadata: Omit<FinalizeOutcome, "status">,
): Omit<FinalizeOutcome, "status"> {
  return {
    ...metadata,
    promptTokens: null,
    completionTokens: null,
    reasoningTokens: null,
    cachedInputTokens: null,
    ttftMs: null,
    generationElapsedMs: null,
    providerReportedUsd: null,
    estimatedCostUsd: null,
    estimatedCacheSavingsUsd: null,
    localComputeEstimatedUsd: null,
    priceVersion: null,
    trajectoryHash: null,
    costSource: null,
  };
}

function maybeMaintain(tx: ControlPlaneSession, now: number): void {
  const row = tx.select().from(settings).where(eq(settings.key, MAINTENANCE_SETTING)).get();
  const last = row === undefined ? 0 : Number(row.value);
  if (Number.isFinite(last) && now - last < MAINTENANCE_INTERVAL_MS) {
    return;
  }
  const requestCutoff = now - REQUEST_RETENTION_MS;
  const auditCutoff = now - AUDIT_RETENTION_MS;
  tx.delete(requests)
    .where(and(lte(requests.startedAt, requestCutoff), sql`${requests.status} != 'running'`))
    .run();
  tx.delete(auditLog).where(lte(auditLog.at, auditCutoff)).run();
  tx.delete(rateLimits)
    .where(lte(rateLimits.minute, utcMinute(now) - 2))
    .run();
  if (row === undefined) {
    tx.insert(settings)
      .values({ key: MAINTENANCE_SETTING, value: String(now) })
      .run();
  } else {
    tx.update(settings)
      .set({ value: String(now) })
      .where(eq(settings.key, MAINTENANCE_SETTING))
      .run();
  }
}

function writeAudit(
  tx: ControlPlaneSession,
  now: number,
  action: string,
  keyId: string | null,
): void {
  tx.insert(auditLog).values({ id: randomUUID(), at: now, action, keyId }).run();
}

function usageForKeys(tx: ControlPlaneSession, ids: string[]): Map<string, KeyUsage> {
  const usage = new Map<string, KeyUsage>();
  for (const id of ids) {
    usage.set(id, emptyUsage());
  }
  if (ids.length === 0) {
    return usage;
  }
  const rows = tx
    .select({
      keyId: requests.keyId,
      status: requests.status,
      promptTokens: requests.promptTokens,
      completionTokens: requests.completionTokens,
    })
    .from(requests)
    .where(inArray(requests.keyId, ids))
    .all();
  for (const row of rows) {
    const current = usage.get(row.keyId) ?? emptyUsage();
    const next: KeyUsage = {
      requestCount: current.requestCount + 1,
      runningCount: current.runningCount + (row.status === "running" ? 1 : 0),
      successCount: current.successCount + (row.status === "success" ? 1 : 0),
      errorCount: current.errorCount + (row.status === "error" ? 1 : 0),
      abandonedCount: current.abandonedCount + (row.status === "abandoned" ? 1 : 0),
      promptTokens: addKnown(current.promptTokens, row.promptTokens),
      completionTokens: addKnown(current.completionTokens, row.completionTokens),
    };
    usage.set(row.keyId, next);
  }
  return usage;
}

function insertGeneratedKey(
  tx: ControlPlaneSession,
  pepper: string,
  now: number,
  input: { name: string; expiresAt: number | null; policy: KeyPolicyType },
): CreatedKey {
  const name = requireName(input.name);
  if (input.expiresAt !== null && input.expiresAt < now) {
    throw new InvalidInput({ message: "expiry must be in the future" });
  }
  const generated = generateApiKey();
  const id = randomUUID();
  tx.insert(apiKeys)
    .values({
      id,
      prefix: generated.prefix,
      digest: apiKeyDigest(pepper, generated.token),
      name,
      policyJson: encodePolicy(input.policy),
      createdAt: now,
      expiresAt: input.expiresAt,
      revokedAt: null,
      lastUsedAt: null,
      version: 1,
    })
    .run();
  writeAudit(tx, now, "create", id);
  const row = tx.select().from(apiKeys).where(eq(apiKeys.id, id)).get();
  if (row === undefined) {
    throw persistenceFailure();
  }
  return { key: toPublic(row, decodePolicyJson(row.policyJson)), secret: generated.token };
}

function authenticatePrefix(
  tx: ControlPlaneSession,
  pepper: string,
  rawKey: string,
  now: number,
): typeof apiKeys.$inferSelect {
  const parsed = parseApiKey(rawKey);
  const presented = parsed === undefined ? DUMMY_TOKEN : parsed.token;
  const digest = apiKeyDigest(pepper, presented);
  const row =
    parsed === undefined
      ? undefined
      : tx.select().from(apiKeys).where(eq(apiKeys.prefix, parsed.prefix)).get();
  const stored = row?.digest ?? apiKeyDigest(pepper, DUMMY_TOKEN);
  const matched = timingSafeEqualHex(digest, stored) && row !== undefined && parsed !== undefined;
  if (!matched) {
    throw new AuthFailed({ message: "invalid api key" });
  }
  assertActive(row, now);
  return row;
}

function ensurePepperSync(db: ControlPlaneSession, pepper: string): void {
  const fingerprint = pepperFingerprint(pepper);
  const row = db.select().from(settings).where(eq(settings.key, PEPPER_SETTING)).get();
  if (row === undefined) {
    db.insert(settings).values({ key: PEPPER_SETTING, value: fingerprint }).run();
    return;
  }
  if (!timingSafeEqualHex(row.value, fingerprint)) {
    throw new PepperMismatch({ message: "api key pepper does not match this database" });
  }
}

export const keyRepositoryLayer = (options: {
  pepper: string;
}): Layer.Layer<KeyRepository, RepoError, SqliteDatabase> =>
  Layer.effect(
    KeyRepository,
    Effect.gen(function* () {
      const database = yield* SqliteDatabase;
      yield* Effect.try({
        try: () => ensurePepperSync(database.db, options.pepper),
        catch: mapRepoError,
      });
      const pepper = options.pepper;
      const db = database.db;

      const createKey = Effect.fn("KeyRepository.createKey")(function* (input: {
        name: string;
        expiresAt: number | null;
        policy: KeyPolicyType;
      }) {
        const now = yield* Clock.currentTimeMillis;
        return yield* Effect.try({
          try: () =>
            db.transaction((tx) => insertGeneratedKey(tx, pepper, now, input), {
              behavior: "immediate",
            }),
          catch: mapRepoError,
        });
      });

      const getKey = Effect.fn("KeyRepository.getKey")(function* (id: string) {
        return yield* Effect.try({
          try: () => {
            const row = db.select().from(apiKeys).where(eq(apiKeys.id, id)).get();
            if (row === undefined) {
              throw new KeyNotFound({ message: "key not found" });
            }
            return toPublic(row, decodePolicyJson(row.policyJson));
          },
          catch: mapRepoError,
        });
      });

      const listKeys = Effect.fn("KeyRepository.listKeys")(function* (input: {
        cursor?: string | null;
        limit?: number;
      }) {
        const now = yield* Clock.currentTimeMillis;
        return yield* Effect.try({
          try: () =>
            db.transaction(
              (tx) => {
                maybeMaintain(tx, now);
                recoverStale(tx, now);
                const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
                const cursor =
                  input.cursor === undefined || input.cursor === null || input.cursor.length === 0
                    ? undefined
                    : decodeCursor(input.cursor);
                const rows =
                  cursor === undefined
                    ? tx
                        .select()
                        .from(apiKeys)
                        .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id))
                        .limit(limit + 1)
                        .all()
                    : tx
                        .select()
                        .from(apiKeys)
                        .where(
                          sql`(${apiKeys.createdAt} < ${cursor.left}) OR (${apiKeys.createdAt} = ${cursor.left} AND ${apiKeys.id} < ${cursor.right})`,
                        )
                        .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id))
                        .limit(limit + 1)
                        .all();
                const page = rows.slice(0, limit);
                const usage = usageForKeys(
                  tx,
                  page.map((row) => row.id),
                );
                const items: ListedKey[] = page.map((row) => ({
                  ...toPublic(row, decodePolicyJson(row.policyJson)),
                  usage: usage.get(row.id) ?? emptyUsage(),
                }));
                const last = page[page.length - 1];
                return {
                  items,
                  nextCursor:
                    rows.length > limit && last !== undefined
                      ? encodeCursor(last.createdAt, last.id)
                      : null,
                };
              },
              { behavior: "immediate" },
            ),
          catch: mapRepoError,
        });
      });

      const updateKey = Effect.fn("KeyRepository.updateKey")(function* (input: {
        id: string;
        expectedVersion: number;
        name: string;
        expiresAt: number | null;
        policy: KeyPolicyUpdate;
      }) {
        const now = yield* Clock.currentTimeMillis;
        return yield* Effect.try({
          try: () =>
            db.transaction(
              (tx) => {
                const row = tx.select().from(apiKeys).where(eq(apiKeys.id, input.id)).get();
                if (row === undefined) {
                  throw new KeyNotFound({ message: "key not found" });
                }
                if (row.revokedAt !== null) {
                  throw new KeyRevoked({ message: "key revoked" });
                }
                if (row.version !== input.expectedVersion) {
                  throw new StaleVersion({ message: "key version conflict" });
                }
                const name = requireName(input.name);
                if (input.expiresAt !== null && input.expiresAt < now) {
                  throw new InvalidInput({ message: "expiry must be in the future" });
                }
                const overloadAction =
                  input.policy.overloadAction ?? decodePolicyJson(row.policyJson).overloadAction;
                tx.update(apiKeys)
                  .set({
                    name,
                    expiresAt: input.expiresAt,
                    policyJson: encodePolicy({ ...input.policy, overloadAction }),
                    version: row.version + 1,
                  })
                  .where(and(eq(apiKeys.id, input.id), eq(apiKeys.version, input.expectedVersion)))
                  .run();
                writeAudit(tx, now, "update", input.id);
                const updated = tx.select().from(apiKeys).where(eq(apiKeys.id, input.id)).get();
                if (updated === undefined) {
                  throw persistenceFailure();
                }
                return toPublic(updated, decodePolicyJson(updated.policyJson));
              },
              { behavior: "immediate" },
            ),
          catch: mapRepoError,
        });
      });

      const revokeKey = Effect.fn("KeyRepository.revokeKey")(function* (id: string) {
        const now = yield* Clock.currentTimeMillis;
        return yield* Effect.try({
          try: () =>
            db.transaction(
              (tx) => {
                const row = tx.select().from(apiKeys).where(eq(apiKeys.id, id)).get();
                if (row === undefined) {
                  throw new KeyNotFound({ message: "key not found" });
                }
                if (row.revokedAt !== null) {
                  return toPublic(row, decodePolicyJson(row.policyJson));
                }
                tx.update(apiKeys)
                  .set({ revokedAt: now, version: row.version + 1 })
                  .where(eq(apiKeys.id, id))
                  .run();
                writeAudit(tx, now, "revoke", id);
                const updated = tx.select().from(apiKeys).where(eq(apiKeys.id, id)).get();
                if (updated === undefined) {
                  throw persistenceFailure();
                }
                return toPublic(updated, decodePolicyJson(updated.policyJson));
              },
              { behavior: "immediate" },
            ),
          catch: mapRepoError,
        });
      });

      const rotateKey = Effect.fn("KeyRepository.rotateKey")(function* (input: {
        id: string;
        expectedVersion: number;
      }) {
        const now = yield* Clock.currentTimeMillis;
        return yield* Effect.try({
          try: () =>
            db.transaction(
              (tx) => {
                const row = tx.select().from(apiKeys).where(eq(apiKeys.id, input.id)).get();
                if (row === undefined) {
                  throw new KeyNotFound({ message: "key not found" });
                }
                if (row.revokedAt !== null) {
                  throw new KeyRevoked({ message: "key revoked" });
                }
                if (row.version !== input.expectedVersion) {
                  throw new StaleVersion({ message: "key version conflict" });
                }
                const created = insertGeneratedKey(tx, pepper, now, {
                  name: row.name,
                  expiresAt: row.expiresAt,
                  policy: decodePolicyJson(row.policyJson),
                });
                tx.update(apiKeys)
                  .set({ revokedAt: now, version: row.version + 1 })
                  .where(and(eq(apiKeys.id, input.id), eq(apiKeys.version, input.expectedVersion)))
                  .run();
                writeAudit(tx, now, "rotate", input.id);
                return created;
              },
              { behavior: "immediate" },
            ),
          catch: mapRepoError,
        });
      });

      const authenticate = Effect.fn("KeyRepository.authenticate")(function* (rawKey: string) {
        const now = yield* Clock.currentTimeMillis;
        return yield* Effect.try({
          try: () => {
            const row = authenticatePrefix(db, pepper, rawKey, now);
            return toPublic(row, decodePolicyJson(row.policyJson));
          },
          catch: mapRepoError,
        });
      });

      const admit = Effect.fn("KeyRepository.admit")(function* (rawKey: string) {
        const now = yield* Clock.currentTimeMillis;
        return yield* Effect.try({
          try: () =>
            db.transaction(
              (tx) => {
                maybeMaintain(tx, now);
                recoverStale(tx, now);
                const row = authenticatePrefix(tx, pepper, rawKey, now);
                return admitRow(tx, row, now);
              },
              { behavior: "immediate" },
            ),
          catch: mapRepoError,
        });
      });

      /** The admission transaction body shared by `admit` and `admitByKeyId`: policy decode,
       * concurrency/rate checks, request-row insert, and lease stamping. */
      function admitRow(
        tx: ControlPlaneSession,
        row: typeof apiKeys.$inferSelect,
        now: number,
      ): Admission {
        {
          const policy = decodePolicyJson(row.policyJson);
          if (policy.maxConcurrent <= 0) {
            throw new ConcurrentLimit({ message: "concurrent request limit reached" });
          }
          if (policy.requestsPerMinute <= 0) {
            throw new RateLimited({ message: "request rate limit reached" });
          }
          const running = tx
            .select({ n: sql<number>`count(*)` })
            .from(requests)
            .where(
              and(
                eq(requests.keyId, row.id),
                eq(requests.status, "running"),
                eq(requests.deferred, 0),
              ),
            )
            .get();
          if ((running?.n ?? 0) >= policy.maxConcurrent) {
            throw new ConcurrentLimit({ message: "concurrent request limit reached" });
          }
          const minute = utcMinute(now);
          const bucket = tx
            .select()
            .from(rateLimits)
            .where(and(eq(rateLimits.keyId, row.id), eq(rateLimits.minute, minute)))
            .get();
          const count = bucket?.count ?? 0;
          if (count >= policy.requestsPerMinute) {
            throw new RateLimited({ message: "request rate limit reached" });
          }
          if (bucket === undefined) {
            tx.insert(rateLimits).values({ keyId: row.id, minute, count: 1 }).run();
          } else {
            tx.update(rateLimits)
              .set({ count: count + 1 })
              .where(and(eq(rateLimits.keyId, row.id), eq(rateLimits.minute, minute)))
              .run();
          }
          const requestId = randomUUID();
          const leaseExpiresAt = now + REQUEST_LEASE_MS;
          tx.insert(requests)
            .values({
              id: requestId,
              keyId: row.id,
              startedAt: now,
              leaseExpiresAt,
              finishedAt: null,
              status: "running",
              deferred: 0,
              priority: policy.priority,
              localityBias: policy.localityBias,
            })
            .run();
          tx.update(apiKeys).set({ lastUsedAt: now }).where(eq(apiKeys.id, row.id)).run();
          return {
            requestId,
            keyId: row.id,
            prefix: row.prefix,
            name: row.name,
            policy,
            version: row.version,
            leaseExpiresAt,
            admittedAt: now,
          } satisfies Admission;
        }
      }

      const admitByKeyId = Effect.fn("KeyRepository.admitByKeyId")(function* (keyId: string) {
        // Batch-only admission path (deferred-lane scheduler): same transaction and the
        // same revocation/expiry/rate/concurrency/policy validation as `admit`, addressed
        // by key id because batch clients hand us no raw key. Never reachable from a route.
        const now = yield* Clock.currentTimeMillis;
        return yield* Effect.try({
          try: () =>
            db.transaction(
              (tx) => {
                maybeMaintain(tx, now);
                recoverStale(tx, now);
                const row = tx.select().from(apiKeys).where(eq(apiKeys.id, keyId)).get();
                if (row === undefined) {
                  throw new AuthFailed({ message: "invalid api key" });
                }
                assertActive(row, now);
                return admitRow(tx, row, now);
              },
              { behavior: "immediate" },
            ),
          catch: mapRepoError,
        });
      });

      const recheck = Effect.fn("KeyRepository.recheck")(function* (admission: Admission) {
        const now = yield* Clock.currentTimeMillis;
        return yield* Effect.try({
          try: () =>
            db.transaction(
              (tx) => {
                recoverStale(tx, now);
                const row = tx.select().from(apiKeys).where(eq(apiKeys.id, admission.keyId)).get();
                if (row === undefined) {
                  throw new KeyNotFound({ message: "key not found" });
                }
                assertActive(row, now);
                if (row.version !== admission.version) {
                  throw new StaleVersion({ message: "key policy changed before dispatch" });
                }
                const lease = tx
                  .select()
                  .from(requests)
                  .where(eq(requests.id, admission.requestId))
                  .get();
                if (
                  lease === undefined ||
                  lease.keyId !== admission.keyId ||
                  lease.status !== "running" ||
                  lease.deferred !== 0 ||
                  lease.leaseExpiresAt <= now
                ) {
                  throw new Conflict({ message: "request lease is no longer valid" });
                }
                const policy = decodePolicyJson(row.policyJson);
                return {
                  ...admission,
                  name: row.name,
                  policy,
                  version: row.version,
                  leaseExpiresAt: lease.leaseExpiresAt,
                } satisfies Admission;
              },
              { behavior: "immediate" },
            ),
          catch: mapRepoError,
        });
      });

      /** Return the metadata-only item/job binding used by attach, defer and
       * deferred finalization. Request bodies never enter this control-plane
       * transaction. */
      function batchBinding(tx: ControlPlaneSession, itemId: string) {
        return tx
          .select({ item: batchItems, job: batchJobs })
          .from(batchItems)
          .innerJoin(batchJobs, eq(batchItems.jobId, batchJobs.id))
          .where(eq(batchItems.id, itemId))
          .get();
      }

      const attach = Effect.fn("KeyRepository.attach")(function* (
        admission: Admission,
        itemId: string,
      ) {
        const now = yield* Clock.currentTimeMillis;
        return yield* Effect.try({
          try: () =>
            db.transaction(
              (tx) => {
                const binding = batchBinding(tx, itemId);
                if (binding === undefined || binding.job.keyId !== admission.keyId) {
                  throw new Conflict({ message: "batch item is not owned by the admitted key" });
                }
                if (binding.item.status !== "running") {
                  throw new Conflict({ message: "batch item is not running" });
                }
                if (
                  binding.item.requestId !== null &&
                  binding.item.requestId !== admission.requestId
                ) {
                  throw new Conflict({ message: "batch item is already bound to another request" });
                }
                const key = tx.select().from(apiKeys).where(eq(apiKeys.id, admission.keyId)).get();
                if (key === undefined) {
                  throw new KeyNotFound({ message: "key not found" });
                }
                assertActive(key, now);
                if (key.version !== admission.version) {
                  throw new StaleVersion({ message: "key policy changed before dispatch" });
                }
                const lease = tx
                  .select()
                  .from(requests)
                  .where(eq(requests.id, admission.requestId))
                  .get();
                if (
                  lease === undefined ||
                  lease.keyId !== admission.keyId ||
                  lease.status !== "running" ||
                  lease.deferred !== 0 ||
                  lease.leaseExpiresAt <= now
                ) {
                  throw new Conflict({ message: "request lease is no longer valid" });
                }
                if (binding.item.requestId === null) {
                  tx.update(batchItems)
                    .set({ requestId: admission.requestId })
                    .where(eq(batchItems.id, itemId))
                    .run();
                }
              },
              { behavior: "immediate" },
            ),
          catch: mapRepoError,
        });
      });

      const defer = Effect.fn("KeyRepository.defer")(function* (
        admission: Admission,
        itemId: string,
        metadata: Omit<FinalizeOutcome, "status">,
        deadlineAt: number,
      ) {
        const now = yield* Clock.currentTimeMillis;
        return yield* Effect.try({
          try: () =>
            db.transaction(
              (tx) => {
                const binding = batchBinding(tx, itemId);
                if (binding === undefined || binding.job.keyId !== admission.keyId) {
                  throw new Conflict({ message: "batch item is not owned by the admitted key" });
                }
                if (binding.item.status !== "running") {
                  throw new Conflict({ message: "batch item is not running" });
                }
                if (binding.item.requestId !== admission.requestId) {
                  throw new Conflict({ message: "batch item is not bound to this request" });
                }
                if (
                  typeof metadata.deploymentId !== "string" ||
                  metadata.deploymentId.length === 0
                ) {
                  throw new Conflict({ message: "deferred request requires a deployment" });
                }
                if (
                  !Number.isSafeInteger(deadlineAt) ||
                  deadlineAt <= now ||
                  deadlineAt > now + REQUEST_RETENTION_MS
                ) {
                  throw new Conflict({ message: "invalid deferred request deadline" });
                }
                const jobDeadlineAt = binding.job.spillAt + binding.job.completionWindowMs;
                if (!Number.isSafeInteger(jobDeadlineAt) || deadlineAt > jobDeadlineAt) {
                  throw new Conflict({
                    message: "deferred request deadline exceeds batch deadline",
                  });
                }
                if (!["validating", "queued", "in_progress"].includes(binding.job.status)) {
                  throw new Conflict({ message: "batch job no longer accepts dispatch" });
                }
                const key = tx.select().from(apiKeys).where(eq(apiKeys.id, admission.keyId)).get();
                if (key === undefined) {
                  throw new KeyNotFound({ message: "key not found" });
                }
                assertActive(key, now);
                if (key.version !== admission.version) {
                  throw new StaleVersion({ message: "key policy changed before dispatch" });
                }
                const lease = tx
                  .select()
                  .from(requests)
                  .where(eq(requests.id, admission.requestId))
                  .get();
                if (
                  lease === undefined ||
                  lease.keyId !== admission.keyId ||
                  lease.status !== "running" ||
                  lease.deferred !== 0 ||
                  lease.leaseExpiresAt <= now
                ) {
                  throw new Conflict({ message: "request lease is no longer valid" });
                }
                tx.update(requests)
                  .set({
                    ...requestOutcomeFields(lease, remoteDeferredFields(metadata)),
                    deferred: 1,
                    leaseExpiresAt: deadlineAt,
                  })
                  .where(eq(requests.id, admission.requestId))
                  .run();
                tx.update(batchItems)
                  .set({ deploymentId: metadata.deploymentId })
                  .where(eq(batchItems.id, itemId))
                  .run();
              },
              { behavior: "immediate" },
            ),
          catch: mapRepoError,
        });
      });

      /** Recheck a remote request after ordinary lease ownership has been handed
       * to the durable batch row but immediately before a new provider POST.
       * This never restores process leases or consumes another rate token. */
      const recheckDeferred = Effect.fn("KeyRepository.recheckDeferred")(function* (
        admission: Admission,
      ) {
        const now = yield* Clock.currentTimeMillis;
        return yield* Effect.try({
          try: () =>
            db.transaction(
              (tx) => {
                const key = tx.select().from(apiKeys).where(eq(apiKeys.id, admission.keyId)).get();
                if (key === undefined) {
                  throw new KeyNotFound({ message: "key not found" });
                }
                assertActive(key, now);
                if (key.version !== admission.version) {
                  throw new StaleVersion({ message: "key policy changed before dispatch" });
                }
                const lease = tx
                  .select()
                  .from(requests)
                  .where(eq(requests.id, admission.requestId))
                  .get();
                if (
                  lease === undefined ||
                  lease.keyId !== admission.keyId ||
                  lease.status !== "running" ||
                  lease.deferred !== 1 ||
                  lease.leaseExpiresAt <= now
                ) {
                  throw new Conflict({ message: "deferred request is no longer valid" });
                }
                const bindings = tx
                  .select({ item: batchItems, job: batchJobs })
                  .from(batchItems)
                  .innerJoin(batchJobs, eq(batchItems.jobId, batchJobs.id))
                  .where(eq(batchItems.requestId, admission.requestId))
                  .all();
                if (bindings.length !== 1 || bindings[0]?.job.keyId !== admission.keyId) {
                  throw new Conflict({ message: "deferred request is not bound to this key" });
                }
                const binding = bindings[0];
                if (binding.item.status !== "running") {
                  throw new Conflict({ message: "batch item is not running" });
                }
                if (!["validating", "queued", "in_progress"].includes(binding.job.status)) {
                  throw new Conflict({ message: "batch job no longer accepts dispatch" });
                }
              },
              { behavior: "immediate" },
            ),
          catch: mapRepoError,
        });
      });

      const finalizeDeferred = Effect.fn("KeyRepository.finalizeDeferred")(function* (
        keyId: string,
        requestId: string,
        outcome: FinalizeOutcome,
      ) {
        const now = yield* Clock.currentTimeMillis;
        return yield* Effect.try({
          try: () =>
            db.transaction(
              (tx) => {
                const lease = tx.select().from(requests).where(eq(requests.id, requestId)).get();
                if (lease === undefined || lease.keyId !== keyId) {
                  throw new Conflict({ message: "deferred request is not owned by this key" });
                }
                if (lease.status !== "running") {
                  if (lease.deferred === 0) {
                    return;
                  }
                  throw new Conflict({ message: "deferred request has an invalid terminal state" });
                }
                const bindings = tx
                  .select({ item: batchItems, job: batchJobs })
                  .from(batchItems)
                  .innerJoin(batchJobs, eq(batchItems.jobId, batchJobs.id))
                  .where(eq(batchItems.requestId, requestId))
                  .all();
                if (bindings.length !== 1 || bindings[0]?.job.keyId !== keyId) {
                  throw new Conflict({
                    message: "deferred request is not bound to one batch item",
                  });
                }
                if (lease.deferred !== 1) {
                  throw new Conflict({ message: "request is not deferred" });
                }
                tx.update(requests)
                  .set({
                    status: outcome.status,
                    finishedAt: now,
                    deferred: 0,
                    ...requestOutcomeFields(lease, outcome),
                  })
                  .where(eq(requests.id, requestId))
                  .run();
              },
              { behavior: "immediate" },
            ),
          catch: mapRepoError,
        });
      });

      /** Settle a request whose batch item was interrupted during recovery.
       * This is deliberately independent of active-key state and works for
       * both ordinary and deferred requests without creating a new admission. */
      const finalizeInterrupted = Effect.fn("KeyRepository.finalizeInterrupted")(function* (
        keyId: string,
        itemId: string,
      ) {
        const now = yield* Clock.currentTimeMillis;
        return yield* Effect.try({
          try: () =>
            db.transaction(
              (tx) => {
                const binding = batchBinding(tx, itemId);
                if (binding === undefined || binding.job.keyId !== keyId) {
                  throw new Conflict({ message: "batch item is not owned by this key" });
                }
                if (binding.item.status !== "interrupted") {
                  throw new Conflict({ message: "batch item is not interrupted" });
                }
                const requestId = binding.item.requestId;
                if (requestId === null) {
                  return;
                }

                const lease = tx.select().from(requests).where(eq(requests.id, requestId)).get();
                if (lease === undefined || lease.keyId !== keyId) {
                  throw new Conflict({ message: "interrupted request is not owned by this key" });
                }
                const bindings = tx
                  .select({ item: batchItems, job: batchJobs })
                  .from(batchItems)
                  .innerJoin(batchJobs, eq(batchItems.jobId, batchJobs.id))
                  .where(eq(batchItems.requestId, requestId))
                  .all();
                if (
                  bindings.length !== 1 ||
                  bindings[0]?.item.id !== itemId ||
                  bindings[0]?.job.id !== binding.job.id ||
                  bindings[0]?.job.keyId !== keyId
                ) {
                  throw new Conflict({ message: "interrupted request is not bound to this item" });
                }
                if (lease.status !== "running") {
                  return;
                }
                tx.update(requests)
                  .set({
                    status: "abandoned",
                    errorCode: "batch_interrupted",
                    deferred: 0,
                    finishedAt: now,
                  })
                  .where(eq(requests.id, requestId))
                  .run();
              },
              { behavior: "immediate" },
            ),
          catch: mapRepoError,
        });
      });

      const finalize = Effect.fn("KeyRepository.finalize")(function* (
        admission: Admission,
        outcome: FinalizeOutcome,
      ) {
        const now = yield* Clock.currentTimeMillis;
        return yield* Effect.try({
          try: () =>
            db.transaction(
              (tx) => {
                const lease = tx
                  .select()
                  .from(requests)
                  .where(eq(requests.id, admission.requestId))
                  .get();
                if (
                  lease === undefined ||
                  lease.keyId !== admission.keyId ||
                  lease.status !== "running" ||
                  lease.deferred !== 0
                ) {
                  return;
                }
                tx.update(requests)
                  .set({
                    status: outcome.status,
                    finishedAt: now,
                    ...requestOutcomeFields(lease, outcome),
                  })
                  .where(eq(requests.id, admission.requestId))
                  .run();
              },
              { behavior: "immediate" },
            ),
          catch: mapRepoError,
        });
      });

      const usageSummary = Effect.fn("KeyRepository.usageSummary")(function* (input: {
        since?: number;
        until?: number;
        keyId?: string;
      }) {
        return yield* Effect.try({
          try: () => {
            const filters = [];
            if (input.keyId !== undefined) {
              filters.push(eq(requests.keyId, input.keyId));
            }
            if (input.since !== undefined) {
              filters.push(gte(requests.startedAt, input.since));
            }
            if (input.until !== undefined) {
              filters.push(lte(requests.startedAt, input.until));
            }
            const where = filters.length === 0 ? undefined : and(...filters);
            const rows =
              where === undefined
                ? db.select().from(requests).all()
                : db.select().from(requests).where(where).all();
            let runningCount = 0;
            let successCount = 0;
            let errorCount = 0;
            let abandonedCount = 0;
            let promptTokens: number | null = null;
            let completionTokens: number | null = null;
            let estimatedCostUsd: number | null = null;
            let providerReportedUsd: number | null = null;
            let localComputeEstimatedUsd: number | null = null;
            let missingUsageCount = 0;
            let missingCostCount = 0;
            let zeroApiPriceMissingLocalCogsCount = 0;
            for (const row of rows) {
              if (row.status === "running") runningCount += 1;
              if (row.status === "success") successCount += 1;
              if (row.status === "error") errorCount += 1;
              if (row.status === "abandoned") abandonedCount += 1;
              promptTokens = addKnown(promptTokens, row.promptTokens);
              completionTokens = addKnown(completionTokens, row.completionTokens);
              estimatedCostUsd = addKnown(estimatedCostUsd, row.estimatedCostUsd);
              providerReportedUsd = addKnown(providerReportedUsd, row.providerReportedUsd);
              localComputeEstimatedUsd = addKnown(
                localComputeEstimatedUsd,
                row.localComputeEstimatedUsd,
              );
              if (row.status !== "running") {
                if (row.promptTokens === null || row.completionTokens === null) {
                  missingUsageCount += 1;
                }
                if (row.providerReportedUsd === null && row.localComputeEstimatedUsd === null) {
                  missingCostCount += 1;
                }
                if (row.providerReportedUsd === 0 && row.localComputeEstimatedUsd === null) {
                  zeroApiPriceMissingLocalCogsCount += 1;
                }
              }
            }
            return {
              requestCount: rows.length,
              runningCount,
              successCount,
              errorCount,
              abandonedCount,
              promptTokens,
              completionTokens,
              estimatedCostUsd,
              providerReportedUsd,
              localComputeEstimatedUsd,
              missingUsageCount,
              missingCostCount,
              zeroApiPriceMissingLocalCogsCount,
            };
          },
          catch: mapRepoError,
        });
      });

      const recentRequests = Effect.fn("KeyRepository.recentRequests")(function* (input: {
        cursor?: string | null;
        limit?: number;
        keyId?: string;
        since?: number;
        until?: number;
        priority?: "high" | "medium" | "low";
        deploymentId?: string;
      }) {
        return yield* Effect.try({
          try: () => {
            const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
            const cursor =
              input.cursor === undefined || input.cursor === null || input.cursor.length === 0
                ? undefined
                : decodeCursor(input.cursor);
            const keyFilter =
              input.keyId === undefined ? undefined : eq(requests.keyId, input.keyId);
            const cursorFilter =
              cursor === undefined
                ? undefined
                : sql`(${requests.startedAt} < ${cursor.left}) OR (${requests.startedAt} = ${cursor.left} AND ${requests.id} < ${cursor.right})`;
            const where = and(
              keyFilter,
              cursorFilter,
              input.since === undefined ? undefined : gte(requests.startedAt, input.since),
              input.until === undefined ? undefined : lte(requests.startedAt, input.until),
              input.priority === undefined ? undefined : eq(requests.priority, input.priority),
              input.deploymentId === undefined
                ? undefined
                : eq(requests.deploymentId, input.deploymentId),
            );
            const rows = (
              where === undefined
                ? db
                    .select()
                    .from(requests)
                    .orderBy(desc(requests.startedAt), desc(requests.id))
                    .limit(limit + 1)
                : db
                    .select()
                    .from(requests)
                    .where(where)
                    .orderBy(desc(requests.startedAt), desc(requests.id))
                    .limit(limit + 1)
            ).all();
            const page = rows.slice(0, limit);
            const last = page[page.length - 1];
            const items: RecentRequest[] = page.map((row) => ({
              id: row.id,
              keyId: row.keyId,
              startedAt: row.startedAt,
              finishedAt: row.finishedAt,
              status: row.status as RecentRequest["status"],
              deploymentId: row.deploymentId,
              classifierBackend: row.classifierBackend as ClassifierMode | null,
              modelRevision: row.classifierModelRevision,
              source: row.classifierSource as ClassifierSource | null,
              classifierInputTokens: row.classifierInputTokens,
              classifierElapsedMs: row.classifierElapsedMs,
              reuse: row.classifierReuse as ClassificationReuse | null,
              promptTokens: row.promptTokens,
              completionTokens: row.completionTokens,
              reasoningTokens: row.reasoningTokens,
              cachedInputTokens: row.cachedInputTokens,
              ttftMs: row.ttftMs,
              generationElapsedMs: row.generationElapsedMs,
              providerReportedUsd: row.providerReportedUsd,
              estimatedCostUsd: row.estimatedCostUsd,
              estimatedCacheSavingsUsd: row.estimatedCacheSavingsUsd,
              localComputeEstimatedUsd: row.localComputeEstimatedUsd,
              priceVersion: row.priceVersion,
              trajectoryHash: row.trajectoryHash,
              errorCode: row.errorCode,
              priority: row.priority,
              localityBias: row.localityBias,
              location: row.location,
              transport: row.transport,
              boundary: row.boundary,
              saturation: row.saturation === 1,
              queueWaitMs: row.queueWaitMs,
              decisionReason: row.selectionReasonCode ?? row.decisionReason,
              exclusions:
                row.exclusionJson === null
                  ? []
                  : Schema.decodeUnknownSync(Schema.Array(CandidateExclusion))(
                      JSON.parse(row.exclusionJson),
                    ),
              taskKind: row.taskKind,
              difficulty: row.difficulty,
              requestedEffort: row.requestedEffort,
              decodeTps: row.decodeTps,
              cacheObservation: row.cacheObservation,
              costSource: row.costSource,
              decisionTrace:
                row.decisionTraceJson === null
                  ? null
                  : (JSON.parse(row.decisionTraceJson) as unknown),
            }));
            return {
              items,
              nextCursor:
                rows.length > limit && last !== undefined
                  ? encodeCursor(last.startedAt, last.id)
                  : null,
            };
          },
          catch: mapRepoError,
        });
      });
      const analytics = Effect.fn("KeyRepository.analytics")(function* (
        input: AnalyticsQuery,
        qualifications: readonly ClassifierQualification[],
      ) {
        return yield* Effect.try({
          try: () => queryAnalyticsSnapshot(db, input, qualifications),
          catch: mapRepoError,
        });
      });

      return KeyRepository.of({
        createKey,
        getKey,
        listKeys,
        updateKey,
        revokeKey,
        rotateKey,
        admit,
        admitByKeyId,
        attach,
        defer,
        recheckDeferred,
        finalizeDeferred,
        finalizeInterrupted,
        authenticate,
        recheck,
        finalize,
        usageSummary,
        recentRequests,
        analytics,
      });
    }),
  );
