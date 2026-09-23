import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Effect, ManagedRuntime, Schema, type Layer } from "effect";
import {
  RouterClassifier,
  assessmentQuestions,
  type ClassifierHealth,
  type ClassifierLayerOptions,
} from "../src/classifier.ts";
import {
  ASSESSMENT_QUESTION_SCHEMA_VERSION,
  ClassifierQualifications,
  JEV_MODEL_ID,
  evaluateClassifierQualification,
  type Calibration,
  type ClassifierQualification,
  type ClassifyInput,
} from "../src/domain.ts";
import { TypeSafeClient, type TypeSafeClientService } from "@compootor/effective-jev";
import { createServer } from "node:http";
import type { ClassifierUnavailable } from "../src/errors.ts";

const revision = "1c5edc17a7acd8701df6fc341c0d179f1c62c982";

const layaAnswers = {
  task: {
    type: "choice",
    choice: "coding",
    confidence: 0.91,
    probabilities: {
      chat: 0.01,
      coding: 0.91,
      math: 0.02,
      analysis: 0.03,
      writing: 0.01,
      extraction: 0.02,
    },
  },
  difficulty: {
    type: "choice",
    choice: "moderate",
    confidence: 0.8,
    probabilities: { easy: 0.1, moderate: 0.8, hard: 0.1 },
  },
  effort: {
    type: "choice",
    choice: "medium",
    confidence: 0.77,
    probabilities: { low: 0.1, medium: 0.77, high: 0.1, xhigh: 0.03 },
  },
  trivialChat: { type: "noul", noul: 0.01 },
  localSufficiency: { type: "noul", noul: 0.85 },
  freshFacts: { type: "noul", noul: 0.05 },
  expectedLength: {
    type: "choice",
    choice: "medium",
    confidence: 0.7,
    probabilities: { short: 0.15, medium: 0.7, long: 0.15 },
  },
};

const classifyInput: ClassifyInput = {
  state: "Implement a TypeScript deduplication function.",
  localDeployments: [
    {
      id: "local-qwen",
      modelId: "qwen3.8-flash-next",
      contextLimitTokens: 32_768,
      quality: { chat: 0.6, coding: 0.7, math: 0.6, analysis: 0.6, writing: 0.5, extraction: 0.6 },
    },
  ],
  keyId: "key_abc",
  catalogueVersion: "catalog-1",
  source: "full-input",
};

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const healthzBody = {
  ok: true,
  ready: true,
  backend: "laya",
  model_id: "rl_agent",
  model_revision: revision,
  max_len: 512,
  head_budget: 192,
  head_max_len: 192,
  rss_mb: 12,
  oom: false,
  one_model: true,
};

const layaFetch = (overrides?: {
  budgetFits?: boolean;
  decideStatus?: number;
  decideBody?: unknown;
  healthStatus?: number;
  healthBody?: unknown;
}): typeof fetch => {
  const budgetFits = overrides?.budgetFits ?? true;
  return (async (input) => {
    const url = String(input);
    if (url.endsWith("/healthz") || url.endsWith("healthz")) {
      return jsonResponse(overrides?.healthStatus ?? 200, overrides?.healthBody ?? healthzBody);
    }
    if (url.includes("/v1/budget")) {
      return jsonResponse(200, {
        input_tokens: 180,
        max_len: 512,
        head_budget: 192,
        fits: budgetFits,
        worst_state_budget: 512,
      });
    }
    if (url.includes("/v1/decide")) {
      if (overrides?.decideStatus === 413) {
        return jsonResponse(413, {
          error: {
            code: "context_exceeded",
            message: "input exceeds max_len",
            input_tokens: 900,
            max_len: 512,
            head_budget: 192,
          },
        });
      }
      return jsonResponse(
        overrides?.decideStatus ?? 200,
        overrides?.decideBody ?? {
          answers: layaAnswers,
          usage: { input_tokens: 180, output_tokens: 0 },
          backend: "laya",
        },
      );
    }
    return jsonResponse(404, { error: "missing" });
  }) as typeof fetch;
};

const questionIds = Object.keys(assessmentQuestions);

