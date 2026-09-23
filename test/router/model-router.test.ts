import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Deferred, Effect, Fiber } from "effect";
import { ClassifierUnqualified } from "../../src/errors.ts";
import { modelRouterLayer, ModelRouter } from "../../src/router/model-router.ts";
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

function classifyAs(assessment: Classification["assessment"]) {
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
describe("ModelRouter batch seam", () => {
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
