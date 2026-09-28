import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect, Layer, ManagedRuntime } from "effect";
import {
  ASSESSMENT_QUESTION_SCHEMA_VERSION,
  AnalyticsSnapshot,
  POLICY_SUGGESTIONS,
  type ClassifierQualification,
} from "../../src/domain.ts";
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
        const analytics = yield* keys.analytics({ since, until }, []);
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
        // Laya row has no rates record: unknown, while exact-cache spend is a real zero.
        assert.equal(analytics.window.classifierEstimatedUsd, 0);
        assert.equal(analytics.window.classifierCostUnknownCount, 1);
        assert.equal(analytics.window.p50QueueWaitMs, 20);
        assert.equal(analytics.window.p95QueueWaitMs, 40);
        assert.equal(analytics.exclusions.quality, 1);
        assert.equal(analytics.errors.ProviderFailure, 1);
        assert.equal(
          analytics.series.reduce((n, item) => n + item.requests, 0),
          3,
        );
        const filtered = yield* keys.analytics(
          {
            since,
            until,
            keyId: cloud.key.id,
            priority: "high",
            deploymentId: "cloud",
          },
          [],
        );
        assert.equal(filtered.window.requests, 1);
        assert.equal(filtered.window.localComputeEstimatedUsd, null);
        assert.equal(filtered.window.classifierEstimatedUsd, 0);
        assert.equal(filtered.window.classifierCostUnknownCount, 0);
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

const ratesRecord = (
  inputUsdPerMillion: number | null,
  outputUsdPerMillion: number | null,
): ClassifierQualification => ({
  backend: "jev",
  modelRevision: "jev-1.13.0",
  questionSchemaVersion: ASSESSMENT_QUESTION_SCHEMA_VERSION,
  calibration: {
    evaluationSet: {
      id: "synthetic-analytics-fixture",
      cases: 10,
      labelsSource: "synthetic test fixture",
      asOf: "2026-09-01",
    },
    measuredAt: "2026-09-01",
    method: "synthetic test fixture",
    metrics: {},
    thresholds: {},
    verdict: "pass",
  },
  rates: {
    inputUsdPerMillion,
    outputUsdPerMillion,
    provenance: {
      unit: "USD per 1M input tokens",
      source: "operator rate card",
      asOf: "2026-09-22",
    },
  },
});

/** Real repository path: temp SQLite, one key, finalize each row, then query analytics. */
async function snapshotFor(
  rows: readonly FinalizeOutcome[],
  qualifications: readonly ClassifierQualification[],
): Promise<AnalyticsSnapshot> {
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
        const snapshot = yield* keys.analytics({ since, until: Date.now() }, qualifications);
        Schema.decodeUnknownSync(AnalyticsSnapshot)(snapshot);
        return snapshot;
      }),
    );
  } finally {
    await runtime.dispose();
    await rm(dir, { recursive: true, force: true });
  }
}

test("classifier spend prices from the qualification record and reuse groups are real zero", async () => {
  const snapshot = await snapshotFor(
    [
      {
        status: "success",
        classifierBackend: "jev",
        modelRevision: "jev-1.13.0",
        reuse: "classified",
        classifierInputTokens: 2_000_000,
      },
      { status: "success", reuse: "exact-cache", classifierInputTokens: 0 },
      { status: "success", reuse: "session", classifierInputTokens: null },
    ],
    [ratesRecord(0.042, 0)],
  );
  assert.equal(snapshot.window.classifierEstimatedUsd, (2_000_000 * 0.042) / 1_000_000);
  assert.equal(snapshot.window.classifierCostUnknownCount, 0);
  assert.equal(snapshot.window.classifiedFresh, 1);
  assert.equal(snapshot.window.classifierExactCacheHits, 1);
  assert.equal(snapshot.window.sessionReuse, 1);
});

test("classified rows without input tokens are counted unknown, never zero", async () => {
  const snapshot = await snapshotFor(
    [
      {
        status: "success",
        classifierBackend: "jev",
        modelRevision: "jev-1.13.0",
        reuse: "classified",
        classifierInputTokens: null,
      },
    ],
    [ratesRecord(0.042, 0)],
  );
  assert.equal(snapshot.window.classifierEstimatedUsd, null);
  assert.equal(snapshot.window.classifierCostUnknownCount, 1);
  assert.equal(snapshot.window.classifiedFresh, 1);
});

test("an unknown backend or model revision is counted unknown, never silently dropped", async () => {
  const snapshot = await snapshotFor(
    [
      {
        status: "success",
        classifierBackend: "jev",
        modelRevision: "jev-9.9.9",
        reuse: "classified",
        classifierInputTokens: 500,
      },
      {
        status: "success",
        classifierBackend: null,
        modelRevision: null,
        reuse: "classified",
        classifierInputTokens: 500,
      },
    ],
    [ratesRecord(0.042, 0)],
  );
  assert.equal(snapshot.window.classifierEstimatedUsd, null);
  assert.equal(snapshot.window.classifierCostUnknownCount, 2);
  assert.equal(snapshot.window.classifiedFresh, 2);
});

test("fresh spend without a rates record is unknown, never a priced estimate", async () => {
  const snapshot = await snapshotFor(
    [
      {
        status: "success",
        classifierBackend: "jev",
        modelRevision: "jev-1.13.0",
        reuse: "classified",
        classifierInputTokens: 2_000_000,
      },
    ],
    [],
  );
  assert.equal(snapshot.window.classifierEstimatedUsd, null);
  assert.equal(snapshot.window.classifierCostUnknownCount, 1);
});

