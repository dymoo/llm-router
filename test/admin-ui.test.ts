import assert from "node:assert/strict";
import test from "node:test";
import {
  decodePublicKey,
  decodeRoutingRow,
  decodeUsage,
  updateKey,
} from "../components/admin/api.ts";
import { policySummary } from "../components/admin/explain.ts";
import { filterLoadedKeys } from "../components/admin/filter.ts";
import { resolveStaleEdit, validatePolicy } from "../components/admin/policy.ts";
import type { KeyPolicy, PublicKey } from "../components/admin/types.ts";
import { formatUsd } from "../components/admin/format.ts";

const policy: KeyPolicy = {
  priority: "medium",
  cloud: false,
  requestsPerMinute: 60,
  maxConcurrent: 2,
};

function sampleKey(overrides: Partial<PublicKey> = {}): PublicKey {
  return {
    id: "key-1",
    prefix: "jrv_aaaaaaaaaaaaaaaaaaaaaaaa",
    name: "Agent",
    policy,
    createdAt: 1,
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
    version: 1,
    requestCount: 0,
    runningCount: 0,
    successCount: 0,
    errorCount: 0,
    ...overrides,
  };
}

test("filterLoadedKeys only searches the supplied page", () => {
  const loaded = [
    sampleKey({ id: "a", name: "Dylan laptop", prefix: "jrv_aaa" }),
    sampleKey({ id: "b", name: "Vibecode", prefix: "jrv_bbb" }),
  ];
  const found = filterLoadedKeys(loaded, "dylan");
  assert.deepEqual(
    found.map((key) => key.id),
    ["a"],
  );
  assert.equal(filterLoadedKeys(loaded, "missing").length, 0);
});

test("stale edit keeps the draft and takes the latest version", () => {
  const draft = {
    name: "My draft",
    expiresAt: null,
    policy: { ...policy, cloud: true },
  };
  const latest = sampleKey({ version: 4, name: "Server name" });
  const resolved = resolveStaleEdit(draft, latest);
  assert.equal(resolved.missing, false);
  assert.equal(resolved.expectedVersion, 4);
  assert.equal(resolved.draft.name, "My draft");
  assert.equal(resolved.draft.policy.cloud, true);
});

test("public key decode never keeps a secret field", () => {
  const decoded = decodePublicKey({
    id: "key-1",
    prefix: "jrv_aaaaaaaaaaaaaaaaaaaaaaaa",
    name: "Agent",
    policy,
    createdAt: 1,
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
    version: 3,
    requestCount: 2,
    secret: "jrv_aaaaaaaaaaaaaaaaaaaaaaaa.should-not-leak",
    digest: "nope",
  });
  assert.equal(decoded.version, 3);
  assert.equal("secret" in decoded, false);
  assert.equal("digest" in decoded, false);
});

test("key writes send exactly the four policy fields", async () => {
  const bodies: unknown[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ key: sampleKey({ version: 2 }) }), { status: 200 });
  };
  try {
    const stray = { ...policy, localityBias: 0.5 } as KeyPolicy;
    await updateKey("key-1", 1, { name: "  Agent  ", expiresAt: null, policy: stray });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(bodies, [
    {
      expectedVersion: 1,
      name: "Agent",
      expiresAt: null,
      policy: { priority: "medium", cloud: false, requestsPerMinute: 60, maxConcurrent: 2 },
    },
  ]);
});

test("policy decode requires the cloud switch", () => {
  const { cloud: _omitted, ...legacy } = policy;
  assert.throws(() => decodePublicKey({ ...sampleKey(), policy: legacy }));
  assert.equal(decodePublicKey({ ...sampleKey(), policy }).policy.cloud, false);
});

test("low priority summarises as GPU only whatever the cloud switch says", () => {
  assert.equal(policySummary({ ...policy, priority: "high", cloud: true }), "High · cloud on");
  assert.equal(policySummary({ ...policy, priority: "medium", cloud: false }), "Medium · GPU only");
  assert.equal(policySummary({ ...policy, priority: "low", cloud: true }), "Low · GPU only");
});

test("request rows keep the optional app title and URL", () => {
  const row = decodeRoutingRow({
    id: "r1",
    startedAt: 1,
    appTitle: "Open WebUI",
    appUrl: "https://chat.example",
  });
  assert.equal(row?.appTitle, "Open WebUI");
  assert.equal(row?.appUrl, "https://chat.example");
  assert.equal(decodeRoutingRow({ id: "r2", startedAt: 1 })?.appUrl, null);
});

test("usage decode keeps unknown tokens and cost as null", () => {
  const usage = decodeUsage({
    window: {
      requests: 4,
      httpSuccess: 3,
      errors: 1,
      providerReportedUsd: 0,
      estimatedCostUsd: 0.02,
      localComputeEstimatedUsd: 0.11,
    },
    recent: [],
  });
  assert.equal(usage.available, true);
  assert.equal(usage.aggregates.requestCount, 4);
  assert.equal(usage.aggregates.promptTokens, null);
  assert.equal(usage.aggregates.actualUsd, 0);
  assert.equal(usage.aggregates.estimatedUsd, 0.02);
  assert.equal(usage.aggregates.localComputeUsd, 0.11);
  assert.deepEqual(usage.series, []);
  assert.deepEqual(usage.errors, []);
  assert.equal(usage.breakdowns.byKey.length, 0);
});

test("abuse limits must be whole numbers at or above zero", () => {
  assert.equal(validatePolicy({ ...policy, requestsPerMinute: 0, maxConcurrent: 0 }), null);
  assert.notEqual(validatePolicy({ ...policy, requestsPerMinute: -1 }), null);
  assert.notEqual(validatePolicy({ ...policy, maxConcurrent: 1.5 }), null);
});

test("nonzero micro-costs and unknown costs are not displayed as zero", () => {
  assert.notEqual(formatUsd(0.0000042), formatUsd(0));
  assert.notEqual(formatUsd(0.0000000001), formatUsd(0));
  assert.notEqual(formatUsd(null), formatUsd(0));
});
