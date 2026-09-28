import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { Deferred, Effect, Fiber } from "effect";
import { ClassifierUnqualified } from "../../src/errors.ts";
import type { RequestAccounting } from "../../src/domain.ts";
import { modelRouterLayer, ModelRouter } from "../../src/router/model-router.ts";
import { createOpenRouterPinVerifier } from "../../src/router/adapters/openrouter.ts";
import type { Classification, RouterWork } from "../../src/router/model-router.ts";
import {
  balancedPolicy,
  cloudGlm,
  easyLocalCoding,
  frontier,
  greeting,
  hardCoding,
  localQwen,
} from "./fixtures.ts";

const completionBody = {
  id: "cmpl",
  choices: [
    {
      message: {
        role: "assistant",
        content: "done",
        reasoning_content: "kept",
        tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }],
      },
      finish_reason: "tool_calls",
    },
  ],
  usage: {
    prompt_tokens: 12,
    completion_tokens: 8,
    completion_tokens_details: { reasoning_tokens: 3 },
  },
};

function fakeFetch(): typeof fetch {
  return (async (input: string | URL) => {
    const url = String(input);
    if (url.includes("/slots")) {
      return new Response(JSON.stringify([{ id: 0, is_processing: false }]), { status: 200 });
    }
    if (url.includes("/health")) {
      return new Response(JSON.stringify({ status: "ok", engine: { responds: true } }), {
        status: 200,
      });
    }
    return new Response(JSON.stringify(completionBody), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function hangingFetch(): typeof fetch {
  let generations = 0;
  return (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/slots")) {
      return new Response(JSON.stringify([{ id: 0, is_processing: false }]), { status: 200 });
    }
    if (url.includes("/health")) {
      return new Response(JSON.stringify({ status: "ok", engine: { responds: true } }), {
        status: 200,
      });
    }
    if (generations++ > 0) return new Response(JSON.stringify(completionBody));
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
  }) as typeof fetch;
}

function classifyAs(assessment: NonNullable<Classification["assessment"]>) {
  return {
    assessment,
    usage: { input_tokens: 11, output_tokens: 0 },
    backend: "laya" as const,
    modelRevision: "laya",
    cacheHit: false,
    elapsedMs: 9,
    reuse: "classified" as const,
    source: "full-input" as const,
  };
}

function work(partial: Partial<RouterWork> & Pick<RouterWork, "routing">): RouterWork {
  return {
    requestId: partial.requestId ?? "req-1",
    keyId: partial.keyId ?? "key-1",
    policy: partial.policy ?? { ...balancedPolicy, maxWaitMs: 0 },
    messages: partial.messages ?? [{ role: "user", content: "hi" }],
    inputTokens: partial.inputTokens ?? 40,
    capabilities: partial.capabilities ?? { tools: false, json: false, vision: false },
    freshFactsAvailable: partial.freshFactsAvailable ?? false,
    stream: false,
    ...partial,
  };
}

function batchWork(partial: Partial<RouterWork> & Pick<RouterWork, "routing">): RouterWork {
  return work(partial);
}
describe("ModelRouter", () => {
  it("rules selects local without a classifier or invented judgments, and preserves thinking-off on continue", async () => {
    const layer = modelRouterLayer({
      mode: "rules",
      catalogue: [
        {
          ...localQwen,
          prices: {
            ...localQwen.prices,
            provenance: { ...localQwen.prices.provenance, source: "unknown" },
          },
        },
        cloudGlm,
      ],
      catalogueVersion: "rules-test",
      fetch: fakeFetch(),
    });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const router = yield* ModelRouter;
        const first = yield* router.complete(
          work({ routing: { sessionId: "rules", boundary: "new-task" } }),
        );
        const second = yield* router.complete(
          work({ routing: { sessionId: "rules", boundary: "continue" } }),
        );
        return { first, second };
      }).pipe(Effect.provide(layer)),
    );
    assert.equal(result.first.headers.deploymentId, localQwen.id);
    assert.equal(result.first.headers.appliedEffort, "none");
    assert.equal(result.first.accounting.classifierBackend, null);
    assert.equal(result.first.accounting.reuse, null);
    assert.equal(result.first.decision.reason, "deterministic-rules");
    assert.equal(result.first.decision.assessment.task, null);
    assert.equal(result.first.decision.assessment.difficulty, null);
    assert.equal(result.second.headers.deploymentId, localQwen.id);
    assert.equal(result.second.headers.appliedEffort, "none");
    assert.equal(result.second.accounting.reuse, "session");
  });
  it("routes an Open WebUI chat afresh when its pin is gone, but still refuses an explicit continue", async () => {
    const layer = modelRouterLayer({
      mode: "rules",
      catalogue: [localQwen, cloudGlm],
      catalogueVersion: "webui-test",
      fetch: fakeFetch(),
    });
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const router = yield* ModelRouter;
        const webui = yield* router.complete(
          work({ routing: { sessionId: "webui:chat-1", boundary: "continue" } }),
        );
        const explicit = yield* Effect.flip(
          router.complete(work({ routing: { sessionId: "agent-1", boundary: "continue" } })),
        );
        return { webui, explicit };
      }).pipe(Effect.provide(layer)),
    );
    assert.equal(outcome.webui.headers.deploymentId, localQwen.id);
    assert.equal((outcome.explicit as { _tag?: string })._tag, "MissingSession");
  });
  it("rules routes requests local cannot fit or support to cloud, and otherwise returns NoEligibleModel", async () => {
    for (const scenario of [
      { inputTokens: 40_000, capabilities: { tools: false, json: false, vision: false } },
      { inputTokens: 40, capabilities: { tools: false, json: true, vision: false } },
    ]) {
      const local = { ...localQwen, capabilities: { tools: true, json: false, vision: false } };
      for (const cloud of [true, false]) {
        for (const localDown of [false, true]) {
          const layer = modelRouterLayer({
            mode: "rules",
            catalogue: cloud ? [local, { ...cloudGlm, contextLimitTokens: 100_000 }] : [local],
            catalogueVersion: "rules-test",
            fetch: fakeFetch(),
            unavailable: localDown ? new Set([local.id]) : undefined,
          });
          const result = await Effect.runPromise(
            ModelRouter.use((router) =>
              router.complete(
                work({
                  ...scenario,
                  policy: {
                    ...balancedPolicy,
                    localityBias: 1,
                    contextLimitTokens: 100_000,
                    maxWaitMs: 0,
                  },
                  routing: { sessionId: "rules-fit", boundary: "new-task" },
                }),
              ),
            ).pipe(Effect.result, Effect.provide(layer)),
          );
          if (cloud) {
            assert.equal(result._tag, "Success");
            if (result._tag === "Success")
              assert.equal(result.success.headers.deploymentId, cloudGlm.id);
          } else {
            assert.equal(result._tag, "Failure");
            if (result._tag === "Failure") assert.equal(result.failure._tag, "NoEligibleModel");
          }
        }
      }
    }
  });
  it("rules respects the locality preference boundary and lowest supported effort without a quality signal", async () => {
    for (const [localityBias, expected] of [
      [0.49, cloudGlm.id],
      [0.5, localQwen.id],
    ] as const) {
      const layer = modelRouterLayer({
        mode: "rules",
        catalogue: [localQwen, cloudGlm],
        catalogueVersion: "bias",
        fetch: fakeFetch(),
      });
      const result = await Effect.runPromise(
        ModelRouter.use((router) =>
          router.complete(
            work({
              policy: {
                ...balancedPolicy,
                localityBias,
                bias: { quality: 1, cost: 0, latency: 0 },
              },
              routing: { sessionId: "bias", boundary: "new-task", qualityOverride: "highest" },
            }),
          ),
        ).pipe(Effect.provide(layer)),
      );
      assert.equal(result.headers.deploymentId, expected);
    }
    for (const [reasoning, expected] of [
      [{ kind: "graded", levels: ["high", "low", "medium"] }, "low"],
      [{ kind: "mandatory" }, "on"],
      [{ kind: "none" }, "none"],
    ] as const) {
      const layer = modelRouterLayer({
        mode: "rules",
        catalogue: [{ ...localQwen, reasoning }],
        catalogueVersion: "effort",
        fetch: fakeFetch(),
      });
      const result = await Effect.runPromise(
        ModelRouter.use((router) =>
          router.complete(
            work({
              routing: { sessionId: "effort", boundary: "new-task" },
            }),
          ),
        ).pipe(Effect.provide(layer)),
      );
      assert.equal(result.headers.appliedEffort, expected);
    }
  });
  it("rules treats missing local credentials as hard ineligibility, not downtime", async () => {
    for (const cloudAllowed of [true, false]) {
      const contacts: string[] = [];
      const layer = modelRouterLayer({
        mode: "rules",
        catalogue: [
          { ...localQwen, transport: "gufo", credentialEnvVar: "MISSING_GUFO_KEY" },
          cloudGlm,
        ],
        catalogueVersion: "rules-credentials",
        credentials: () => undefined,
        fetch: async (url, init) => {
          contacts.push(String(url));
          return fakeFetch()(url, init);
        },
      });
      const result = await Effect.runPromise(
        ModelRouter.use((router) =>
          router.complete(
            work({
              policy: {
                ...balancedPolicy,
                overloadAction: "report",
                allowedModels: cloudAllowed ? null : [localQwen.id],
              },
              routing: { sessionId: "missing-credential", boundary: "new-task" },
            }),
          ),
        ).pipe(Effect.result, Effect.provide(layer)),
      );
      if (cloudAllowed) {
        assert.equal(result._tag, "Success");
        if (result._tag === "Success")
          assert.equal(result.success.headers.deploymentId, cloudGlm.id);
        assert.deepEqual(contacts, [cloudGlm.endpoint + "/v1/chat/completions"]);
      } else {
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") assert.equal(result.failure._tag, "NoEligibleModel");
        assert.deepEqual(contacts, []);
      }
    }
  });
  it("rules treats unhealthy Gufo as local overload without waiting or silently charging report keys", async () => {
    for (const { overloadAction, localityBias, allowedModels } of [
      { overloadAction: "report", localityBias: 0.65, allowedModels: null },
      { overloadAction: "failover", localityBias: 0.65, allowedModels: null },
      { overloadAction: "report", localityBias: 0.1, allowedModels: [localQwen.id] },
    ] as const) {
      const calls: string[] = [];
      let queues = 0;
      const layer = modelRouterLayer({
        mode: "rules",
        catalogue: [
          { ...localQwen, transport: "gufo", credentialEnvVar: "GUFO_TEST_KEY" },
          cloudGlm,
        ],
        credentials: () => "fixture-key",
        catalogueVersion: "rules-down",
        onQueue: () => {
          queues++;
        },
        fetch: async (url, init) => {
          if (String(url).includes(localQwen.id)) {
            assert.equal(init?.method, "GET");
            return new Response(null, { status: 503 });
          }
          if (init?.method === "POST") calls.push(String(url));
          return Response.json(completionBody);
        },
      });
      const result = await Effect.runPromise(
        ModelRouter.use((router) =>
          router.complete(
            work({
              policy: {
                ...balancedPolicy,
                overloadAction,
                localityBias,
                allowedModels,
                maxWaitMs: 30_000,
              },
              routing: { sessionId: "down", boundary: "new-task" },
            }),
          ),
        ).pipe(Effect.result, Effect.provide(layer)),
      );
      assert.equal(queues, 0);
      if (overloadAction === "report") {
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") assert.equal(result.failure._tag, "LocalOverloaded");
        assert.deepEqual(calls, []);
      } else {
        assert.equal(result._tag, "Success");
        if (result._tag === "Success")
          assert.equal(result.success.headers.deploymentId, cloudGlm.id);
        assert.deepEqual(calls, [cloudGlm.endpoint + "/v1/chat/completions"]);
      }
    }
  });
  it("hands client app attribution to OpenRouter and never to a local runtime", async () => {
    const posts: Array<[string, string | null, string | null]> = [];
    const upstream = fakeFetch();
    const layer = modelRouterLayer({
      catalogue: [localQwen, frontier],
      classify: () => Effect.succeed(classifyAs(easyLocalCoding)),
      catalogueVersion: "app",
      credentials: () => "sk-test",
      fetch: (async (input: string | URL, init?: RequestInit) => {
        if (init?.method === "POST") {
          const headers = new Headers(init.headers);
          posts.push([String(input), headers.get("HTTP-Referer"), headers.get("X-Title")]);
        }
        return upstream(input, init);
      }) as typeof fetch,
    });
    const appAttribution = { url: "https://vibe.example", title: "Free Vibecode" };
    await Effect.runPromise(
      Effect.gen(function* () {
        const router = yield* ModelRouter;
        for (const [requestId, allowed] of [
          ["req-cloud", frontier.id],
          ["req-local", localQwen.id],
        ] as const)
          yield* router.complete(
            work({
              requestId,
              appAttribution,
              policy: {
                ...balancedPolicy,
                maxWaitMs: 0,
                localityBias: 0,
                allowedModels: [allowed],
              },
              routing: { sessionId: requestId, boundary: "new-task" },
            }),
          );
      }).pipe(Effect.provide(layer)),
    );
    assert.deepEqual(posts, [
      [frontier.endpoint + "/v1/chat/completions", appAttribution.url, appAttribution.title],
      [localQwen.endpoint + "/v1/chat/completions", null, null],
    ]);
  });

  it("pins continuations to the same deployment and effort", async () => {
    const layer = modelRouterLayer({
      catalogue: [localQwen, cloudGlm],
      classify: () => Effect.succeed(classifyAs(easyLocalCoding)),
      catalogueVersion: "v1",
      fetch: fakeFetch(),
    });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const router = yield* ModelRouter;
        const first = yield* router.complete(
          work({
            routing: { sessionId: "traj-1", boundary: "new-task" },
          }),
        );
        const second = yield* router.complete(
          work({
            requestId: "req-2",
            routing: { sessionId: "traj-1", boundary: "continue" },
            capabilities: { tools: true, json: false, vision: false },
            messages: [
              { role: "user", content: "hi" },
              { role: "assistant", content: "done", reasoning_content: "kept" },
              { role: "user", content: "now write code" },
            ],
          }),
        );
        return { first, second };
      }).pipe(Effect.provide(layer)),
    );
    assert.equal(result.first.headers.deploymentId, result.second.headers.deploymentId);
    assert.equal(result.second.accounting.reuse, "session");
    assert.notEqual(result.second.headers.appliedEffort, "none");
    assert.equal(result.first.body.choices !== undefined, true);
    const message = (result.first.body.choices as { message: { reasoning_content?: string } }[])[0]
      ?.message;
    assert.equal(message?.reasoning_content, "kept");
  });

  it("does not retry after dispatch and still releases the permit", async () => {
    let completes = 0;
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/slots")) {
        return new Response(JSON.stringify([{ id: 0, is_processing: false }]), { status: 200 });
      }
      if (url.includes("/health")) {
        return new Response(JSON.stringify({ status: "ok", engine: { responds: true } }), {
          status: 200,
        });
      }
      completes += 1;
      return new Response(
        JSON.stringify(completes === 1 ? { error: { message: "upstream" } } : completionBody),
        { status: 200 },
      );
    }) as typeof fetch;
    const layer = modelRouterLayer({
      catalogue: [{ ...localQwen, capacity: { maxParallel: 1, reservedInteractiveSlots: 0 } }],
      classify: () => Effect.succeed(classifyAs(easyLocalCoding)),
      catalogueVersion: "v1",
      fetch: fetchImpl,
    });
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const router = yield* ModelRouter;
        const failed = yield* router
          .complete(work({ routing: { sessionId: "x", boundary: "new-task" } }))
          .pipe(Effect.result);
        const recovered = yield* router.complete(
          work({ requestId: "req-2", routing: { sessionId: "y", boundary: "new-task" } }),
        );
        return { failed, recovered };
      }).pipe(Effect.provide(layer)),
    );
    assert.equal(completes, 2);
    assert.equal(outcome.failed._tag, "Failure");
    assert.equal(outcome.recovered.headers.deploymentId, "local-qwen");
  });

  it("releases permits when a hanging dispatch is interrupted", async () => {
    const layer = modelRouterLayer({
      catalogue: [{ ...localQwen, capacity: { maxParallel: 1, reservedInteractiveSlots: 0 } }],
      classify: () => Effect.succeed(classifyAs(easyLocalCoding)),
      catalogueVersion: "v1",
      fetch: hangingFetch(),
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const router = yield* ModelRouter;
        const fiber = yield* Effect.forkChild(
          router.complete(work({ routing: { sessionId: "hang", boundary: "new-task" } })),
          { startImmediately: true },
        );
        yield* Effect.sleep("30 millis");
        yield* Fiber.interrupt(fiber);
        const recovered = yield* router.complete(
          work({
            requestId: "after",
            policy: { ...balancedPolicy, maxWaitMs: 0 },
            routing: { sessionId: "after", boundary: "new-task" },
          }),
        );
        assert.equal(recovered.headers.deploymentId, "local-qwen");
      }).pipe(Effect.provide(layer)),
    );
  });

  it("tags a continuation as pinned and a new local task as local-preference", async () => {
    const layer = modelRouterLayer({
      catalogue: [localQwen, cloudGlm],
      catalogueVersion: "v1",
      classify: () => Effect.succeed(classifyAs(easyLocalCoding)),
      fetch: fakeFetch(),
    });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const router = yield* ModelRouter;
        const first = yield* router.complete(
          work({
            keyPolicyVersion: 3,
            routing: { sessionId: "traj-2", boundary: "new-task" },
          }),
        );
        const second = yield* router.complete(
          work({
            requestId: "req-2",
            keyPolicyVersion: 3,
            routing: { sessionId: "traj-2", boundary: "continue" },
          }),
        );
        return { first, second };
      }).pipe(Effect.provide(layer)),
    );
    assert.equal(result.first.decision.reason, "local-preference");
    assert.equal(result.second.decision.reason, "pinned");
    assert.equal(result.first.decision.catalogueVersion, "v1");
    assert.equal(result.first.decision.keyPolicyVersion, 3);
    assert.ok(
      result.first.decision.exclusions.every((exclusion) => typeof exclusion.code === "string"),
    );
  });

  it("emits queued before dispatch for a waiting low-priority request", async () => {
    const events: string[] = [];
    const layer = modelRouterLayer({
      catalogue: [{ ...localQwen, capacity: { maxParallel: 1, reservedInteractiveSlots: 0 } }],
      classify: () => Effect.succeed(classifyAs(easyLocalCoding)),
      catalogueVersion: "v1",
      fetch: hangingFetch(),
      onQueue: (event) => events.push(event.state),
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const router = yield* ModelRouter;
        const blocker = yield* Effect.forkChild(
          router.complete(
            work({
              policy: { ...balancedPolicy, priority: "high", maxWaitMs: 0 },
              routing: { sessionId: "block", boundary: "new-task" },
            }),
          ),
          { startImmediately: true },
        );
        yield* Effect.sleep("20 millis");
        const waiter = yield* Effect.forkChild(
          router.complete(
            work({
              requestId: "queued",
              policy: { ...balancedPolicy, priority: "low", maxWaitMs: 5_000 },
              routing: { sessionId: "queue", boundary: "new-task" },
            }),
          ),
          { startImmediately: true },
        );
        yield* Effect.sleep("30 millis");
        assert.ok(events.includes("queued"));
        yield* Fiber.interrupt(blocker);
        yield* Fiber.interrupt(waiter);
      }).pipe(Effect.provide(layer)),
    );
  });
});

