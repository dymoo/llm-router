import "server-only";

import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect";
import { getEnv } from "../env.ts";
import { sqliteDatabaseLayer } from "../src/db/index.ts";
import { AuthFailed, DatabaseError } from "../src/errors.ts";
import type { AdminDeps, KeyService, PublicKey } from "../src/http/contracts.ts";
import { ApiKeys, apiKeysLayer, keyRepositoryLayer, type Admission } from "../src/keys/index.ts";
import type { FinalizeOutcome, ListedKey } from "../src/keys/types.ts";
import { assertAcceptingWork } from "./lifecycle.ts";
import { loadClassifierQualifications } from "./qualification.ts";
import { processState } from "./state.ts";
import {
  observeAdmission,
  observeAdmissionFailure,
  observeFinalized,
  observeInFlight,
} from "./metrics.ts";

function makeControlRuntime() {
  const env = getEnv();
  const repository = keyRepositoryLayer({
    pepper: env.API_KEY_PEPPER,
    onFinalized: observeFinalized,
  }).pipe(Layer.provide(sqliteDatabaseLayer(env.SQLITE_PATH)));
  return ManagedRuntime.make(apiKeysLayer.pipe(Layer.provideMerge(repository)));
}

function getControlRuntime() {
  if (processState.control === undefined) {
    processState.control = makeControlRuntime();
  }
  return processState.control;
}

async function run<A, E>(effect: Effect.Effect<A, E, ApiKeys>): Promise<A> {
  const exit = await getControlRuntime().runPromiseExit(effect);
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  throw Cause.squash(exit.cause);
}

const leases = processState.leases;
/** Process-local item→request correlation used only to clean a stale lease
 * map when interrupted recovery runs in the same process. Durable recovery
 * always relies on batch_items.request_id, not this ephemeral map. */
const batchItemLeases = new Map<string, string>();

function forgetBatchRequest(requestId: string): void {
  if (leases.delete(requestId))
    observeInFlight(processState.batchLeases.has(requestId) ? "batch" : "interactive", -1);
  processState.batchLeases.delete(requestId);
  for (const [itemId, linkedRequestId] of batchItemLeases) {
    if (linkedRequestId === requestId) batchItemLeases.delete(itemId);
  }
}

function flattenKey(listed: ListedKey): PublicKey {
  return {
    id: listed.id,
    prefix: listed.prefix,
    name: listed.name,
    policy: listed.policy,
    createdAt: listed.createdAt,
    expiresAt: listed.expiresAt,
    revokedAt: listed.revokedAt,
    lastUsedAt: listed.lastUsedAt,
    version: listed.version,
    requestCount: listed.usage.requestCount,
    runningCount: listed.usage.runningCount,
    successCount: listed.usage.successCount,
    errorCount: listed.usage.errorCount,
    promptTokens: listed.usage.promptTokens,
    completionTokens: listed.usage.completionTokens,
  };
}