/** A qualification whose calibration passes the gate over every assessment question. */
const qualificationRecord = (
  overrides: {
    backend?: "laya" | "jev";
    modelRevision?: string;
    questionSchemaVersion?: string;
  } = {},
): ClassifierQualification => ({
  backend: overrides.backend ?? "laya",
  modelRevision: overrides.modelRevision ?? revision,
  questionSchemaVersion: overrides.questionSchemaVersion ?? ASSESSMENT_QUESTION_SCHEMA_VERSION,
  calibration: {
    evaluationSet: {
      id: "synthetic-classifier-fixture",
      cases: 10,
      labelsSource: "synthetic test fixture",
      asOf: "2026-09-01",
    },
    measuredAt: "2026-09-02",
    method: "synthetic test fixture",
    metrics: Object.fromEntries(
      questionIds.map(
        (id) => [id, { cases: 10, negativeCases: 5, errors: 0, falsePositives: 0 }] as const,
      ),
    ),
    thresholds: Object.fromEntries(
      questionIds.map((id) => [id, { maxErrorRate: 0.2, maxFalsePositiveRate: 0.1 }] as const),
    ),
    verdict: "pass",
  },
  rates: {
    inputUsdPerMillion: 0.12,
    outputUsdPerMillion: 0,
    provenance: { unit: "per 1M tokens", source: "rate card", asOf: "2026-09-01" },
  },
});

const passingQualifications = (): readonly ClassifierQualification[] => [qualificationRecord()];

const passingJevQualifications = (): readonly ClassifierQualification[] => [
  qualificationRecord({ backend: "jev", modelRevision: JEV_MODEL_ID }),
];

const withCalibration = (
  record: ClassifierQualification,
  calibration: Partial<Calibration>,
): ClassifierQualification => ({
  ...record,
  calibration: { ...record.calibration, ...calibration },
});

const unqualifiedReason = (reason: string, questionId?: string) => (error: unknown) => {
  const failure = error as { _tag?: string; reason?: string; questionId?: string };
  assert.equal(failure._tag, "ClassifierUnqualified");
  assert.equal(failure.reason, reason);
  assert.equal(failure.questionId, questionId);
  return true;
};

/** A fetch that can only fail: a qualified gate must never reach it. */
const gateGuard: typeof fetch = async () => {
  throw new Error("the qualification gate must block the backend call");
};

const runClassify = (
  layer: Layer.Layer<RouterClassifier, ClassifierUnavailable>,
  input: ClassifyInput = classifyInput,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const classifier = yield* RouterClassifier;
      return yield* classifier.classify(input);
    }).pipe(Effect.provide(layer)),
  );

const runReadiness = (options: ClassifierLayerOptions): Promise<ClassifierHealth> =>
  Effect.runPromise(RouterClassifier.readiness(options));

test("Laya adapter normalizes a valid decide payload", async () => {
  const result = await runClassify(
    RouterClassifier.layer({
      mode: "laya",
      layaUrl: "http://127.0.0.1:8090",
      layaModelRevision: revision,
      qualifications: passingQualifications(),
      fetch: layaFetch(),
    }),
  );
  assert.equal(result.backend, "laya");
  assert.equal(result.assessment.task, "coding");
  assert.equal(result.assessment.difficulty.value, "moderate");
  assert.equal(result.usage.output_tokens, 0);
  assert.equal(result.modelRevision, revision);
  assert.equal(result.reuse, "classified");
  assert.equal(result.cacheHit, false);
});

test("exact classification cache reuses the first Laya result without healthz", async () => {
  let decideCalls = 0;
  let healthCalls = 0;
  const fetchImpl = layaFetch();
  const counting: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/v1/decide")) decideCalls += 1;
    if (url.endsWith("healthz")) healthCalls += 1;
    return fetchImpl(input, init);
  };
  const layer = RouterClassifier.layer({
    mode: "laya",
    layaUrl: "http://127.0.0.1:8090",
    layaModelRevision: revision,
    qualifications: passingQualifications(),
    fetch: counting,
  });
  const first = await runClassify(layer);
  const second = await runClassify(layer);
  assert.equal(decideCalls, 1);
  assert.equal(healthCalls, 1);
  assert.equal(first.cacheHit, false);
  assert.equal(second.cacheHit, true);
  assert.equal(second.reuse, "exact-cache");
  assert.equal(second.usage.input_tokens, 0);
  assert.equal(second.elapsedMs, 0);
});

test("over-budget full-input asks for a caller brief instead of truncating", async () => {
  await assert.rejects(
    () =>
      runClassify(
        RouterClassifier.layer({
          mode: "laya",
          layaUrl: "http://127.0.0.1:8090",
          layaModelRevision: revision,
          qualifications: passingQualifications(),
          fetch: layaFetch({ budgetFits: false }),
        }),
      ),
    (error: unknown) => {
      assert.equal((error as { _tag: string })._tag, "BriefRequired");
      return true;
    },
  );
});