it("holds a session lock through streaming and releases it on cancellation", async () => {
  const layer = modelRouterLayer({
    catalogue: [{ ...localQwen, capacity: { maxParallel: 2, reservedInteractiveSlots: 0 } }],
    catalogueVersion: "stream-lock",
    classify: () => Effect.succeed(classifyAs(easyLocalCoding)),
    lockWaitMs: 5,
    fetch: async (url, init) => {
      if (String(url).includes("/health")) return Response.json({ status: "ok" });
      if (String(url).includes("/slots")) return Response.json([{ is_processing: false }]);
      if (JSON.parse(String(init?.body)).stream)
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode('data: {"choices":[{"delta":{"content":"first"}}]}\n\n'),
              );
            },
          }),
        );
      return Response.json(completionBody);
    },
  });
  await Effect.runPromise(
    Effect.gen(function* () {
      const router = yield* ModelRouter;
      const first = yield* router.stream(
        work({ stream: true, routing: { sessionId: "locked", boundary: "new-task" } }),
      );
      // Both identities hashed to stripe 103 under the former 128-stripe lock table.
      const unrelated = yield* router.complete(
        work({
          requestId: "unrelated",
          routing: { sessionId: "session-418", boundary: "new-task" },
        }),
      );
      assert.equal(unrelated.headers.deploymentId, localQwen.id);
      const blocked = yield* router
        .complete(work({ routing: { sessionId: "locked", boundary: "continue" } }))
        .pipe(Effect.result);
      assert.equal(blocked._tag, "Failure");
      if (blocked._tag === "Failure") assert.equal(blocked.failure._tag, "LockTimeout");
      yield* Effect.promise(() => first.body.cancel());
      const next = yield* router.complete(
        work({ routing: { sessionId: "locked", boundary: "continue" } }),
      );
      assert.equal(next.accounting.reuse, "session");
    }).pipe(Effect.provide(layer)),
  );
});