test("an explicit zero rate with zero tokens reports a real zero", async () => {
  const snapshot = await snapshotFor(
    [
      {
        status: "success",
        classifierBackend: "jev",
        modelRevision: "jev-1.13.0",
        reuse: "classified",
        classifierInputTokens: 0,
      },
    ],
    [ratesRecord(0, 0)],
  );
  assert.equal(snapshot.window.classifierEstimatedUsd, 0);
  assert.equal(snapshot.window.classifierCostUnknownCount, 0);
});

test("zero input tokens cannot price an unmeasured output with a nonzero or unknown rate", async () => {
  for (const outputRate of [0.042, null]) {
    const snapshot = await snapshotFor(
      [
        {
          status: "success",
          classifierBackend: "jev",
          modelRevision: "jev-1.13.0",
          reuse: "classified",
          classifierInputTokens: 0,
        },
      ],
      [ratesRecord(0.042, outputRate)],
    );
    assert.equal(snapshot.window.classifierEstimatedUsd, null);
    assert.equal(snapshot.window.classifierCostUnknownCount, 1);
  }
});

test("mixed known and unknown spend reports the priced partial sum plus the unknown count in every dimension", async () => {
  const expected = (1_000_000 * 0.042) / 1_000_000;
  const snapshot = await snapshotFor(
    [
      {
        status: "success",
        deploymentId: "d-priced",
        classifierBackend: "jev",
        modelRevision: "jev-1.13.0",
        reuse: "classified",
        classifierInputTokens: 1_000_000,
        taskKind: "coding",
        difficulty: "hard",
        requestedEffort: "high",
        selectionReasonCode: "local-preference",
      },
      {
        status: "success",
        deploymentId: "d-unknown",
        classifierBackend: "jev",
        modelRevision: "jev-1.13.0",
        reuse: "classified",
        classifierInputTokens: null,
        taskKind: "coding",
        difficulty: "easy",
        requestedEffort: "low",
        selectionReasonCode: "cloud-quality",
      },
      {
        status: "success",
        deploymentId: "d-cache",
        reuse: "exact-cache",
        classifierInputTokens: 0,
      },
      {
        status: "success",
        deploymentId: "d-session",
        reuse: "session",
        classifierInputTokens: null,
      },
    ],
    [ratesRecord(0.042, 0)],
  );

  const window = snapshot.window;
  assert.equal(window.classifierEstimatedUsd, expected);
  assert.equal(window.classifierCostUnknownCount, 1);
  assert.equal(window.classifiedFresh, 2);
  assert.equal(window.classifierExactCacheHits, 1);
  assert.equal(window.sessionReuse, 1);

  const onlyKey = Object.values(snapshot.byKeyId)[0];
  assert.equal(onlyKey?.classifierEstimatedUsd, expected);
  assert.equal(onlyKey?.classifierCostUnknownCount, 1);
  assert.equal(snapshot.byPriority.high.classifierEstimatedUsd, expected);
  assert.equal(snapshot.byPriority.high.classifierCostUnknownCount, 1);
  assert.equal(snapshot.byPriority.low.classifierEstimatedUsd, null);
  assert.equal(snapshot.byPriority.low.classifierCostUnknownCount, 0);
  assert.equal(snapshot.byDeploymentId["d-priced"]?.classifierEstimatedUsd, expected);
  assert.equal(snapshot.byDeploymentId["d-priced"]?.classifierCostUnknownCount, 0);
  assert.equal(snapshot.byDeploymentId["d-unknown"]?.classifierEstimatedUsd, null);
  assert.equal(snapshot.byDeploymentId["d-unknown"]?.classifierCostUnknownCount, 1);
  assert.equal(snapshot.byDeploymentId["d-cache"]?.classifierEstimatedUsd, 0);
  assert.equal(snapshot.byDeploymentId["d-cache"]?.classifierCostUnknownCount, 0);
  assert.equal(snapshot.byTask["coding"]?.classifierEstimatedUsd, expected);
  assert.equal(snapshot.byTask["coding"]?.classifierCostUnknownCount, 1);
  assert.equal(snapshot.byDifficulty["hard"]?.classifierEstimatedUsd, expected);
  assert.equal(snapshot.byDifficulty["hard"]?.classifierCostUnknownCount, 0);
  assert.equal(snapshot.byEffort["high"]?.classifierEstimatedUsd, expected);
  assert.equal(snapshot.byEffort["high"]?.classifierCostUnknownCount, 0);
  assert.equal(snapshot.bySelectionCode["local-preference"]?.classifierEstimatedUsd, expected);
  assert.equal(snapshot.bySelectionCode["local-preference"]?.classifierCostUnknownCount, 0);

  const seriesUsd = snapshot.series.reduce((n, b) => n + (b.classifierEstimatedUsd ?? 0), 0);
  const seriesUnknown = snapshot.series.reduce((n, b) => n + b.classifierCostUnknownCount, 0);
  assert.equal(seriesUnknown, 1);
  assert.ok(Math.abs(seriesUsd - expected) < 1e-12);
});

test("analytics keeps overload reasons distinct without reclassifying historic decisions", async () => {
  const snapshot = await snapshotFor(
    [
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
    ],
    [],
  );
  assert.equal(snapshot.window.requests, 4);
  assert.equal(snapshot.bySelectionCode["local-overload-failover"]?.requests, 1);
  assert.equal(snapshot.bySelectionCode["local-overloaded"]?.requests, 1);
  assert.equal(snapshot.bySelectionCode["cloud-quality"]?.requests, 1);
  assert.equal(snapshot.bySelectionCode["failed-precheck"]?.requests, 1);
  assert.equal(snapshot.errors.LocalOverloaded, 1);
});