test("malformed Laya answers fail closed", async () => {
  await assert.rejects(
    () =>
      runClassify(
        RouterClassifier.layer({
          mode: "laya",
          layaUrl: "http://127.0.0.1:8090",
          layaModelRevision: revision,
          qualifications: passingQualifications(),
          fetch: layaFetch({
            decideBody: {
              answers: { task: "coding" },
              usage: { input_tokens: 1, output_tokens: 0 },
              backend: "laya",
            },
          }),
        }),
      ),
    (error: unknown) => {
      assert.equal((error as { _tag: string })._tag, "ClassifierInvalidResponse");
      return true;
    },
  );
});

test("Laya mode never constructs a Jev client", async () => {
  const result = await runClassify(
    RouterClassifier.layer({
      mode: "laya",
      layaUrl: "http://127.0.0.1:8090",
      layaModelRevision: revision,
      qualifications: passingQualifications(),
      fetch: layaFetch(),
    }),
  );
  assert.equal(result.backend, "laya");
});

test("classification cache isolates keys and catalogue versions", async () => {
  let calls = 0;
  const original = layaFetch();
  const layer = RouterClassifier.layer({
    mode: "laya",
    layaUrl: "http://laya",
    layaModelRevision: revision,
    qualifications: passingQualifications(),
    fetch: async (input, init) => {
      if (String(input).endsWith("/v1/decide")) calls++;
      return original(input, init);
    },
  });
  await runClassify(layer);
  await runClassify(layer, { ...classifyInput, keyId: "another-key" });
  await runClassify(layer, { ...classifyInput, catalogueVersion: "next" });
  assert.equal(calls, 3);
});

test("a mismatched pinned Laya revision fails before task state is sent", async () => {
  let posts = 0;
  const original = layaFetch();
  const layer = RouterClassifier.layer({
    mode: "laya",
    layaUrl: "http://laya",
    layaModelRevision: "different",
    qualifications: [qualificationRecord({ modelRevision: "different" })],
    fetch: async (input, init) => {
      if (init?.method === "POST") posts++;
      return original(input, init);
    },
  });
  await assert.rejects(() => runClassify(layer), { _tag: "ClassifierUnavailable" });
  assert.equal(posts, 0);
});

test("classifier cancellation aborts the active local HTTP call", async () => {
  const entered = Promise.withResolvers<void>();
  let aborted = false;
  const controller = new AbortController();
  const original = layaFetch();
  const layer = RouterClassifier.layer({
    mode: "laya",
    layaUrl: "http://laya",
    layaModelRevision: revision,
    qualifications: passingQualifications(),
    fetch: async (input, init) => {
      if (!String(input).endsWith("/v1/decide")) return original(input, init);
      const pending = Promise.withResolvers<Response>();
      init?.signal?.addEventListener(
        "abort",
        () => {
          aborted = true;
          pending.reject(new Error("aborted"));
        },
        { once: true },
      );
      entered.resolve();
      return pending.promise;
    },
  });
  const pending = Effect.runPromise(
    RouterClassifier.use((service) => service.classify(classifyInput)).pipe(Effect.provide(layer)),
    { signal: controller.signal },
  );
  await entered.promise;
  controller.abort();
  await assert.rejects(() => pending);
  assert.equal(aborted, true);
});

test("an oversized caller brief is rejected without silently truncating it", async () => {
  await assert.rejects(
    () =>
      runClassify(
        RouterClassifier.layer({
          mode: "laya",
          layaUrl: "http://laya",
          layaModelRevision: revision,
          qualifications: passingQualifications(),
          fetch: layaFetch({ budgetFits: false }),
        }),
        { ...classifyInput, source: "caller-brief" },
      ),
    { _tag: "ClassifierContextExceeded" },
  );
});

