import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, ManagedRuntime, type Layer } from "effect";
import { RouterClassifier, assessmentQuestions } from "../src/classifier.ts";
import type { ClassifyInput } from "../src/domain.ts";
import { TypeSafeClient } from "@compootor/effective-jev";
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

const layaFetch = (overrides?: {
  budgetFits?: boolean;
  decideStatus?: number;
  decideBody?: unknown;
}): typeof fetch => {
  const budgetFits = overrides?.budgetFits ?? true;
  return (async (input) => {
    const url = String(input);
    if (url.endsWith("/healthz") || url.endsWith("healthz")) {
      return jsonResponse(200, {
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
      });
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

test("Laya adapter normalizes a valid decide payload", async () => {
  const result = await runClassify(
    RouterClassifier.layer({ mode: "laya", layaUrl: "http://127.0.0.1:8090", fetch: layaFetch() }),
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
    RouterClassifier.layer({ mode: "laya", layaUrl: "http://127.0.0.1:8090", fetch: layaFetch() }),
  );
  assert.equal(result.backend, "laya");
});

test("classification cache isolates keys and catalogue versions", async () => {
  let calls = 0;
  const original = layaFetch();
  const layer = RouterClassifier.layer({
    mode: "laya",
    layaUrl: "http://laya",
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
    const layer = RouterClassifier.layer({ mode: "jev", jev, jevModel: "jev-1.13.0" });
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
