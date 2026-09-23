import type {
  AdminDeps,
  InferenceDeps,
  KeyPolicy,
  KeyService,
  PublicKey,
} from "../../src/http/contracts.ts";
import { createStatusStore } from "../../src/http/status.ts";

export const ORIGIN = "http://127.0.0.1:3100";

export function samplePolicy(overrides?: Partial<KeyPolicy>): KeyPolicy {
  return {
    priority: "medium",
    localityBias: 0.65,
    contextLimitTokens: 65_536,
    maxCompletionTokens: 8_192,
    allowedModels: null,
    requestsPerMinute: 60,
    maxConcurrent: 2,
    maxWaitMs: 0,
    maxEstimatedUsd: null,
    bias: { cost: 0.7, quality: 0.5, latency: 0.3 },
    ...overrides,
  };
}

export function sampleKey(overrides?: Partial<PublicKey>): PublicKey {
  return {
    id: "key-1",
    prefix: "jrv_aaaaaaaaaaaaaaaaaaaaaaaa",
    name: "test",
    policy: samplePolicy(),
    createdAt: 1,
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
    version: 1,
    requestCount: 0,
    runningCount: 0,
    successCount: 0,
    errorCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    ...overrides,
  };
}

export type MemoryKeys = KeyService & { admits: number; finalizes: FinalizeSpy[] };

export function memoryKeys(options?: { secret?: string }): MemoryKeys {
  const items: PublicKey[] = [];
  const admits = { count: 0 };
  const finalizes: FinalizeSpy[] = [];
  const service: MemoryKeys = {
    get admits() {
      return admits.count;
    },
    finalizes,
    listKeys: async () => ({ items, nextCursor: null }),
    createKey: async (input) => {
      const key = sampleKey({ name: input.name, policy: input.policy, expiresAt: input.expiresAt });
      items.push(key);
      return {
        key,
        secret:
          options?.secret ??
          "jrv_aaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      };
    },
    updateKey: async (id, input) => {
      const current = items.find((item) => item.id === id);
      if (current === undefined) {
        throw Object.assign(new Error("missing"), { _tag: "KeyNotFound" });
      }
      if (current.version !== input.expectedVersion) {
        throw Object.assign(new Error("stale"), { _tag: "StaleVersion" });
      }
      const next = {
        ...current,
        name: input.name,
        policy: input.policy,
        expiresAt: input.expiresAt,
        version: current.version + 1,
      };
      items.splice(items.indexOf(current), 1, next);
      return next;
    },
    revokeKey: async (id) => {
      const current = items.find((item) => item.id === id);
      if (current !== undefined) {
        current.revokedAt = Date.now();
      }
    },
    rotateKey: async (id, expectedVersion) => {
      const current = items.find((item) => item.id === id);
      if (current === undefined) {
        throw Object.assign(new Error("missing"), { _tag: "KeyNotFound" });
      }
      if (current.version !== expectedVersion) {
        throw Object.assign(new Error("stale"), { _tag: "StaleVersion" });
      }
      return {
        key: { ...current, version: current.version + 1 },
        secret: "jrv_cccccccccccccccccccccccc.ddddddddddddddddddddddddddddddddddddddddddd",
      };
    },
    admit: async () => {
      admits.count += 1;
      return {
        requestId: "req-1",
        keyId: "key-1",
        prefix: "jrv_aaaaaaaaaaaaaaaaaaaaaaaa",
        name: "test",
        policy: samplePolicy(),
        version: 1,
        leaseExpiresAt: Date.now() + 12 * 60 * 1000,
        admittedAt: Date.now(),
      };
    },
    recheck: async (admission) => admission,
    finalize: async (_admission, outcome) => {
      finalizes.push(outcome);
    },
    authenticate: async () => ({ keyId: "key-1", policy: samplePolicy() }),
    usageSummary: async () => ({
      requestCount: 0,
      runningCount: 0,
      successCount: 0,
      errorCount: 0,
      abandonedCount: 0,
      promptTokens: null,
      completionTokens: null,
      estimatedCostUsd: null,
      providerReportedUsd: null,
      localComputeEstimatedUsd: null,
      missingUsageCount: 0,
      missingCostCount: 0,
      zeroApiPriceMissingLocalCogsCount: 0,
    }),
    recentRequests: async () => ({ items: [], nextCursor: null }),
    analytics: async () => {
      throw Object.assign(new Error("analytics not used in unit tests"), { _tag: "InvalidInput" });
    },
  };
  return service;
}

export type FinalizeSpy = Parameters<KeyService["finalize"]>[1];

export function adminDeps(
  keys: KeyService,
  basicAuth?: { username: string; password: string },
): AdminDeps {
  return { appOrigin: ORIGIN, keys, basicAuth, classifierQualifications: [] };
}

export function inferenceDeps(keys: KeyService, gateway: InferenceDeps["gateway"]): InferenceDeps {
  return { keys, gateway, status: createStatusStore() };
}

export function jsonRequest(url: string, init: RequestInit & { json?: unknown }): Request {
  const headers = new Headers(init.headers);
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
  }
  return new Request(url, {
    ...init,
    headers,
    body: init.json === undefined ? init.body : JSON.stringify(init.json),
  });
}