it("does not treat an unavailable local runtime as verified saturation", async () => {
  let generations = 0;
  const original = fakeFetch();
  const layer = modelRouterLayer({
    catalogue: [localQwen, cloudGlm],
    catalogueVersion: "v1",
    classify: () => Effect.succeed(classifyAs(hardCoding)),
    unavailable: new Set([localQwen.id]),
    saturation: () => ({ verified: false, saturated: false }),
    fetch: async (url, init) => {
      if (String(url).includes("completions")) generations++;
      return original(url, init);
    },
  });
  const outcome = await Effect.runPromise(
    ModelRouter.use((router) =>
      router.complete(
        work({
          policy: { ...balancedPolicy, localityBias: 1, maxWaitMs: 0 },
          routing: { sessionId: "local-required", boundary: "new-task" },
        }),
      ),
    ).pipe(Effect.result, Effect.provide(layer)),
  );
  assert.equal(outcome._tag, "Failure");
  assert.equal(generations, 0);
});

it("continues a cloud pin without incorrectly applying new-task local preference", async () => {
  const policy = {
    ...balancedPolicy,
    localityBias: 0.1,
    bias: { cost: 0.1, quality: 1, latency: 0.1 },
  };
  const layer = modelRouterLayer({
    catalogue: [localQwen, cloudGlm],
    catalogueVersion: "v1",
    classify: () => Effect.succeed(classifyAs(easyLocalCoding)),
    fetch: fakeFetch(),
  });
  await Effect.runPromise(
    Effect.gen(function* () {
      const router = yield* ModelRouter;
      const first = yield* router.complete(
        work({ policy, routing: { sessionId: "cloud-pinned", boundary: "new-task" } }),
      );
      assert.equal(first.headers.deploymentId, "cloud-glm");
      const next = yield* router.complete(
        work({ policy, routing: { sessionId: "cloud-pinned", boundary: "continue" } }),
      );
      assert.equal(next.headers.deploymentId, first.headers.deploymentId);
      assert.equal(next.accounting.reuse, "session");
    }).pipe(Effect.provide(layer)),
  );
});

