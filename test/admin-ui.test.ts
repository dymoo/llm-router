import assert from "node:assert/strict";
import test from "node:test";
import { decodePublicKey, decodeUsage } from "../components/admin/api.ts";
import { filterLoadedKeys } from "../components/admin/filter.ts";
import { resolveStaleEdit, validatePolicy } from "../components/admin/policy.ts";
import type { KeyPolicy, PublicKey } from "../components/admin/types.ts";
import { formatUsd } from "../components/admin/format.ts";

const policy: KeyPolicy = {
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
    policy: { ...policy, localityBias: 0.2 },
  };
  const latest = sampleKey({ version: 4, name: "Server name" });
  const resolved = resolveStaleEdit(draft, latest);
  assert.equal(resolved.missing, false);
  assert.equal(resolved.expectedVersion, 4);
  assert.equal(resolved.draft.name, "My draft");
  assert.equal(resolved.draft.policy.localityBias, 0.2);
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
  assert.deepEqual(usage.decisions, []);
  assert.deepEqual(usage.exclusions, []);
  assert.equal(usage.breakdowns.byKey.length, 0);
});

test("all-zero ranking bias is invalid", () => {
  const invalid = validatePolicy({
    ...policy,
    bias: { cost: 0, quality: 0, latency: 0 },
  });
  assert.notEqual(invalid, null);
});

test("nonzero micro-costs and unknown costs are not displayed as zero", () => {
  assert.notEqual(formatUsd(0.0000042), formatUsd(0));
  assert.notEqual(formatUsd(0.0000000001), formatUsd(0));
  assert.notEqual(formatUsd(null), formatUsd(0));
});