function emptyUsage(): ListedKey["usage"] {
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

export const keys: KeyService = {
  listKeys: async (query) => {
    const page = await run(
      ApiKeys.use((api) => api.listKeys({ cursor: query.cursor, limit: query.limit })),
    );
    return { items: page.items.map(flattenKey), nextCursor: page.nextCursor };
  },
  createKey: async (input) => {
    const created = await run(ApiKeys.use((api) => api.createKey(input)));
    return { key: flattenKey({ ...created.key, usage: emptyUsage() }), secret: created.secret };
  },
  updateKey: async (id, input) => {
    const key = await run(
      ApiKeys.use((api) =>
        api.updateKey({
          id,
          expectedVersion: input.expectedVersion,
          name: input.name,
          expiresAt: input.expiresAt,
          policy: input.policy,
        }),
      ),
    );
    return flattenKey({ ...key, usage: emptyUsage() });
  },
  revokeKey: async (id) => {
    await run(ApiKeys.use((api) => api.revokeKey(id)));
  },
  rotateKey: async (id, expectedVersion) => {
    const rotated = await run(ApiKeys.use((api) => api.rotateKey({ id, expectedVersion })));
    return { key: flattenKey({ ...rotated.key, usage: emptyUsage() }), secret: rotated.secret };
  },
  admit: async (rawKey) => {
    assertAcceptingWork();
    processState.admissionsStarting++;
    try {
      const admission = await run(ApiKeys.use((api) => api.admit(rawKey)));
      leases.set(admission.requestId, admission);
      observeAdmission("admitted");
      observeInFlight("interactive", 1);
      return admission;
    } catch (error) {
      observeAdmissionFailure(error);
      throw error;
    } finally {
      processState.admissionsStarting--;
    }
  },
  recheck: async (admission) => {
    const next = await run(ApiKeys.use((api) => api.recheck(admission)));
    leases.set(next.requestId, next);
    return next;
  },
  finalize: async (admission, outcome) => {
    try {
      await run(ApiKeys.use((api) => api.finalize(admission, outcome)));
    } finally {
      if (leases.delete(admission.requestId)) observeInFlight("interactive", -1);
    }
  },
  authenticate: async (rawKey) => {
    const key = await run(ApiKeys.use((api) => api.authenticate(rawKey)));
    return { keyId: key.id, policy: key.policy };
  },
  usageSummary: (query) => run(ApiKeys.use((api) => api.usageSummary(query))),
  recentRequests: (query) => run(ApiKeys.use((api) => api.recentRequests(query))),
  analytics: (query, qualifications) =>
    run(ApiKeys.use((api) => api.analytics(query, qualifications))),
};

export function leaseFor(requestId: string): Admission | undefined {
  return leases.get(requestId);
}

/** Number of admissions whose request state can still be touched by this process. */
export function pendingAdmissions(): number {
  return processState.leases.size + processState.admissionsStarting;
}

/** Internal batch-only admission surface: same admission transaction/validation as the
 * interactive `admit` (revocation/expiry/rate/concurrency/policy), but addressable by key
 * id because batch clients hand us no raw key. No public route can choose a key id: only
 * the deferred-lane scheduler receives this. Batch admissions are tracked apart from
 * interactive ones so the deferred lane's idle gate never counts its own work. */
export const batchKeys = {
  admitByKeyId: async (keyId: string): Promise<Admission> => {
    processState.admissionsStarting++;
    try {
      const admission = await run(ApiKeys.use((api) => api.admitByKeyId(keyId)));
      leases.set(admission.requestId, admission);
      processState.batchLeases.add(admission.requestId);
      observeAdmission("admitted");
      observeInFlight("batch", 1);
      return admission;
    } catch (error) {
      observeAdmissionFailure(error);
      throw error;
    } finally {
      processState.admissionsStarting--;
    }
  },
  attach: async (admission: Admission, itemId: string): Promise<void> => {
    await run(ApiKeys.use((api) => api.attach(admission, itemId)));
    batchItemLeases.set(itemId, admission.requestId);
  },
  recheck: async (admission: Admission): Promise<Admission> => {
    const next = await run(ApiKeys.use((api) => api.recheck(admission)));
    // `recheck` rejects a deferred row. Consequently this map never regains a
    // request after defer has handed ownership to the durable batch lifecycle.
    leases.set(next.requestId, next);
    return next;
  },
  recheckDeferred: async (admission: Admission): Promise<void> => {
    // Remote handoff owns the durable request after defer; never reinsert it
    // into the process lease map for this last pre-POST check.
    await run(ApiKeys.use((api) => api.recheckDeferred(admission)));
  },
  defer: async (
    admission: Admission,
    itemId: string,
    metadata: Omit<FinalizeOutcome, "status">,
    deadlineAt: number,
  ): Promise<void> => {
    await run(ApiKeys.use((api) => api.defer(admission, itemId, metadata, deadlineAt)));
    if (leases.delete(admission.requestId)) observeInFlight("batch", -1);
    processState.batchLeases.delete(admission.requestId);
  },
  finalize: async (admission: Admission, outcome: FinalizeOutcome): Promise<void> => {
    try {
      await run(ApiKeys.use((api) => api.finalize(admission, outcome)));
    } finally {
      forgetBatchRequest(admission.requestId);
    }
  },
  finalizeDeferred: async (
    keyId: string,
    requestId: string,
    outcome: FinalizeOutcome,
  ): Promise<void> => {
    try {
      await run(ApiKeys.use((api) => api.finalizeDeferred(keyId, requestId, outcome)));
    } finally {
      // Remote requests normally left these maps at defer time; deleting is
      // intentional and makes recovery idempotent if a stale process entry
      // survived the handoff.
      forgetBatchRequest(requestId);
    }
  },
  finalizeInterrupted: async (keyId: string, itemId: string): Promise<void> => {
    await run(ApiKeys.use((api) => api.finalizeInterrupted(keyId, itemId)));
    const requestId = batchItemLeases.get(itemId);
    batchItemLeases.delete(itemId);
    if (requestId !== undefined) forgetBatchRequest(requestId);
  },
};

export const recheckLease = Effect.fn("recheckLease")(function* (requestId: string) {
  const admission = leases.get(requestId);
  if (admission === undefined) {
    return yield* new AuthFailed({ message: "missing admission" });
  }
  const api = yield* Effect.tryPromise({
    try: () => getControlRuntime().runPromise(ApiKeys),
    catch: () => new DatabaseError({ message: "persistence unavailable" }),
  });
  yield* api.recheck(admission);
});

/** The batch HTTP surface authenticates bearers through the ordinary KeyService. */
export const batchKeyService: KeyService = keys;

export function getAdminDeps(): AdminDeps {
  const env = getEnv();
  return {
    appOrigin: env.APP_ORIGIN,
    basicAuth: env.ADMIN_BASIC_AUTH,
    classifierQualifications: env.CLASSIFIER_MODE === "rules" ? [] : loadClassifierQualifications(),
    keys,
  };
}

export async function disposeControlPlane(): Promise<void> {
  if (processState.control === undefined) return;
  await processState.control.dispose();
  processState.control = undefined;
}
