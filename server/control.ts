import "server-only";

import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect";
import { getEnv } from "../env.ts";
import { sqliteDatabaseLayer } from "../src/db/index.ts";
import { AuthFailed, DatabaseError } from "../src/errors.ts";
import type { AdminDeps, KeyService, PublicKey } from "../src/http/contracts.ts";
import { ApiKeys, apiKeysLayer, keyRepositoryLayer, type Admission } from "../src/keys/index.ts";
import type { ListedKey } from "../src/keys/types.ts";
import { assertAcceptingWork } from "./lifecycle.ts";
import { loadClassifierQualifications } from "./qualification.ts";
import { processState } from "./state.ts";

function makeControlRuntime() {
  const env = getEnv();
  const repository = keyRepositoryLayer({ pepper: env.API_KEY_PEPPER }).pipe(
    Layer.provide(sqliteDatabaseLayer(env.SQLITE_PATH)),
  );
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
export const pendingAdmissions = (): number => leases.size + processState.admissionsStarting;

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
      return admission;
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
      leases.delete(admission.requestId);
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

export function getAdminDeps(): AdminDeps {
  const env = getEnv();
  return {
    appOrigin: env.APP_ORIGIN,
    basicAuth: env.ADMIN_BASIC_AUTH,
    classifierQualifications: loadClassifierQualifications(),
    keys,
  };
}

export async function disposeControlPlane(): Promise<void> {
  if (processState.control === undefined) return;
  await processState.control.dispose();
  processState.control = undefined;
}
