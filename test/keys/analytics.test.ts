import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect, Layer, ManagedRuntime } from "effect";
import { AnalyticsSnapshot, POLICY_SUGGESTIONS } from "../../src/domain.ts";
import type { FinalizeOutcome } from "../../src/keys/types.ts";
import { Schema } from "effect";
import { sqliteDatabaseLayer } from "../../src/db/sqlite.ts";
import { ApiKeys, apiKeysLayer } from "../../src/keys/api-keys.ts";
import { keyRepositoryLayer } from "../../src/keys/repository.ts";
import { decodeRequestPage, decodeUsage } from "../../components/admin/api.ts";

test("SQLite analytics separates actual costs, local COGS, unknown usage, reuse and decisions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hub-analytics-"));
  const runtime = ManagedRuntime.make(
    apiKeysLayer.pipe(
      Layer.provideMerge(keyRepositoryLayer({ pepper: "test-pepper" })),
      Layer.provide(sqliteDatabaseLayer(join(dir, "control.sqlite"))),
    ),
  );
  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        const keys = yield* ApiKeys;
        const since = Date.now() - 1;
        const local = yield* keys.createKey({
          name: "local",
          expiresAt: null,
          policy: POLICY_SUGGESTIONS.Background,
        });
        const cloud = yield* keys.createKey({
          name: "cloud",
          expiresAt: null,
          policy: POLICY_SUGGESTIONS.Interactive,
        });
        const first = yield* keys.admit(local.secret);
        yield* keys.finalize(first, {
          status: "success",
          deploymentId: "local",
          location: "local",
          promptTokens: 100,
          completionTokens: 20,
          cachedInputTokens: 40,
          reasoningTokens: 10,
          localComputeEstimatedUsd: 0.002,
          estimatedCostUsd: 0.002,
          estimatedCacheSavingsUsd: 0.001,
          classifierBackend: "laya",
          reuse: "classified",
          classifierInputTokens: 80,
          queueWaitMs: 20,
          ttftMs: 50,
          generationElapsedMs: 200,
          decodeTps: 100,
          taskKind: "coding",
          difficulty: "moderate",
          requestedEffort: "high",
          selectionReasonCode: "local-preference",
          decisionTraceJson: JSON.stringify({
            keyPolicyVersion: 1,
            catalogueVersion: "v1",
            assessment: { appliedEffort: "high" },
          }),
          exclusionJson: JSON.stringify([
            { deploymentId: "cloud", code: "quality", detail: "Below floor" },
          ]),
          appUrl: "https://vibe.example",
          appTitle: "Free Vibecode",
        });
        const second = yield* keys.admit(cloud.secret);
        yield* keys.finalize(second, {
          status: "success",
          deploymentId: "cloud",
          location: "cloud",
          promptTokens: 200,
          completionTokens: 30,
          providerReportedUsd: 0.005,
          estimatedCostUsd: 0.006,
          cachedInputTokens: 0,
          reuse: "exact-cache",
          classifierInputTokens: 0,
          queueWaitMs: 40,
          ttftMs: 90,
          decodeTps: 50,
        });
        const third = yield* keys.admit(local.secret);
        yield* keys.finalize(third, {
          status: "error",
          deploymentId: "local",
          location: "local",
          errorCode: "ProviderFailure",
        });
        const until = Date.now();
        const analytics = yield* keys.analytics({ since, until });
        Schema.decodeUnknownSync(AnalyticsSnapshot)(analytics);
        assert.equal(analytics.window.requests, 3);
        assert.equal(analytics.window.providerReportedUsd, 0.005);
        assert.equal(analytics.window.localComputeEstimatedUsd, 0.002);
        assert.equal(analytics.window.unknownCostCount, 1);
        assert.equal(analytics.window.unknownUsageCount, 1);
        assert.equal(analytics.window.cachedInputTokens, 40);
        assert.equal(analytics.window.cacheHitRequests, 1);
        assert.equal(analytics.window.classifierInputTokens, 80);
        assert.equal(analytics.window.classifierExactCacheHits, 1);
        // Historical classifier rows still count; there is no classifier spend to price.
        assert.equal(analytics.window.classifierEstimatedUsd, null);
        assert.equal(analytics.window.classifierCostUnknownCount, 0);
        assert.equal(analytics.window.p50QueueWaitMs, 20);
        assert.equal(analytics.window.p95QueueWaitMs, 40);
        assert.equal(analytics.exclusions.quality, 1);
        assert.equal(analytics.errors.ProviderFailure, 1);
        assert.equal(
          analytics.series.reduce((n, item) => n + item.requests, 0),
          3,
        );
        const filtered = yield* keys.analytics({
          since,
          until,
          keyId: cloud.key.id,
          priority: "high",
          deploymentId: "cloud",
        });
        assert.equal(filtered.window.requests, 1);
        assert.equal(filtered.window.localComputeEstimatedUsd, null);
        assert.equal(filtered.window.classifierEstimatedUsd, null);
        const recent = yield* keys.recentRequests({ keyId: local.key.id, since, until, limit: 1 });
        assert.equal(recent.items.length, 1);
        assert.ok(recent.nextCursor);
        const next = yield* keys.recentRequests({
          keyId: local.key.id,
          since,
          until,
          limit: 1,
          cursor: recent.nextCursor,
        });
        assert.notEqual(next.items[0]?.id, recent.items[0]?.id);
        const ui = decodeUsage(analytics);
        assert.equal(ui.aggregates.requestCount, 3);
        const rows = decodeRequestPage(yield* keys.recentRequests({ since, until, limit: 10 }));
        assert.equal(rows.items.length, 3);
        assert.equal(rows.items.find((item) => item.id === first.requestId)?.appliedEffort, "high");
        const firstRow = rows.items.find((item) => item.id === first.requestId);
        assert.equal(firstRow?.appTitle, "Free Vibecode");
        assert.equal(firstRow?.appUrl, "https://vibe.example");
        assert.equal(rows.items.find((item) => item.id === second.requestId)?.appUrl, null);
      }),
    );
  } finally {
    await runtime.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

/** Real repository path: temp SQLite, one key, finalize each row, then query analytics. */
async function snapshotFor(rows: readonly FinalizeOutcome[]): Promise<AnalyticsSnapshot> {
  const dir = await mkdtemp(join(tmpdir(), "hub-analytics-"));
  const runtime = ManagedRuntime.make(
    apiKeysLayer.pipe(
      Layer.provideMerge(keyRepositoryLayer({ pepper: "test-pepper" })),
      Layer.provide(sqliteDatabaseLayer(join(dir, "control.sqlite"))),
    ),
  );
  try {
    return await runtime.runPromise(
      Effect.gen(function* () {
        const keys = yield* ApiKeys;
        const since = Date.now() - 1;
        const created = yield* keys.createKey({
          name: "accounting",
          expiresAt: null,
          policy: POLICY_SUGGESTIONS.Interactive,
        });
        for (const outcome of rows) {
          const lease = yield* keys.admit(created.secret);
          yield* keys.finalize(lease, outcome);
        }
        const snapshot = yield* keys.analytics({ since, until: Date.now() });
        Schema.decodeUnknownSync(AnalyticsSnapshot)(snapshot);
        return snapshot;
      }),
    );
  } finally {
    await runtime.dispose();
    await rm(dir, { recursive: true, force: true });
  }
}

test("analytics keeps overload reasons distinct without reclassifying historic decisions", async () => {
  const snapshot = await snapshotFor([
    {
      status: "success",
      deploymentId: "cloud",
      location: "cloud",
      decisionReason: "local-overload-failover",
      selectionReasonCode: "local-overload-failover",
    },
    {
      status: "error",
      deploymentId: "local",
      location: "local",
      errorCode: "LocalOverloaded",
      decisionReason: "local-overloaded",
      selectionReasonCode: "local-overloaded",
    },
    {
      status: "success",
      deploymentId: "historic-cloud",
      location: "cloud",
      decisionReason: "cloud-quality",
      selectionReasonCode: "cloud-quality",
    },
    {
      status: "error",
      deploymentId: "historic-local",
      location: "local",
      decisionReason: "failed-precheck",
      selectionReasonCode: "failed-precheck",
    },
  ]);
  assert.equal(snapshot.window.requests, 4);
  assert.equal(snapshot.bySelectionCode["local-overload-failover"]?.requests, 1);
  assert.equal(snapshot.bySelectionCode["local-overloaded"]?.requests, 1);
  assert.equal(snapshot.bySelectionCode["cloud-quality"]?.requests, 1);
  assert.equal(snapshot.bySelectionCode["failed-precheck"]?.requests, 1);
  assert.equal(snapshot.errors.LocalOverloaded, 1);
});