it("never sends prompts to a cloud deployment with missing required credentials", async () => {
  const contacted: string[] = [];
  const original = fakeFetch();
  const layer = modelRouterLayer({
    catalogue: [localQwen, { ...cloudGlm, credentialEnvVar: "REQUIRED_CLOUD_KEY" }],
    catalogueVersion: "v1",
    credentials: () => undefined,
    classify: () => Effect.succeed(classifyAs(easyLocalCoding)),
    fetch: async (url, init) => {
      contacted.push(String(url));
      return original(url, init);
    },
  });
  const result = await Effect.runPromise(
    ModelRouter.use((router) =>
      router.complete(
        work({
          policy: {
            ...balancedPolicy,
            localityBias: 0.1,
            bias: { cost: 0.1, quality: 1, latency: 0.1 },
          },
          routing: { sessionId: "missing-credential", boundary: "new-task" },
        }),
      ),
    ).pipe(Effect.provide(layer)),
  );
  assert.equal(result.headers.deploymentId, localQwen.id);
  assert.equal(
    contacted.some((url) => url.includes("cloud-glm")),
    false,
  );
});
for (const mode of ["classifier", "rules"] as const) {
  describe(`${mode} capacity policy`, () => {
    it("reports local overload after the key wait budget without dispatching to cloud", async () => {
      const contacted: string[] = [];
      const reasons: string[] = [];
      const queueStates: Array<{ queued: boolean; waitedMs: number }> = [];
      const layer = modelRouterLayer({
        catalogue: [
          { ...localQwen, capacity: { maxParallel: 1, reservedInteractiveSlots: 0 } },
          cloudGlm,
        ],
        catalogueVersion: "overload-report",
        ...(mode === "rules"
          ? { mode }
          : { classify: () => Effect.succeed(classifyAs(easyLocalCoding)) }),
        onDecision: (decision) => {
          reasons.push(decision.reason);
          queueStates.push(decision.queue);
        },
        fetch: async (url, init) => {
          const address = String(url);
          if (address.includes("/slots")) return Response.json([{ is_processing: false }]);
          if (address.includes("/health")) return Response.json({ status: "ok" });
          contacted.push(address);
          if (JSON.parse(String(init?.body)).stream) {
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(
                    new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'),
                  );
                },
              }),
            );
          }
          return Response.json(completionBody);
        },
      });
      await Effect.runPromise(
        ModelRouter.use((router) =>
          Effect.gen(function* () {
            const held = yield* router.stream(
              work({ stream: true, routing: { sessionId: "held", boundary: "new-task" } }),
            );
            try {
              const started = Date.now();
              const outcome = yield* router
                .complete(
                  work({
                    policy: {
                      ...balancedPolicy,
                      overloadAction: "report",
                      localityBias: 1,
                      maxWaitMs: 35,
                    },
                    routing: { sessionId: "waiting", boundary: "new-task" },
                  }),
                )
                .pipe(Effect.result);
              assert.equal(outcome._tag, "Failure");
              if (outcome._tag === "Failure") assert.equal(outcome.failure._tag, "LocalOverloaded");
              assert.ok(Date.now() - started >= 25, "report must honor the wait budget");
              assert.equal(contacted.length, 1, "only the held local request reaches a provider");
              assert.equal(reasons.at(-1), "local-overloaded");
              assert.equal(queueStates.at(-1)?.queued, true);
              assert.ok((queueStates.at(-1)?.waitedMs ?? 0) >= 25);
            } finally {
              yield* Effect.promise(() => held.body.cancel());
            }
          }),
        ).pipe(Effect.provide(layer)),
      );
    });
    it("fails over immediately to eligible cloud when no local permit is available", async () => {
      const generations: string[] = [];
      const layer = modelRouterLayer({
        catalogue: [
          { ...localQwen, capacity: { maxParallel: 1, reservedInteractiveSlots: 0 } },
          cloudGlm,
        ],
        catalogueVersion: "overload-failover",
        ...(mode === "rules"
          ? { mode }
          : { classify: () => Effect.succeed(classifyAs(easyLocalCoding)) }),
        fetch: async (url, init) => {
          const address = String(url);
          if (address.includes("/slots")) return Response.json([{ is_processing: false }]);
          if (address.includes("/health")) return Response.json({ status: "ok" });
          generations.push(address);
          if (JSON.parse(String(init?.body)).stream) {
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(
                    new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'),
                  );
                },
              }),
            );
          }
          return Response.json(completionBody);
        },
      });
      await Effect.runPromise(
        ModelRouter.use((router) =>
          Effect.gen(function* () {
            const held = yield* router.stream(
              work({ stream: true, routing: { sessionId: "held", boundary: "new-task" } }),
            );
            try {
              const started = Date.now();
              const result = yield* router.complete(
                work({
                  policy: {
                    ...balancedPolicy,
                    overloadAction: "failover",
                    localityBias: 1,
                    maxWaitMs: 1_000,
                  },
                  routing: { sessionId: "fallback", boundary: "new-task" },
                }),
              );
              assert.equal(result.headers.deploymentId, cloudGlm.id);
              assert.equal(result.headers.queued, false);
              assert.equal(result.accounting.localComputeEstimatedUsd, null);
              assert.equal(result.decision.selectionReason.detail, "local-overload-failover");
              assert.equal(result.decision.reason, "local-overload-failover");
              assert.ok(Date.now() - started < 900, "failover must not wait for the local slot");
              assert.deepEqual(
                generations.map((address) => (address.includes(cloudGlm.id) ? "cloud" : "local")),
                ["local", "cloud"],
              );
            } finally {
              yield* Effect.promise(() => held.body.cancel());
            }
          }),
        ).pipe(Effect.provide(layer)),
      );
    });
  });
}
it("tries every eligible local permit before escalating to cloud", async () => {
  const primary = {
    ...localQwen,
    capacity: { maxParallel: 1, reservedInteractiveSlots: 0 },
    quality: { ...localQwen.quality, coding: 0.95 },
  };
  const secondary = {
    ...localQwen,
    id: "local-second",
    endpoint: "http://127.0.0.1:9/local-second",
    quality: { ...localQwen.quality, coding: 0.1 },
  };
  const contacted: string[] = [];
  const layer = modelRouterLayer({
    catalogue: [primary, cloudGlm, secondary],
    catalogueVersion: "all-locals",
    classify: () => Effect.succeed(classifyAs(easyLocalCoding)),
    fetch: async (url, init) => {
      const address = String(url);
      if (address.includes("/health")) return Response.json({ status: "ok" });
      if (address.includes("/slots")) return Response.json([{ is_processing: false }]);
      contacted.push(
        address.includes(secondary.id)
          ? secondary.id
          : address.includes(primary.id)
            ? primary.id
            : cloudGlm.id,
      );
      if (JSON.parse(String(init?.body)).stream)
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode('data: {"choices":[{"delta":{"content":"held"}}]}\n\n'),
              );
            },
          }),
        );
      return Response.json(completionBody);
    },
  });
  await Effect.runPromise(
    ModelRouter.use((router) =>
      Effect.gen(function* () {
        const policy = {
          ...balancedPolicy,
          overloadAction: "failover" as const,
          localityBias: 0.4,
          bias: { quality: 1, cost: 0, latency: 0 },
          maxWaitMs: 1_000,
        };
        const held = yield* router.stream(
          work({ stream: true, policy, routing: { sessionId: "primary", boundary: "new-task" } }),
        );
        try {
          assert.equal(held.headers.deploymentId, primary.id);
          const second = yield* router.complete(
            work({ policy, routing: { sessionId: "secondary", boundary: "new-task" } }),
          );
          assert.equal(second.headers.deploymentId, secondary.id);
          assert.deepEqual(contacted, [primary.id, secondary.id]);
        } finally {
          yield* Effect.promise(() => held.body.cancel());
        }
      }),
    ).pipe(Effect.provide(layer)),
  );
});
for (const mode of ["classifier", "rules"] as const) {
  describe(`${mode} Gufo admission safety`, () => {
    it("keeps flex local: retries refusals within the wait budget, never fails over", async () => {
      const local = {
        ...localQwen,
        transport: "gufo" as const,
        credentialEnvVar: "GUFO_KEY",
        modelId: "gufo-local",
      };
      const tiers: unknown[] = [];
      const contacts: string[] = [];
      const layer = modelRouterLayer({
        catalogue: [
          { ...local, capacity: { maxParallel: 1, reservedInteractiveSlots: 0 } },
          cloudGlm,
        ],
        catalogueVersion: "gufo-flex",
        ...(mode === "rules"
          ? { mode }
          : { classify: () => Effect.succeed(classifyAs(easyLocalCoding)) }),
        credentials: () => "fixture-key",
        fetch: async (url, init) => {
          const address = String(url);
          if (address.endsWith("/v1/runtime")) return new Response(null, { status: 404 });
          if (address.includes("/models")) return Response.json({ data: [{ id: local.modelId }] });
          contacts.push(address);
          tiers.push((JSON.parse(String(init?.body)) as Record<string, unknown>).service_tier);
          return Response.json(
            { error: { code: "resource_unavailable" } },
            { status: 429, headers: { "retry-after": "0" } },
          );
        },
      });
      await Effect.runPromise(
        ModelRouter.use((router) =>
          Effect.gen(function* () {
            const refused = yield* router
              .complete(
                work({
                  requestId: "flex",
                  serviceTier: "flex",
                  policy: {
                    ...balancedPolicy,
                    overloadAction: "failover",
                    localityBias: 1,
                    maxWaitMs: 600,
                  },
                  routing: { sessionId: "flex", boundary: "new-task" },
                }),
              )
              .pipe(Effect.result);
            assert.equal(refused._tag, "Failure");
            if (refused._tag === "Failure") {
              assert.equal(refused.failure._tag, "LocalOverloaded");
              if (refused.failure._tag === "LocalOverloaded")
                assert.equal(refused.failure.flexRefused, true);
            }
          }),
        ).pipe(Effect.provide(layer)),
      );
      // 600 ms of budget at the 250 ms retry floor: attempts at about 0, 250 and 500 ms.
      assert.ok(tiers.length >= 2 && tiers.length <= 3, `attempts: ${tiers.length}`);
      assert.ok(tiers.every((tier) => tier === "flex"));
      assert.equal(contacts.filter((address) => address.includes(cloudGlm.id)).length, 0);
    });

    it("admits a waiting flex request once Gufo has idle compute", async () => {
      const local = {
        ...localQwen,
        transport: "gufo" as const,
        credentialEnvVar: "GUFO_KEY",
        modelId: "gufo-local",
      };
      let attempts = 0;
      const layer = modelRouterLayer({
        catalogue: [{ ...local, capacity: { maxParallel: 1, reservedInteractiveSlots: 0 } }],
        catalogueVersion: "gufo-flex-admit",
        ...(mode === "rules"
          ? { mode }
          : { classify: () => Effect.succeed(classifyAs(easyLocalCoding)) }),
        credentials: () => "fixture-key",
        fetch: async (url) => {
          const address = String(url);
          if (address.endsWith("/v1/runtime")) return new Response(null, { status: 404 });
          if (address.includes("/models")) return Response.json({ data: [{ id: local.modelId }] });
          attempts += 1;
          if (attempts < 3)
            return Response.json(
              { error: { code: "resource_unavailable" } },
              { status: 429, headers: { "retry-after": "0" } },
            );
          return Response.json({ ...completionBody, model: local.modelId });
        },
      });
      const admitted = await Effect.runPromise(
        ModelRouter.use((router) =>
          router.complete(
            work({
              requestId: "flex-admit",
              serviceTier: "flex",
              policy: { ...balancedPolicy, priority: "low", localityBias: 1, maxWaitMs: 5_000 },
              routing: { sessionId: "flex-admit", boundary: "new-task" },
            }),
          ),
        ).pipe(Effect.provide(layer)),
      );
      assert.equal(attempts, 3);
      assert.equal(admitted.headers.deploymentId, local.id);
      assert.equal(admitted.headers.queued, true);
      assert.ok(admitted.headers.waitedMs >= 500);
    });

    it("handles Gufo pre-enqueue overload per key action and releases its permit", async () => {
      const local = {
        ...localQwen,
        transport: "gufo" as const,
        credentialEnvVar: "GUFO_KEY",
        modelId: "gufo-local",
      };
      const contacts: string[] = [];
      const layer = modelRouterLayer({
        catalogue: [
          { ...local, capacity: { maxParallel: 1, reservedInteractiveSlots: 0 } },
          cloudGlm,
        ],
        catalogueVersion: "gufo-overload",
        ...(mode === "rules"
          ? { mode }
          : { classify: () => Effect.succeed(classifyAs(easyLocalCoding)) }),
        credentials: () => "fixture-key",
        fetch: async (url) => {
          const address = String(url);
          if (address.endsWith("/v1/runtime")) return new Response(null, { status: 404 });
          if (address.includes("/models")) return Response.json({ data: [{ id: local.modelId }] });
          contacts.push(address);
          if (
            address.includes(local.id) &&
            contacts.filter((entry) => entry.includes(local.id)).length !== 2
          )
            return Response.json(
              { error: { code: "queue_full" } },
              { status: 429, headers: { "retry-after": "7" } },
            );
          return Response.json({ ...completionBody, model: local.modelId });
        },
      });
      await Effect.runPromise(
        ModelRouter.use((router) =>
          Effect.gen(function* () {
            const fallback = yield* router.complete(
              work({
                policy: {
                  ...balancedPolicy,
                  overloadAction: "failover",
                  localityBias: 1,
                  maxWaitMs: 1_000,
                },
                routing: { sessionId: "rejected", boundary: "new-task" },
              }),
            );
            assert.equal(fallback.headers.deploymentId, cloudGlm.id);
            assert.equal(fallback.decision.selectionReason.detail, "local-overload-failover");
            assert.equal(fallback.decision.reason, "local-overload-failover");
            const recovered = yield* router.complete(
              work({
                requestId: "recovered",
                policy: {
                  ...balancedPolicy,
                  overloadAction: "report",
                  localityBias: 1,
                  maxWaitMs: 0,
                },
                routing: { sessionId: "recovered", boundary: "new-task" },
              }),
            );
            assert.equal(recovered.headers.deploymentId, local.id);
            const reported = yield* router
              .complete(
                work({
                  requestId: "reported",
                  policy: {
                    ...balancedPolicy,
                    overloadAction: "report",
                    localityBias: 1,
                    maxWaitMs: 0,
                  },
                  routing: { sessionId: "reported", boundary: "new-task" },
                }),
              )
              .pipe(Effect.result);
            assert.equal(reported._tag, "Failure");
            if (reported._tag === "Failure") {
              assert.equal(reported.failure._tag, "LocalOverloaded");
              if (reported.failure._tag === "LocalOverloaded")
                assert.equal(reported.failure.retryAfterSeconds, 7);
            }
            assert.deepEqual(
              contacts.map((address) => (address.includes(local.id) ? "local" : "cloud")),
              ["local", "cloud", "local", "local"],
            );
          }),
        ).pipe(Effect.provide(layer)),
      );
    });
    it("reports overload rather than bypassing cloud authorization or hard constraints", async () => {
      const local = {
        ...localQwen,
        transport: "gufo" as const,
        credentialEnvVar: "GUFO_KEY",
        modelId: "gufo-local",
      };
      const cases: Array<{
        name: string;
        policy?: Partial<RouterWork["policy"]>;
        cloud?: Partial<typeof cloudGlm>;
        capabilities?: RouterWork["capabilities"];
      }> = [
        { name: "allowlist", policy: { allowedModels: [local.id] } },
        { name: "credential", cloud: { credentialEnvVar: "CLOUD_KEY" } },
        { name: "spend ceiling", policy: { maxEstimatedUsd: 0 } },
        {
          name: "unknown pricing",
          policy: { maxEstimatedUsd: 1 },
          cloud: {
            prices: {
              ...cloudGlm.prices,
              provenance: { ...cloudGlm.prices.provenance, source: "unknown" },
            },
          },
        },
        {
          name: "capabilities",
          cloud: { capabilities: { tools: false, json: true, vision: false } },
          capabilities: { tools: true, json: false, vision: false },
        },
        { name: "context", cloud: { contextLimitTokens: 8_192 } },
        { name: "output", cloud: { maxOutputTokens: 8_000 } },
      ];
      for (const testCase of cases) {
        const contacted: string[] = [];
        const reasons: string[] = [];
        const layer = modelRouterLayer({
          catalogue: [local, { ...cloudGlm, ...testCase.cloud }],
          catalogueVersion: "constraints-" + testCase.name,
          ...(mode === "rules"
            ? { mode }
            : { classify: () => Effect.succeed(classifyAs(easyLocalCoding)) }),
          onDecision: (decision) => {
            reasons.push(decision.reason);
          },
          credentials: (envVar) => (envVar === "GUFO_KEY" ? "fixture-key" : undefined),
          fetch: async (url) => {
            const address = String(url);
            if (address.endsWith("/v1/runtime")) return new Response(null, { status: 404 });
            if (address.includes("/models"))
              return Response.json({ data: [{ id: local.modelId }] });
            contacted.push(address);
            if (address.includes(local.id))
              return Response.json({ error: { code: "client_queue_full" } }, { status: 429 });
            throw new Error("ineligible cloud was contacted");
          },
        });
        const outcome = await Effect.runPromise(
          ModelRouter.use((router) =>
            router
              .complete(
                work({
                  policy: {
                    ...balancedPolicy,
                    overloadAction: "failover",
                    localityBias: 1,
                    ...testCase.policy,
                  },
                  capabilities: testCase.capabilities ?? {
                    tools: false,
                    json: false,
                    vision: false,
                  },
                  routing: { sessionId: "constraint", boundary: "new-task" },
                }),
              )
              .pipe(Effect.result),
          ).pipe(Effect.provide(layer)),
        );
        assert.equal(outcome._tag, "Failure", testCase.name);
        if (outcome._tag === "Failure")
          assert.equal(outcome.failure._tag, "LocalOverloaded", testCase.name);
        assert.equal(reasons.at(-1), "local-overloaded", testCase.name);
        assert.deepEqual(contacted, [local.endpoint + "/v1/chat/completions"], testCase.name);
      }
    });
    it("never treats a generic provider failure as a pre-enqueue overload", async () => {
      const local = {
        ...localQwen,
        transport: "gufo" as const,
        credentialEnvVar: "GUFO_KEY",
        modelId: "gufo-local",
      };
      const contacted: string[] = [];
      const layer = modelRouterLayer({
        catalogue: [local, cloudGlm],
        catalogueVersion: "no-replay",
        ...(mode === "rules"
          ? { mode }
          : { classify: () => Effect.succeed(classifyAs(easyLocalCoding)) }),
        credentials: () => "fixture-key",
        fetch: async (url) => {
          const address = String(url);
          if (address.endsWith("/v1/runtime")) return new Response(null, { status: 404 });
          if (address.includes("/models")) return Response.json({ data: [{ id: local.modelId }] });
          contacted.push(address);
          return Response.json({ error: { code: "other_failure" } }, { status: 503 });
        },
      });
      const outcome = await Effect.runPromise(
        ModelRouter.use((router) =>
          router
            .complete(
              work({
                policy: { ...balancedPolicy, overloadAction: "failover", localityBias: 1 },
                routing: { sessionId: "failed", boundary: "new-task" },
              }),
            )
            .pipe(Effect.result),
        ).pipe(Effect.provide(layer)),
      );
      assert.equal(outcome._tag, "Failure");
      if (outcome._tag === "Failure") assert.equal(outcome.failure._tag, "ProviderFailure");
      assert.deepEqual(contacted, [local.endpoint + "/v1/chat/completions"]);
    });
    it("streams from cloud after Gufo rejects before enqueue and pins that route", async () => {
      const local = {
        ...localQwen,
        transport: "gufo" as const,
        credentialEnvVar: "GUFO_KEY",
        modelId: "gufo-local",
      };
      const contacts: string[] = [];
      const layer = modelRouterLayer({
        catalogue: [
          { ...local, capacity: { maxParallel: 1, reservedInteractiveSlots: 0 } },
          cloudGlm,
        ],
        catalogueVersion: "stream-failover",
        ...(mode === "rules"
          ? { mode }
          : { classify: () => Effect.succeed(classifyAs(easyLocalCoding)) }),
        credentials: () => "fixture-key",
        fetch: async (url, init) => {
          const address = String(url);
          if (address.endsWith("/v1/runtime")) return new Response(null, { status: 404 });
          if (address.includes("/models")) return Response.json({ data: [{ id: local.modelId }] });
          contacts.push(address.includes(local.id) ? "local" : "cloud");
          if (address.includes(local.id))
            return Response.json({ error: { code: "queue_full" } }, { status: 429 });
          if (JSON.parse(String(init?.body)).stream)
            return new Response(
              'data: {"choices":[{"delta":{"content":"cloud"}}]}\n\ndata: [DONE]\n\n',
              { headers: { "content-type": "text/event-stream" } },
            );
          return Response.json(completionBody);
        },
      });
      await Effect.runPromise(
        ModelRouter.use((router) =>
          Effect.gen(function* () {
            const policy = {
              ...balancedPolicy,
              overloadAction: "failover" as const,
              localityBias: 1,
            };
            const streamed = yield* router.stream(
              work({
                stream: true,
                policy,
                routing: { sessionId: "stream-fallback", boundary: "new-task" },
              }),
            );
            assert.equal(streamed.headers.deploymentId, cloudGlm.id);
            assert.equal(streamed.decision.selectionReason.detail, "local-overload-failover");
            assert.equal(streamed.decision.reason, "local-overload-failover");
            assert.match(yield* Effect.promise(() => new Response(streamed.body).text()), /cloud/);
            const continued = yield* router.complete(
              work({
                requestId: "continued",
                policy,
                routing: { sessionId: "stream-fallback", boundary: "continue" },
              }),
            );
            assert.equal(continued.headers.deploymentId, cloudGlm.id);
            assert.deepEqual(contacts, ["local", "cloud", "cloud"]);
          }),
        ).pipe(Effect.provide(layer)),
      );
    });
    it("keeps a continued local session pinned when Gufo rejects before enqueue", async () => {
      const local = {
        ...localQwen,
        transport: "gufo" as const,
        credentialEnvVar: "GUFO_KEY",
        modelId: "gufo-local",
      };
      const contacts: string[] = [];
      const layer = modelRouterLayer({
        catalogue: [local, cloudGlm],
        catalogueVersion: "continued-overload",
        ...(mode === "rules"
          ? { mode }
          : { classify: () => Effect.succeed(classifyAs(easyLocalCoding)) }),
        credentials: () => "fixture-key",
        fetch: async (url) => {
          const address = String(url);
          if (address.endsWith("/v1/runtime")) return new Response(null, { status: 404 });
          if (address.includes("/models")) return Response.json({ data: [{ id: local.modelId }] });
          contacts.push(address.includes(local.id) ? "local" : "cloud");
          if (contacts.length === 1)
            return Response.json({ ...completionBody, model: local.modelId });
          return Response.json({ error: { code: "queue_full" } }, { status: 429 });
        },
      });
      await Effect.runPromise(
        ModelRouter.use((router) =>
          Effect.gen(function* () {
            const policy = {
              ...balancedPolicy,
              overloadAction: "failover" as const,
              localityBias: 1,
            };
            yield* router.complete(
              work({ policy, routing: { sessionId: "pinned-local", boundary: "new-task" } }),
            );
            const continued = yield* router
              .complete(
                work({
                  requestId: "continue",
                  policy,
                  routing: { sessionId: "pinned-local", boundary: "continue" },
                }),
              )
              .pipe(Effect.result);
            assert.equal(continued._tag, "Failure");
            if (continued._tag === "Failure")
              assert.equal(continued.failure._tag, "LocalOverloaded");
            assert.deepEqual(contacts, ["local", "local"]);
          }),
        ).pipe(Effect.provide(layer)),
      );
    });
  });
}
describe("ModelRouter batch seam", () => {
  it("rules completes local batch work and plans cloud spill without assessment or provider submission", async () => {
    let generations = 0;
    const layer = modelRouterLayer({
      mode: "rules",
      catalogue: [localQwen, cloudGlm],
      catalogueVersion: "rules-batch",
      fetch: async (url, init) => {
        if (init?.method === "POST") generations++;
        return fakeFetch()(url, init);
      },
    });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const router = yield* ModelRouter;
        const local = yield* router.completeBatch(
          work({ routing: { sessionId: "batch-rules", boundary: "new-task" } }),
          "auto",
        );
        const spill = yield* router.planBatchSpill(
          work({ routing: { sessionId: "spill-rules", boundary: "new-task" } }),
          [frontier],
          "auto",
        );
        return { local, spill };
      }).pipe(Effect.provide(layer)),
    );
    assert.equal(result.local.headers.deploymentId, localQwen.id);
    assert.equal(result.local.accounting.classifierBackend, null);
    assert.equal(result.spill.deployment.id, frontier.id);
    assert.equal(result.spill.metadata.classifierBackend, null);
    assert.equal(result.spill.metadata.selectionReasonCode, "deterministic-rules");
    assert.equal(generations, 1);
  });
  it("keeps batch completion local even when sync cloud is configured", async () => {
    const contacted: string[] = [];
    const layer = modelRouterLayer({
      catalogue: [localQwen, cloudGlm],
      catalogueVersion: "batch-local",
      classify: () => Effect.succeed(classifyAs(easyLocalCoding)),
      fetch: async (url, init) => {
        contacted.push(String(url));
        return fakeFetch()(url, init);
      },
    });
    const result = await Effect.runPromise(
      ModelRouter.use((router) =>
        router.completeBatch(
          batchWork({ routing: { sessionId: "batch-local", boundary: "new-task" } }),
          "auto",
        ),
      ).pipe(Effect.provide(layer)),
    );
    assert.equal(result.headers.deploymentId, localQwen.id);
    assert.equal(
      contacted.some((url) => url.includes(cloudGlm.id)),
      false,
    );
  });

  it("blocks batch permit acquisition while foreground work is still classifying", async () => {
    let classifierGate: Deferred.Deferred<void> | undefined;
    let classifierStarted: Deferred.Deferred<void> | undefined;
    let classifyCalls = 0;
    const layer = modelRouterLayer({
      catalogue: [localQwen, cloudGlm],
      catalogueVersion: "batch-race",
      classify: () => {
        classifyCalls += 1;
        if (classifyCalls === 1) {
          return Effect.gen(function* () {
            yield* Deferred.succeed(classifierStarted!, undefined);
            yield* Deferred.await(classifierGate!);
            return classifyAs(easyLocalCoding);
          });
        }
        return Effect.succeed(classifyAs(easyLocalCoding));
      },
      fetch: fakeFetch(),
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        classifierGate = yield* Deferred.make<void>();
        classifierStarted = yield* Deferred.make<void>();
        const router = yield* ModelRouter;
        const blocker = yield* Effect.forkChild(
          router.complete(work({ routing: { sessionId: "classifying", boundary: "new-task" } })),
          { startImmediately: true },
        );
        yield* Deferred.await(classifierStarted!);
        const blocked = yield* router
          .completeBatch(
            batchWork({
              requestId: "batch-race",
              routing: { sessionId: "batch", boundary: "new-task" },
            }),
            "auto",
          )
          .pipe(Effect.result);
        assert.equal(blocked._tag, "Failure");
        if (blocked._tag === "Failure") assert.equal(blocked.failure._tag, "CapacityBusy");
        yield* Fiber.interrupt(blocker);
      }).pipe(Effect.provide(layer)),
    );
  });

  it("does not let an interactive queue admit batch work", async () => {
    const layer = modelRouterLayer({
      catalogue: [{ ...localQwen, capacity: { maxParallel: 1, reservedInteractiveSlots: 0 } }],
      catalogueVersion: "batch-queue",
      classify: () => Effect.succeed(classifyAs(easyLocalCoding)),
      fetch: hangingFetch(),
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const router = yield* ModelRouter;
        const blocker = yield* Effect.forkChild(
          router.complete(
            work({
              policy: { ...balancedPolicy, priority: "high", maxWaitMs: 0 },
              routing: { sessionId: "batch-blocker", boundary: "new-task" },
            }),
          ),
          { startImmediately: true },
        );
        yield* Effect.sleep("20 millis");
        const queued = yield* Effect.forkChild(
          router.complete(
            work({
              requestId: "interactive-queued",
              policy: { ...balancedPolicy, priority: "low", maxWaitMs: 5_000 },
              routing: { sessionId: "interactive-queued", boundary: "new-task" },
            }),
          ),
          { startImmediately: true },
        );
        yield* Effect.sleep("30 millis");
        const blocked = yield* router
          .completeBatch(
            batchWork({
              requestId: "batch-queued",
              routing: { sessionId: "batch-queued", boundary: "new-task" },
            }),
            "auto",
          )
          .pipe(Effect.result);
        assert.equal(blocked._tag, "Failure");
        if (blocked._tag === "Failure") assert.equal(blocked.failure._tag, "CapacityBusy");
        yield* Fiber.interrupt(blocker);
        yield* Fiber.interrupt(queued);
      }).pipe(Effect.provide(layer)),
    );
  });

  it("releases a cancelled batch permit for the next foreground request", async () => {
    const layer = modelRouterLayer({
      catalogue: [{ ...localQwen, capacity: { maxParallel: 1, reservedInteractiveSlots: 0 } }],
      catalogueVersion: "batch-cancel",
      classify: () => Effect.succeed(classifyAs(easyLocalCoding)),
      fetch: hangingFetch(),
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const router = yield* ModelRouter;
        const batch = yield* Effect.forkChild(
          router.completeBatch(
            batchWork({ routing: { sessionId: "batch-cancel", boundary: "new-task" } }),
            "auto",
          ),
          { startImmediately: true },
        );
        yield* Effect.sleep("30 millis");
        yield* Fiber.interrupt(batch);
        const next = yield* router.complete(
          work({ routing: { sessionId: "foreground-after-batch", boundary: "new-task" } }),
        );
        assert.equal(next.headers.deploymentId, localQwen.id);
      }).pipe(Effect.provide(layer)),
    );
  });

  it("refuses unqualified, forbidden, and over-budget spill plans before provider calls", async () => {
    let requests = 0;
    const fetchImpl = async (url: string | URL, init?: RequestInit) => {
      requests += 1;
      return fakeFetch()(url, init);
    };
    const unqualifiedLayer = modelRouterLayer({
      catalogue: [localQwen],
      catalogueVersion: "spill-unqualified",
      classify: () =>
        Effect.fail(
          new ClassifierUnqualified({ message: "qualification required", reason: "missing" }),
        ),
      fetch: fetchImpl,
    });
    const unqualified = await Effect.runPromise(
      ModelRouter.use((router) =>
        router.planBatchSpill(
          batchWork({ routing: { sessionId: "spill-u", boundary: "new-task" } }),
          [frontier],
          "auto",
        ),
      ).pipe(Effect.result, Effect.provide(unqualifiedLayer)),
    );
    assert.equal(unqualified._tag, "Failure");
    assert.equal(requests, 0);

    const layer = modelRouterLayer({
      catalogue: [localQwen],
      catalogueVersion: "spill-policy",
      classify: () => Effect.succeed(classifyAs(easyLocalCoding)),
      fetch: fetchImpl,
    });
    const forbidden = await Effect.runPromise(
      ModelRouter.use((router) =>
        router.planBatchSpill(
          batchWork({
            policy: { ...balancedPolicy, allowedModels: [localQwen.id] },
            routing: { sessionId: "spill-f", boundary: "new-task" },
          }),
          [frontier],
          "auto",
        ),
      ).pipe(Effect.result, Effect.provide(layer)),
    );
    assert.equal(forbidden._tag, "Failure");
    const overBudget = await Effect.runPromise(
      ModelRouter.use((router) =>
        router.planBatchSpill(
          batchWork({
            policy: { ...balancedPolicy, maxEstimatedUsd: 0 },
            routing: { sessionId: "spill-b", boundary: "new-task" },
          }),
          [frontier],
          "auto",
        ),
      ).pipe(Effect.result, Effect.provide(layer)),
    );
    assert.equal(overBudget._tag, "Failure");
    assert.equal(requests, 0);
  });
});
it(
  "verifies pinned OpenRouter provider via generation metadata after each completion",
  { timeout: 5000 },
  async () => {
    const provider = { ...frontier, providerRestriction: "inference-net" };
    const cases = [
      { responseProvider: "InferenceNet", actual: "InferenceNet", cached: 0, expected: "match" },
      {
        responseProvider: "InferenceNet",
        actual: "other-provider\nprivate",
        cached: 12,
        expected: "mismatch",
      },
      { responseProvider: undefined, actual: "InferenceNet", cached: undefined, expected: "match" },
      { responseProvider: undefined, actual: undefined, cached: undefined, expected: "unknown" },
    ] as const;
    const warnings = mock.method(console, "warn", () => undefined);
    try {
      for (const streaming of [false, true]) {
        for (const [index, scenario] of cases.entries()) {
          const reports: Array<{ deployment: string; result: string }> = [];
          const sent: Record<string, unknown>[] = [];
          const lookups: string[] = [];
          const verified = Promise.withResolvers<void>();
          const usage = {
            prompt_tokens: 60,
            completion_tokens: 8,
            ...(scenario.cached === undefined
              ? {}
              : { prompt_tokens_details: { cached_tokens: scenario.cached } }),
          };
          const fetchImpl: typeof fetch = async (input, init) => {
            const url = String(input);
            if (url.includes("/generation?")) {
              lookups.push(url);
              assert.equal(
                init?.headers && (init.headers as Record<string, string>).authorization,
                "Bearer fixture-key",
              );
              return Response.json({
                data: { provider_name: scenario.actual, cache_discount: 0.002 },
              });
            }
            sent.push(JSON.parse(String(init?.body)));
            if (!streaming)
              return Response.json({
                id: `gen-${index}`,
                provider: scenario.responseProvider,
                choices: [
                  { message: { role: "assistant", content: "done" }, finish_reason: "stop" },
                ],
                usage,
              });
            const chunks = [
              {
                id: `gen-${index}`,
                provider: scenario.responseProvider,
                choices: [{ delta: { content: "done" } }],
              },
              { choices: [{ delta: {}, finish_reason: "stop" }] },
              { usage, choices: [] },
            ];
            return new Response(
              chunks.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") +
                "data: [DONE]\n\n",
              {
                headers: { "content-type": "text/event-stream" },
              },
            );
          };
          const verifyPin = createOpenRouterPinVerifier({
            fetchImpl,
            credential: () => "fixture-key",
            stopping: () => false,
            delayMs: 0,
            onVerified: (deployment, result) => {
              reports.push({ deployment, result });
              verified.resolve();
            },
          });
          const layer = modelRouterLayer({
            catalogue: [provider],
            catalogueVersion: "pinned",
            classify: () => Effect.succeed(classifyAs(hardCoding)),
            onOpenRouterCompleted: verifyPin,
            fetch: fetchImpl,
          });
          let accounting: RequestAccounting;
          if (streaming) {
            const result = await Effect.runPromise(
              ModelRouter.use((router) =>
                router.stream(
                  work({
                    routing: { sessionId: `stream-${index}`, boundary: "new-task" },
                    stream: true,
                    policy: { ...balancedPolicy, maxEstimatedUsd: 1 },
                  }),
                ),
              ).pipe(Effect.provide(layer)),
            );
            await new Response(result.body).text();
            accounting = result.accounting;
          } else {
            const result = await Effect.runPromise(
              ModelRouter.use((router) =>
                router.complete(
                  work({
                    routing: { sessionId: `complete-${index}`, boundary: "new-task" },
                    policy: { ...balancedPolicy, maxEstimatedUsd: 1 },
                  }),
                ),
              ).pipe(Effect.provide(layer)),
            );
            accounting = result.accounting;
          }
          await verified.promise;
          assert.deepEqual(reports, [{ deployment: "frontier", result: scenario.expected }]);
          assert.deepEqual(
            lookups.map((url) => new URL(url).searchParams.get("id")),
            [`gen-${index}`],
          );
          assert.equal(accounting.promptTokens, 60);
          assert.equal(accounting.cachedInputTokens, scenario.cached ?? null);
          assert.deepEqual(sent[0]?.provider, {
            only: ["inference-net"],
            allow_fallbacks: false,
            require_parameters: true,
          });
        }
      }
      assert.equal(warnings.mock.callCount(), 2);
      for (const call of warnings.mock.calls) {
        const warning = String(call.arguments[0]);
        assert.match(warning, /frontier.*other-provider/);
        assert.equal(warning.includes("\n"), false);
        assert.equal(warning.includes("private"), false);
      }
    } finally {
      warnings.mock.restore();
    }
  },
);