test("real Jev SDK preserves pinned model, usage and semantic answers over HTTP", async () => {
  let calls = 0;
  let responseStatus = 401;
  const server = createServer(async (request, response) => {
    calls++;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(body.model, "jev-1.13.0");
    response.setHeader("content-type", "application/json");
    response.statusCode = responseStatus;
    response.end(
      JSON.stringify(
        responseStatus === 200
          ? {
              model: "jev-1.13.0",
              answers: layaAnswers,
              usage: { input_tokens: 321, output_tokens: 0 },
            }
          : { error: { message: "invalid key" } },
      ),
    );
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const runtime = ManagedRuntime.make(
    TypeSafeClient.layerFetch({ apiKey: "test-only", baseURL: `http://127.0.0.1:${address.port}` }),
  );
  try {
    const jev = await runtime.runPromise(TypeSafeClient);
    const layer = RouterClassifier.layer({
      mode: "jev",
      jev,
      jevModel: "jev-1.13.0",
      qualifications: passingJevQualifications(),
    });
    await assert.rejects(() => runClassify(layer), { _tag: "ClassifierUnavailable" });
    responseStatus = 200;
    const result = await runClassify(layer);
    assert.equal(result.assessment.task, "coding");
    assert.equal(result.usage.input_tokens, 321);
    assert.equal(result.modelRevision, "jev-1.13.0");
    const reused = await runClassify(layer);
    assert.equal(reused.usage.input_tokens, 0);
    assert.equal(reused.reuse, "exact-cache");
    assert.equal(calls, 2);
  } finally {
    await runtime.dispose();
    server.closeAllConnections();
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    await closed.promise;
  }
});

test("cancelling classification also aborts a stalled response body", async () => {
  const reading = Promise.withResolvers<void>();
  const cancellation = new AbortController();
  let aborted = false;
  const original = layaFetch();
  const layer = RouterClassifier.layer({
    mode: "laya",
    layaUrl: "http://laya",
    layaModelRevision: revision,
    qualifications: passingQualifications(),
    fetch: async (input, init) => {
      if (!String(input).endsWith("/v1/decide")) return original(input, init);
      return new Response(
        new ReadableStream(
          {
            start(controller) {
              init?.signal?.addEventListener(
                "abort",
                () => {
                  aborted = true;
                  controller.error(new Error("cancelled"));
                },
                { once: true },
              );
            },
            pull() {
              reading.resolve();
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  const pending = Effect.runPromise(
    RouterClassifier.use((service) => service.classify(classifyInput)).pipe(Effect.provide(layer)),
    { signal: cancellation.signal },
  );
  await reading.promise;
  cancellation.abort();
  await assert.rejects(() => pending);
  assert.equal(aborted, true);
});

test("readiness and uncached classification reject a 201 Laya health response", async () => {
  const health = await runReadiness({
    mode: "laya",
    layaUrl: "http://laya",
    layaModelRevision: revision,
    qualifications: passingQualifications(),
    fetch: layaFetch({ healthStatus: 201 }),
  });
  assert.equal(health.ready, false);
  assert.equal(health.evidence, "runtime-probe");

  let posts = 0;
  const original = layaFetch({ healthStatus: 201 });
  const layer = RouterClassifier.layer({
    mode: "laya",
    layaUrl: "http://laya",
    layaModelRevision: revision,
    qualifications: passingQualifications(),
    fetch: async (input, init) => {
      if (init?.method === "POST") posts += 1;
      return original(input, init);
    },
  });
  await assert.rejects(() => runClassify(layer), { _tag: "ClassifierUnavailable" });
  assert.equal(posts, 0);
});

test("readiness and uncached classification reject ok=false health that still reports ready", async () => {
  const rejected = { ...healthzBody, ok: false, backend: "laya-hot" };
  const health = await runReadiness({
    mode: "laya",
    layaUrl: "http://laya",
    layaModelRevision: revision,
    qualifications: passingQualifications(),
    fetch: layaFetch({ healthBody: rejected }),
  });
  assert.equal(health.ready, false);
  assert.equal(health.backend, "laya-hot");
  assert.equal(health.evidence, "runtime-probe");

  let posts = 0;
  const original = layaFetch({ healthBody: rejected });
  const layer = RouterClassifier.layer({
    mode: "laya",
    layaUrl: "http://laya",
    layaModelRevision: revision,
    qualifications: passingQualifications(),
    fetch: async (input, init) => {
      if (init?.method === "POST") posts += 1;
      return original(input, init);
    },
  });
  await assert.rejects(() => runClassify(layer), { _tag: "ClassifierUnavailable" });
  assert.equal(posts, 0);
});

test("readiness fails closed for unready, schema-invalid, and mismatched-revision health", async () => {
  const unready = await runReadiness({
    mode: "laya",
    layaUrl: "http://laya",
    layaModelRevision: revision,
    qualifications: passingQualifications(),
    fetch: layaFetch({ healthBody: { ...healthzBody, ready: false } }),
  });
  assert.equal(unready.ready, false);
  assert.equal(unready.evidence, "runtime-probe");

  const invalid = await runReadiness({
    mode: "laya",
    layaUrl: "http://laya",
    layaModelRevision: revision,
    qualifications: passingQualifications(),
    fetch: layaFetch({ healthBody: { ok: true, ready: true } }),
  });
  assert.equal(invalid.ready, false);
  assert.equal(invalid.evidence, "unavailable");

  const mismatched = await runReadiness({
    mode: "laya",
    layaUrl: "http://laya",
    layaModelRevision: revision,
    qualifications: passingQualifications(),
    fetch: layaFetch({ healthBody: { ...healthzBody, model_revision: "another-revision" } }),
  });
  assert.equal(mismatched.ready, false);
  assert.equal(mismatched.evidence, "runtime-probe");
});

test("unready and schema-invalid health stop classification before any task POST", async () => {
  const variants: Parameters<typeof layaFetch>[0][] = [
    { healthBody: { ...healthzBody, ready: false } },
    { healthBody: { ok: true, ready: true } },
  ];
  for (const overrides of variants) {
    let posts = 0;
    const original = layaFetch(overrides);
    const layer = RouterClassifier.layer({
      mode: "laya",
      layaUrl: "http://laya",
      layaModelRevision: revision,
      qualifications: passingQualifications(),
      fetch: async (input, init) => {
        if (init?.method === "POST") posts += 1;
        return original(input, init);
      },
    });
    await assert.rejects(() => runClassify(layer), { _tag: "ClassifierUnavailable" });
    assert.equal(posts, 0);
  }
});

test("readiness recovers once the Laya health probe recovers", async () => {
  const down = await runReadiness({
    mode: "laya",
    layaUrl: "http://laya",
    layaModelRevision: revision,
    qualifications: passingQualifications(),
    fetch: layaFetch({ healthStatus: 503 }),
  });
  assert.equal(down.ready, false);
  assert.equal(down.evidence, "runtime-probe");

  const up = await runReadiness({
    mode: "laya",
    layaUrl: "http://laya",
    layaModelRevision: revision,
    qualifications: passingQualifications(),
    fetch: layaFetch(),
  });
  assert.equal(up.ready, true);
  assert.equal(up.backend, "laya");
  assert.equal(up.local, true);
  assert.equal(up.evidence, "runtime-probe");
});

test("Laya readiness without a configured URL reports unavailable without probing", async () => {
  let calls = 0;
  const health = await runReadiness({
    mode: "laya",
    layaModelRevision: revision,
    qualifications: passingQualifications(),
    fetch: async () => {
      calls += 1;
      return jsonResponse(200, healthzBody);
    },
  });
  assert.equal(health.ready, false);
  assert.equal(health.evidence, "unavailable");
  assert.equal(calls, 0);
});

test("Jev readiness is configuration-only and never calls fetch", async () => {
  let calls = 0;
  const guard: typeof fetch = async () => {
    calls += 1;
    throw new Error("Jev readiness must not spend on a probe");
  };

  const byKey = await runReadiness({
    mode: "jev",
    jevApiKey: "test-key",
    qualifications: passingJevQualifications(),
    fetch: guard,
  });
  assert.equal(byKey.ready, true);
  assert.equal(byKey.backend, "jev");
  assert.equal(byKey.local, false);
  assert.equal(byKey.evidence, "configuration-only");

  const byClient = await runReadiness({
    mode: "jev",
    jev: {} as TypeSafeClientService,
    qualifications: passingJevQualifications(),
    fetch: guard,
  });
  assert.equal(byClient.ready, true);

  const unconfigured = await runReadiness({
    mode: "jev",
    qualifications: passingJevQualifications(),
    fetch: guard,
  });
  assert.equal(unconfigured.ready, false);

  assert.equal(calls, 0);
});

test("readiness does not populate the exact classification cache", async () => {
  const health = await runReadiness({
    mode: "laya",
    layaUrl: "http://laya",
    layaModelRevision: revision,
    qualifications: passingQualifications(),
    fetch: layaFetch(),
  });
  assert.equal(health.ready, true);

  const layer = RouterClassifier.layer({
    mode: "laya",
    layaUrl: "http://laya",
    layaModelRevision: revision,
    qualifications: passingQualifications(),
    fetch: layaFetch(),
  });
  const first = await runClassify(layer);
  assert.equal(first.cacheHit, false);
  assert.equal(first.reuse, "classified");
  const second = await runClassify(layer);
  assert.equal(second.cacheHit, true);
  assert.equal(second.reuse, "exact-cache");
});

test(
  "a stalled Laya health response body is torn down by the readiness budget",
  { timeout: 8_000 },
  async () => {
    let connectionClosed = false;
    const closedEarly = Promise.withResolvers<void>();
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"ok":true,"ready":true,');
      response.on("close", () => {
        if (!response.writableEnded) {
          connectionClosed = true;
          closedEarly.resolve();
        }
      });
    });
    const listening = Promise.withResolvers<void>();
    server.listen(0, "127.0.0.1", listening.resolve);
    await listening.promise;
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    try {
      const started = Date.now();
      const health = await runReadiness({
        mode: "laya",
        layaUrl: `http://127.0.0.1:${address.port}`,
        layaModelRevision: revision,
        qualifications: passingQualifications(),
      });
      const elapsed = Date.now() - started;
      assert.equal(health.ready, false);
      assert.equal(health.evidence, "unavailable");
      assert.ok(elapsed < 5_000, `readiness stayed pending for ${elapsed}ms`);
      // If readiness stops cancelling the body read, this never resolves and the
      // test-level timeout fails it, naming the missing teardown.
      await closedEarly.promise;
      assert.equal(connectionClosed, true, "readiness must abort the stalled response body");
    } finally {
      server.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    }
  },
);

test("missing qualification records refuse classification before any fetch", async () => {
  const layer = RouterClassifier.layer({
    mode: "laya",
    layaUrl: "http://laya",
    layaModelRevision: revision,
    qualifications: [],
    fetch: gateGuard,
  });
  await assert.rejects(() => runClassify(layer), unqualifiedReason("missing"));
});

test("wrong identity records and an unpinned Laya revision fail closed", async () => {
  const wrongRevision = RouterClassifier.layer({
    mode: "laya",
    layaUrl: "http://laya",
    layaModelRevision: revision,
    qualifications: [qualificationRecord({ modelRevision: "other-revision" })],
    fetch: gateGuard,
  });
  await assert.rejects(() => runClassify(wrongRevision), unqualifiedReason("identity-mismatch"));

  const wrongSchema = RouterClassifier.layer({
    mode: "laya",
    layaUrl: "http://laya",
    layaModelRevision: revision,
    qualifications: [
      qualificationRecord({ questionSchemaVersion: "dymoo-assessment-questions/v0" }),
    ],
    fetch: gateGuard,
  });
  await assert.rejects(() => runClassify(wrongSchema), unqualifiedReason("identity-mismatch"));

  const unpinned = RouterClassifier.layer({
    mode: "laya",
    layaUrl: "http://laya",
    qualifications: passingQualifications(),
    fetch: gateGuard,
  });
  await assert.rejects(() => runClassify(unpinned), unqualifiedReason("identity-mismatch"));
});

test("REPLACE_ placeholder records decode but are rejected by the gate", async () => {
  const example: unknown = JSON.parse(
    readFileSync("classifier-qualification.example.json", "utf8"),
  );
  const records = Schema.decodeUnknownSync(ClassifierQualifications)(example);
  assert.equal(records.length, 2);

  const base = qualificationRecord();
  const placeholder = withCalibration(base, {
    evaluationSet: { ...base.calibration.evaluationSet, labelsSource: "REPLACE_OPERATOR_LABELS" },
  });
  const layer = RouterClassifier.layer({
    mode: "laya",
    layaUrl: "http://laya",
    layaModelRevision: revision,
    qualifications: [placeholder],
    fetch: gateGuard,
  });
  await assert.rejects(() => runClassify(layer), unqualifiedReason("placeholder"));

  const exampleLayer = RouterClassifier.layer({
    mode: "laya",
    layaUrl: "http://laya",
    layaModelRevision: "REPLACE_WITH_LAYA_MODEL_REVISION",
    qualifications: records,
    fetch: gateGuard,
  });
  await assert.rejects(() => runClassify(exampleLayer), unqualifiedReason("identity-mismatch"));
});

test("measurement and provenance placeholders are rejected, not just identity fields", async () => {
  const base = qualificationRecord();
  const placeholderRecords = [
    withCalibration(base, { measuredAt: "REPLACE_MEASURED_AT" }),
    withCalibration(base, {
      evaluationSet: { ...base.calibration.evaluationSet, asOf: "REPLACE_EVAL_ASOF" },
    }),
    {
      ...base,
      rates: { ...base.rates, provenance: { ...base.rates.provenance, unit: "REPLACE_RATE_UNIT" } },
    },
    {
      ...base,
      rates: {
        ...base.rates,
        provenance: { ...base.rates.provenance, source: "REPLACE_RATE_SOURCE" },
      },
    },
  ];
  for (const record of placeholderRecords) {
    const layer = RouterClassifier.layer({
      mode: "laya",
      layaUrl: "http://laya",
      layaModelRevision: revision,
      qualifications: [record],
      fetch: gateGuard,
    });
    await assert.rejects(() => runClassify(layer), unqualifiedReason("placeholder"));
  }
});

test("a failed verdict never qualifies even with passing metrics", async () => {
  const layer = RouterClassifier.layer({
    mode: "laya",
    layaUrl: "http://laya",
    layaModelRevision: revision,
    qualifications: [withCalibration(qualificationRecord(), { verdict: "fail" })],
    fetch: gateGuard,
  });
  await assert.rejects(() => runClassify(layer), unqualifiedReason("not-passed"));
});

test("an unmeasured question fails the gate with its question id", async () => {
  const base = qualificationRecord();
  const layer = RouterClassifier.layer({
    mode: "laya",
    layaUrl: "http://laya",
    layaModelRevision: revision,
    qualifications: [
      withCalibration(base, {
        metrics: Object.fromEntries(
          Object.entries(base.calibration.metrics).filter(([id]) => id !== "effort"),
        ),
      }),
    ],
    fetch: gateGuard,
  });
  await assert.rejects(() => runClassify(layer), unqualifiedReason("unmeasured", "effort"));
});

test("out-of-bounds calibration metrics fail the gate with the question id", async () => {
  const base = qualificationRecord();
  const layer = RouterClassifier.layer({
    mode: "laya",
    layaUrl: "http://laya",
    layaModelRevision: revision,
    qualifications: [
      withCalibration(base, {
        metrics: {
          ...base.calibration.metrics,
          task: { cases: 10, negativeCases: 5, errors: 11, falsePositives: 0 },
        },
      }),
    ],
    fetch: gateGuard,
  });
  await assert.rejects(() => runClassify(layer), unqualifiedReason("metric-invalid", "task"));
});

test("error-rate and false-positive-rate violations name the failing question", async () => {
  const base = qualificationRecord();
  const errorRate = RouterClassifier.layer({
    mode: "laya",
    layaUrl: "http://laya",
    layaModelRevision: revision,
    qualifications: [
      withCalibration(base, {
        metrics: {
          ...base.calibration.metrics,
          task: { cases: 10, negativeCases: 5, errors: 9, falsePositives: 0 },
        },
      }),
    ],
    fetch: gateGuard,
  });
  await assert.rejects(() => runClassify(errorRate), unqualifiedReason("error-rate", "task"));

  const falsePositive = RouterClassifier.layer({
    mode: "laya",
    layaUrl: "http://laya",
    layaModelRevision: revision,
    qualifications: [
      withCalibration(base, {
        metrics: {
          ...base.calibration.metrics,
          task: { cases: 10, negativeCases: 5, errors: 2, falsePositives: 2 },
        },
      }),
    ],
    fetch: gateGuard,
  });
  await assert.rejects(
    () => runClassify(falsePositive),
    unqualifiedReason("false-positive-rate", "task"),
  );
});

test("false-positive rate uses measured negative opportunities, not all cases", () => {
  const base = qualificationRecord();
  const record = withCalibration(base, {
    metrics: {
      ...base.calibration.metrics,
      task: { cases: 10, negativeCases: 2, errors: 1, falsePositives: 1 },
    },
  });
  const selected = {
    backend: "laya" as const,
    modelRevision: revision,
    questionSchemaVersion: ASSESSMENT_QUESTION_SCHEMA_VERSION,
  };
  assert.deepEqual(evaluateClassifierQualification([record], selected, questionIds), {
    _tag: "false-positive-rate",
    questionId: "task",
  });
  const atBound = withCalibration(record, {
    thresholds: {
      ...record.calibration.thresholds,
      task: { maxErrorRate: 0.2, maxFalsePositiveRate: 0.5 },
    },
  });
  assert.equal(evaluateClassifierQualification([atBound], selected, questionIds)._tag, "qualified");
});

test("risk questions require an explicit FPR bound and measured negative opportunities", () => {
  const base = qualificationRecord();
  const selected = {
    backend: "laya" as const,
    modelRevision: revision,
    questionSchemaVersion: ASSESSMENT_QUESTION_SCHEMA_VERSION,
  };
  for (const questionId of ["localSufficiency", "trivialChat"]) {
    const missingBound = withCalibration(base, {
      thresholds: {
        ...base.calibration.thresholds,
        [questionId]: { maxErrorRate: 0.2, maxFalsePositiveRate: null },
      },
    });
    assert.deepEqual(evaluateClassifierQualification([missingBound], selected, questionIds), {
      _tag: "false-positive-rate",
      questionId,
    });
    const missingOpportunities = withCalibration(base, {
      metrics: {
        ...base.calibration.metrics,
        [questionId]: { cases: 10, errors: 0, falsePositives: 0 },
      },
    });
    const decoded = Schema.decodeUnknownSync(ClassifierQualifications)([missingOpportunities]);
    assert.deepEqual(evaluateClassifierQualification(decoded, selected, questionIds), {
      _tag: "metric-invalid",
      questionId,
    });
  }
  const nonRiskWithoutBound = withCalibration(base, {
    thresholds: {
      ...base.calibration.thresholds,
      task: { maxErrorRate: 0.2, maxFalsePositiveRate: null },
    },
  });
  assert.equal(
    evaluateClassifierQualification([nonRiskWithoutBound], selected, questionIds)._tag,
    "qualified",
  );
});

test("bounded FPR rejects inconsistent negative counts and false-positive numerators", () => {
  const base = qualificationRecord();
  const selected = {
    backend: "laya" as const,
    modelRevision: revision,
    questionSchemaVersion: ASSESSMENT_QUESTION_SCHEMA_VERSION,
  };
  for (const metric of [
    { cases: 10, negativeCases: 0, errors: 0, falsePositives: 0 },
    { cases: 10, negativeCases: 11, errors: 0, falsePositives: 0 },
    { cases: 10, negativeCases: 2, errors: 3, falsePositives: 3 },
    { cases: 10, negativeCases: 5, errors: 0, falsePositives: 1 },
    { cases: 10, negativeCases: 5, errors: 0, falsePositives: null },
  ]) {
    const record = withCalibration(base, {
      metrics: { ...base.calibration.metrics, task: metric },
    });
    assert.deepEqual(evaluateClassifierQualification([record], selected, questionIds), {
      _tag: "metric-invalid",
      questionId: "task",
    });
  }
});

test("a passing record covering all seven assessment questions clears the gate", async () => {
  assert.equal(questionIds.length, 7);
  const record = qualificationRecord();
  assert.deepEqual(Object.keys(record.calibration.metrics), questionIds);
  assert.deepEqual(Object.keys(record.calibration.thresholds), questionIds);
  const result = await runClassify(
    RouterClassifier.layer({
      mode: "laya",
      layaUrl: "http://127.0.0.1:8090",
      layaModelRevision: revision,
      qualifications: [record],
      fetch: layaFetch(),
    }),
  );
  assert.equal(result.cacheHit, false);
  assert.equal(result.reuse, "classified");
});

test("the gate runs before the exact-cache lookup and never populates it", async () => {
  const qualifications: ClassifierQualification[] = [qualificationRecord()];
  const layer = RouterClassifier.layer({
    mode: "laya",
    layaUrl: "http://laya",
    layaModelRevision: revision,
    qualifications,
    fetch: layaFetch(),
  });
  const first = await runClassify(layer);
  assert.equal(first.cacheHit, false);
  assert.equal(first.reuse, "classified");

  qualifications[0] = withCalibration(qualificationRecord(), { verdict: "fail" });
  await assert.rejects(() => runClassify(layer), unqualifiedReason("not-passed"));

  qualifications[0] = qualificationRecord();
  const restored = await runClassify(layer);
  assert.equal(restored.cacheHit, true);
  assert.equal(restored.reuse, "exact-cache");
});

test("readiness reports unqualified without probing", async () => {
  let calls = 0;
  const health = await runReadiness({
    mode: "laya",
    layaUrl: "http://laya",
    layaModelRevision: revision,
    qualifications: [],
    fetch: async () => {
      calls += 1;
      return jsonResponse(200, healthzBody);
    },
  });
  assert.equal(health.ready, false);
  assert.equal(health.backend, "laya");
  assert.equal(health.local, true);
  assert.equal(health.evidence, "unqualified");
  assert.equal(calls, 0);
});

test("an unqualified Jev backend never constructs a client or probes", async () => {
  let calls = 0;
  const guard: typeof fetch = async () => {
    calls += 1;
    throw new Error("unqualified readiness must not spend on a probe");
  };
  const health = await runReadiness({
    mode: "jev",
    jevApiKey: "test-key",
    qualifications: [],
    fetch: guard,
  });
  assert.equal(health.ready, false);
  assert.equal(health.backend, "jev");
  assert.equal(health.local, false);
  assert.equal(health.evidence, "unqualified");
  assert.equal(calls, 0);

  const untouched = new Proxy(
    {},
    {
      get() {
        throw new Error("an unqualified Jev classification must not touch the client");
      },
    },
  ) as unknown as TypeSafeClientService;
  const layer = RouterClassifier.layer({ mode: "jev", jev: untouched, qualifications: [] });
  await assert.rejects(() => runClassify(layer), unqualifiedReason("missing"));
  assert.equal(calls, 0);
});

test("the production Jev wiring fails closed before SDK client construction", async () => {
  // Without an injected client, the gate must win over any SDK construction error.
  const layer = RouterClassifier.layer({ mode: "jev", qualifications: [] });
  await assert.rejects(() => runClassify(layer), unqualifiedReason("missing"));

  // Control: a qualifying record reaches SDK construction, where the deliberately
  // missing key surfaces as a configuration failure.
  const qualified = RouterClassifier.layer({
    mode: "jev",
    qualifications: [qualificationRecord({ backend: "jev", modelRevision: "jev-1.13.0" })],
  });
  await assert.rejects(
    () => runClassify(qualified),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "_tag" in error &&
      error._tag === "ClassifierUnavailable",
  );
});
