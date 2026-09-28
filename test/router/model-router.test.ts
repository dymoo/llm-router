import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { Effect, Exit, Fiber, Layer } from "effect";
import type { Deployment, RequestAccounting } from "../../src/domain.ts";
import { GATEWAY_EFFECT_TIMEOUT_MS } from "../../src/http/limits.ts";
import { createOpenRouterPinVerifier } from "../../src/router/adapters/openrouter.ts";
import { FLEX_MAX_WAIT_MS, LOCAL_WAIT_MS } from "../../src/router/capacity.ts";
import {
  ModelRouter,
  modelRouterLayer,
  type RouterOptions,
  type RouterWork,
} from "../../src/router/model-router.ts";
import {
  backgroundPolicy,
  cloudGlm,
  frontier,
  interactivePolicy,
  localQwen,
  standardPolicy,
} from "./fixtures.ts";

const completionBody = (model: string) => ({
  id: "cmpl",
  model,
  choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 12, completion_tokens: 8 },
});

/** A Gufo deployment at http://127.0.0.1:9/<id>, answering under model `<id>-model`. */
function gufo(id: string, extra: Partial<Deployment> = {}): Deployment {
  return {
    ...localQwen,
    id,
    modelId: `${id}-model`,
    endpoint: `http://127.0.0.1:9/${id}`,
    transport: "gufo",
    credentialEnvVar: "GUFO_KEY",
    capacity: { maxParallel: 1, reservedInteractiveSlots: 0 },
    ...extra,
  };
}

type Generation = { id: string; body: Record<string, unknown> };

/**
 * One fake network: health probes answer from `down`, `/v1/runtime` reports
 * `flexLimit`, and every generation goes to `generate` (default: success).
 */
function network(options: {
  down?: ReadonlySet<string>;
  flexLimit?: number;
  generate?: (call: Generation) => Response | Promise<Response>;
}) {
  const generations: Generation[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const id = url.split("/")[3]!;
    if (init?.method === "GET") {
      if (options.down?.has(id)) return new Response(null, { status: 503 });
      if (url.endsWith("/v1/runtime"))
        return options.flexLimit === undefined
          ? new Response(null, { status: 404 })
          : Response.json({ contract_version: 1, sessions: { flex_limit: options.flexLimit } });
      if (url.endsWith("/v1/models")) return Response.json({ data: [{ id: `${id}-model` }] });
      return Response.json({ status: "ok" });
    }
    const call = { id, body: JSON.parse(String(init?.body)) as Record<string, unknown> };
    generations.push(call);
    if (options.generate !== undefined) return options.generate(call);
    return Response.json(completionBody(String(call.body.model)));
  };
  return { fetchImpl, generations };
}

const refuse = (code: string, retryAfter = "0") =>
  Response.json({ error: { code } }, { status: 429, headers: { "retry-after": retryAfter } });

function work(partial: Partial<RouterWork> = {}): RouterWork {
  return {
    requestId: partial.requestId ?? "req-1",
    keyId: partial.keyId ?? "key-1",
    policy: partial.policy ?? standardPolicy,
    messages: partial.messages ?? [{ role: "user", content: "hi" }],
    inputTokens: partial.inputTokens ?? 40,
    capabilities: partial.capabilities ?? { tools: false, json: false, vision: false },
    stream: false,
    ...partial,
  };
}

function layer(options: Partial<RouterOptions> & Pick<RouterOptions, "catalogue">) {
  return modelRouterLayer({
    catalogueVersion: "test",
    credentials: () => "fixture-key",
    ...options,
  });
}

const run = <A, E>(
  effect: Effect.Effect<A, E, ModelRouter>,
  routerLayer: Layer.Layer<ModelRouter>,
): Promise<A> => Effect.runPromise(Effect.provide(effect, routerLayer));

/** A streaming generation that stays open until cancelled: holds its permit and slot. */
const openStream = (call: Generation) =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({ model: call.body.model, choices: [{ delta: { content: "held" } }] })}\n\n`,
          ),
        );
      },
    }),
  );

/** Streams stay open; everything else completes. */
const holdStreams = (call: Generation) =>
  call.body.stream === true
    ? openStream(call)
    : Response.json(completionBody(String(call.body.model)));

describe("default tier (high, medium)", () => {
  it("runs on Gufo first, with no queue and the cheapest effort by default", async () => {
    const local = gufo("gufo-a");
    const net = network({});
    const result = await run(
      ModelRouter.use((router) => router.complete(work({ policy: interactivePolicy }))),
      layer({ catalogue: [cloudGlm, local], fetch: net.fetchImpl }),
    );
    assert.equal(result.headers.deploymentId, local.id);
    assert.equal(result.headers.queued, false);
    assert.equal(result.headers.requestedEffort, "none");
    assert.equal(result.decision.reason, "local-preference");
    assert.deepEqual(
      net.generations.map((call) => call.id),
      [local.id],
    );
    assert.equal(net.generations[0]?.body.service_tier, undefined);
    assert.equal(result.accounting.classifierBackend, null);
  });

  it("maps reasoning_effort onto the chosen deployment's levels", async () => {
    const local = gufo("gufo-a", {
      reasoning: { kind: "graded", levels: ["none", "low", "medium"] },
    });
    const net = network({});
    const result = await run(
      ModelRouter.use((router) => router.complete(work({ reasoningEffort: "xhigh" }))),
      layer({ catalogue: [local], fetch: net.fetchImpl }),
    );
    assert.equal(result.headers.requestedEffort, "xhigh");
    assert.equal(result.headers.appliedEffort, "medium");
    assert.equal(net.generations[0]?.body.reasoning_effort, "medium");
  });

  for (const cloud of [true, false]) {
    it(`waits the priority's budget for a local permit, then ${cloud ? "goes to cloud" : "fails 503"}`, async () => {
      const local = gufo("gufo-a");
      const net = network({ generate: holdStreams });
      const events: string[] = [];
      const routerLayer = layer({
        catalogue: [local, cloudGlm],
        fetch: net.fetchImpl,
        waitMs: { medium: 150 },
        onQueue: (event) => events.push(event.state),
      });
      const policy = { ...standardPolicy, cloud };
      const outcome = await run(
        ModelRouter.use((router) =>
          Effect.gen(function* () {
            const held = yield* router.stream(work({ requestId: "held", stream: true, policy }));
            const started = Date.now();
            const second = yield* router
              .complete(work({ requestId: "second", policy }))
              .pipe(Effect.exit);
            const waited = Date.now() - started;
            yield* Effect.promise(() => held.body.cancel());
            return { second, waited };
          }),
        ),
        routerLayer,
      );
      assert.ok(outcome.waited >= 140, `waited ${outcome.waited} ms`);
      assert.ok(events.includes("queued"));
      if (cloud) {
        assert.ok(Exit.isSuccess(outcome.second));
        assert.equal(outcome.second.value.headers.deploymentId, cloudGlm.id);
        assert.equal(outcome.second.value.headers.queued, true);
        assert.equal(outcome.second.value.decision.reason, "local-overload-failover");
      } else {
        assert.ok(Exit.isFailure(outcome.second));
        const error = Exit.isFailure(outcome.second) ? outcome.second.cause : undefined;
        assert.match(String(error), /LocalOverloaded/);
        assert.equal(
          net.generations.some((call) => call.id === cloudGlm.id),
          false,
        );
      }
    });
  }

  it("uses the named wait budgets: high 5 s, medium 30 s", () => {
    assert.deepEqual(LOCAL_WAIT_MS, { high: 5_000, medium: 30_000 });
  });

  it("retries a Gufo pre-enqueue refusal after its Retry-After within the budget", async () => {
    const local = gufo("gufo-a");
    let attempts = 0;
    const net = network({
      generate: (call) =>
        ++attempts < 3
          ? refuse("queue_full", "0")
          : Response.json(completionBody(String(call.body.model))),
    });
    const events: string[] = [];
    const result = await run(
      ModelRouter.use((router) => router.complete(work({ policy: interactivePolicy }))),
      layer({
        catalogue: [local, cloudGlm],
        fetch: net.fetchImpl,
        onQueue: (event) => events.push(event.state),
      }),
    );
    assert.equal(attempts, 3);
    assert.equal(result.headers.deploymentId, local.id);
    assert.equal(result.headers.queued, true);
    assert.ok(result.headers.waitedMs >= 450, `waited ${result.headers.waitedMs}`);
    assert.equal(result.decision.reason, "queue-admitted");
    assert.ok(events.filter((state) => state === "queued").length >= 2);
  });

  it("does not wait past the budget for a long Retry-After: cloud, or 503 carrying it", async () => {
    const local = gufo("gufo-a");
    for (const cloud of [true, false]) {
      const net = network({
        generate: (call) =>
          call.id === local.id
            ? refuse("queue_full", "301")
            : Response.json(completionBody(String(call.body.model))),
      });
      const exit = await run(
        ModelRouter.use((router) =>
          router.complete(work({ policy: { ...interactivePolicy, cloud } })).pipe(Effect.exit),
        ),
        layer({ catalogue: [local, cloudGlm], fetch: net.fetchImpl }),
      );
      if (cloud) {
        assert.ok(Exit.isSuccess(exit));
        assert.equal(exit.value.headers.deploymentId, cloudGlm.id);
      } else {
        assert.ok(Exit.isFailure(exit));
        const failure = exit.cause.reasons[0];
        assert.equal(failure?._tag, "Fail");
        const error = failure?._tag === "Fail" ? failure.error : undefined;
        assert.equal(error?._tag, "LocalOverloaded");
        if (error?._tag === "LocalOverloaded") {
          assert.equal(error.retryAfterSeconds, 301);
          assert.equal(error.flexRefused, undefined);
        }
      }
      assert.equal(net.generations.filter((call) => call.id === local.id).length, 1);
    }
  });

  it("goes straight to cloud when Gufo is down, or cannot ever serve the request", async () => {
    const local = gufo("gufo-a");
    const bigCloud = { ...cloudGlm, contextLimitTokens: 200_000 };
    for (const scenario of [
      { name: "down", down: new Set([local.id]), inputTokens: 40 },
      { name: "context", down: new Set<string>(), inputTokens: 100_000 },
    ]) {
      for (const cloud of [true, false]) {
        const net = network({ down: scenario.down });
        const started = Date.now();
        const exit = await run(
          ModelRouter.use((router) =>
            router
              .complete(
                work({ policy: { ...standardPolicy, cloud }, inputTokens: scenario.inputTokens }),
              )
              .pipe(Effect.exit),
          ),
          layer({ catalogue: [local, bigCloud], fetch: net.fetchImpl }),
        );
        assert.ok(Date.now() - started < 1_000, `${scenario.name} waited`);
        if (cloud) {
          assert.ok(Exit.isSuccess(exit), scenario.name);
          assert.equal(exit.value.headers.deploymentId, bigCloud.id);
        } else {
          assert.ok(Exit.isFailure(exit), scenario.name);
          assert.match(
            String(exit.cause),
            scenario.name === "down" ? /LocalOverloaded/ : /NoEligibleModel/,
            scenario.name,
          );
        }
      }
    }
  });

  it("hands client app attribution to OpenRouter and never to Gufo", async () => {
    const appAttribution = { url: "https://vibe.example", title: "Free Vibecode" };
    const sent = async (down: ReadonlySet<string>) => {
      const seen: Array<[string, string | null, string | null]> = [];
      const net = network({ down });
      const capture: typeof fetch = async (input, init) => {
        if (init?.method === "POST") {
          const headers = new Headers(init.headers);
          seen.push([
            String(input).split("/")[3]!,
            headers.get("HTTP-Referer"),
            headers.get("X-Title"),
          ]);
        }
        return net.fetchImpl(input, init);
      };
      await run(
        ModelRouter.use((router) =>
          router.complete(work({ appAttribution, policy: { ...standardPolicy, cloud: true } })),
        ),
        layer({ catalogue: [gufo("local"), frontier], fetch: capture }),
      );
      return seen;
    };
    // Gufo down: the cloud key goes to OpenRouter under the client's attribution.
    assert.deepEqual(await sent(new Set(["local"])), [
      ["frontier", appAttribution.url, appAttribution.title],
    ]);
    // Gufo up: the local request carries none of it.
    assert.deepEqual(await sent(new Set()), [["local", null, null]]);
  });

  it("fails 422 no_eligible_model when no deployment could ever serve the request", async () => {
    const exit = await run(
      ModelRouter.use((router) =>
        router
          .complete(
            work({
              policy: interactivePolicy,
              capabilities: { tools: false, json: false, vision: true },
            }),
          )
          .pipe(Effect.exit),
      ),
      layer({ catalogue: [gufo("gufo-a"), cloudGlm], fetch: network({}).fetchImpl }),
    );
    assert.ok(Exit.isFailure(exit));
    assert.match(String(exit.cause), /NoEligibleModel/);
  });

  it("keeps reserved permits for high priority only", async () => {
    const local = gufo("gufo-a", { capacity: { maxParallel: 2, reservedInteractiveSlots: 1 } });
    const net = network({ generate: holdStreams });
    await run(
      ModelRouter.use((router) =>
        Effect.gen(function* () {
          const held = yield* router.stream(work({ requestId: "held", stream: true }));
          const medium = yield* router.complete(work({ requestId: "medium" })).pipe(Effect.exit);
          assert.ok(Exit.isFailure(medium), "medium must not take the reserved permit");
          const high = yield* router.complete(
            work({ requestId: "high", policy: { ...interactivePolicy, cloud: false } }),
          );
          assert.equal(high.headers.deploymentId, local.id);
          yield* Effect.promise(() => held.body.cancel());
        }),
      ),
      layer({ catalogue: [local], fetch: net.fetchImpl, waitMs: { medium: 50 } }),
    );
  });

  it("does not retry after dispatch and still releases the permit", async () => {
    const local = gufo("gufo-a");
    let calls = 0;
    const net = network({
      generate: (call) =>
        ++calls === 1
          ? new Response("upstream", { status: 500 })
          : Response.json(completionBody(String(call.body.model))),
    });
    await run(
      ModelRouter.use((router) =>
        Effect.gen(function* () {
          const failed = yield* router.complete(work({ requestId: "a" })).pipe(Effect.exit);
          assert.ok(Exit.isFailure(failed));
          assert.match(String(failed.cause), /ProviderFailure/);
          const next = yield* router.complete(work({ requestId: "b" }));
          assert.equal(next.headers.deploymentId, local.id);
        }),
      ),
      layer({ catalogue: [local, cloudGlm], fetch: net.fetchImpl, waitMs: { medium: 50 } }),
    );
    assert.equal(calls, 2);
  });

  it("releases the permit when a hanging dispatch is interrupted", async () => {
    const local = gufo("gufo-a");
    let calls = 0;
    const net = network({
      generate: (call) =>
        ++calls === 1
          ? new Promise<Response>(() => undefined)
          : Response.json(completionBody(String(call.body.model))),
    });
    await run(
      ModelRouter.use((router) =>
        Effect.gen(function* () {
          const hanging = yield* Effect.forkChild(router.complete(work({ requestId: "hang" })));
          yield* Effect.sleep("50 millis");
          yield* Fiber.interrupt(hanging);
          const next = yield* router.complete(work({ requestId: "next" }));
          assert.equal(next.headers.deploymentId, local.id);
        }),
      ),
      layer({ catalogue: [local], fetch: net.fetchImpl, waitMs: { medium: 100 } }),
    );
  });
});

describe("session stickiness", () => {
  it("prefers the deployment the session last ran on, and never fails because of a session", async () => {
    const first = gufo("gufo-a");
    const second = gufo("gufo-b");
    await run(
      ModelRouter.use((router) =>
        Effect.gen(function* () {
          // gufo-a is busy with another request, so the first turn lands on gufo-b.
          const busy = yield* router.stream(work({ requestId: "busy", stream: true }));
          const turn1 = yield* router.complete(work({ requestId: "t1", sessionId: "s1" }));
          assert.equal(turn1.headers.deploymentId, second.id);
          yield* Effect.promise(() => busy.body.cancel());
          const turn2 = yield* router.complete(work({ requestId: "t2", sessionId: "s1" }));
          assert.equal(turn2.headers.deploymentId, second.id);
          assert.equal(turn2.decision.reason, "pinned");
          // Another key's session with the same id, and a fresh session: normal routing.
          const other = yield* router.complete(
            work({ requestId: "t3", keyId: "key-2", sessionId: "s1" }),
          );
          assert.equal(other.headers.deploymentId, first.id);
          const fresh = yield* router.complete(work({ requestId: "t4", sessionId: "new" }));
          assert.equal(fresh.headers.deploymentId, first.id);
        }),
      ),
      layer({
        catalogue: [first, second],
        fetch: network({ generate: holdStreams }).fetchImpl,
      }),
    );
  });

  it("tries a sticky cloud deployment first, but only while the key may use cloud", async () => {
    const local = gufo("gufo-a");
    const down = new Set([local.id]);
    const net = network({ down });
    await run(
      ModelRouter.use((router) =>
        Effect.gen(function* () {
          const turn1 = yield* router.complete(
            work({ sessionId: "s1", policy: interactivePolicy }),
          );
          assert.equal(turn1.headers.deploymentId, cloudGlm.id);
          down.clear();
          const turn2 = yield* router.complete(
            work({ sessionId: "s1", policy: interactivePolicy }),
          );
          assert.equal(turn2.headers.deploymentId, cloudGlm.id);
          assert.equal(turn2.decision.reason, "pinned");
          const noCloud = yield* router.complete(
            work({ sessionId: "s1", policy: { ...interactivePolicy, cloud: false } }),
          );
          assert.equal(noCloud.headers.deploymentId, local.id);
        }),
      ),
      layer({ catalogue: [local, cloudGlm], fetch: net.fetchImpl }),
    );
  });

  it("ignores a sticky deployment that is gone or down", async () => {
    const local = gufo("gufo-a");
    const second = gufo("gufo-b");
    const down = new Set<string>();
    const net = network({ down });
    await run(
      ModelRouter.use((router) =>
        Effect.gen(function* () {
          down.add(local.id);
          const turn1 = yield* router.complete(work({ sessionId: "s1" }));
          assert.equal(turn1.headers.deploymentId, second.id);
          down.clear();
          down.add(second.id);
          const turn2 = yield* router.complete(work({ sessionId: "s1" }));
          assert.equal(turn2.headers.deploymentId, local.id);
        }),
      ),
      layer({ catalogue: [local, second], fetch: net.fetchImpl }),
    );
  });
});

describe("flex tier (low, service_tier flex)", () => {
  it("uses the named 10-minute cap, under the gateway deadline", () => {
    assert.equal(FLEX_MAX_WAIT_MS, 10 * 60 * 1000);
    assert.ok(FLEX_MAX_WAIT_MS < GATEWAY_EFFECT_TIMEOUT_MS);
  });

  it("never goes to cloud, even for a cloud key, and gives up at the cap with resource_unavailable", async () => {
    const local = gufo("gufo-a");
    const net = network({ generate: () => refuse("resource_unavailable", "0") });
    for (const flexWork of [
      work({ policy: { ...backgroundPolicy, cloud: true } }),
      work({ policy: interactivePolicy, serviceTier: "flex" }),
    ]) {
      const started = Date.now();
      const exit = await run(
        ModelRouter.use((router) => router.complete(flexWork).pipe(Effect.exit)),
        layer({ catalogue: [local, cloudGlm], fetch: net.fetchImpl, waitMs: { flex: 600 } }),
      );
      const elapsed = Date.now() - started;
      assert.ok(elapsed >= 450 && elapsed < 2_000, `elapsed ${elapsed}`);
      assert.ok(Exit.isFailure(exit));
      const failure = exit.cause.reasons[0];
      const error = failure?._tag === "Fail" ? failure.error : undefined;
      assert.equal(error?._tag, "LocalOverloaded");
      if (error?._tag === "LocalOverloaded") assert.equal(error.flexRefused, true);
    }
    assert.ok(net.generations.length >= 4);
    assert.ok(net.generations.every((call) => call.id === local.id));
    assert.ok(net.generations.every((call) => call.body.service_tier === "flex"));
  });

  it("fails 422 when no local deployment could ever serve it, even with cloud allowed", async () => {
    const exit = await run(
      ModelRouter.use((router) =>
        router
          .complete(work({ policy: { ...backgroundPolicy, cloud: true }, inputTokens: 100_000 }))
          .pipe(Effect.exit),
      ),
      layer({
        catalogue: [gufo("gufo-a"), { ...cloudGlm, contextLimitTokens: 200_000 }],
        fetch: network({}).fetchImpl,
      }),
    );
    assert.ok(Exit.isFailure(exit));
    assert.match(String(exit.cause), /NoEligibleModel/);
  });

  for (const flexLimit of [1, 2]) {
    it(`queues FIFO and lets at most flex_limit=${flexLimit} requests reach Gufo at once`, async () => {
      const local = gufo("gufo-a", { capacity: { maxParallel: 8, reservedInteractiveSlots: 0 } });
      let inFlight = 0;
      let peak = 0;
      let refusals = 3;
      const finished: string[] = [];
      const net = network({
        flexLimit,
        generate: async (call) => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          try {
            await new Promise((resolve) => setTimeout(resolve, 20));
            // The slot holder, not the queue, meets Gufo's refusals.
            if (refusals-- > 0) return refuse("resource_unavailable", "0");
            return Response.json(completionBody(String(call.body.model)));
          } finally {
            inFlight -= 1;
          }
        },
      });
      await run(
        ModelRouter.use((router) =>
          Effect.forEach(
            ["a", "b", "c", "d"],
            (id) =>
              router
                .complete(work({ requestId: id, policy: backgroundPolicy }))
                .pipe(Effect.tap(() => Effect.sync(() => finished.push(id)))),
            { concurrency: "unbounded" },
          ),
        ),
        layer({ catalogue: [local], fetch: net.fetchImpl, waitMs: { flex: 10_000 } }),
      );
      assert.equal(peak, flexLimit);
      assert.equal(net.generations.length, 4 + 3);
      if (flexLimit === 1) assert.deepEqual(finished, ["a", "b", "c", "d"]);
      else assert.equal(finished.length, 4);
    });
  }

  it("streams on the normal path and holds its flex slot until the stream ends", async () => {
    const local = gufo("gufo-a", { capacity: { maxParallel: 8, reservedInteractiveSlots: 0 } });
    let attempts = 0;
    const net = network({
      flexLimit: 1,
      generate: (call) =>
        ++attempts === 1 ? refuse("resource_unavailable", "0") : holdStreams(call),
    });
    await run(
      ModelRouter.use((router) =>
        Effect.gen(function* () {
          const streamed = yield* router.stream(
            work({ requestId: "s", stream: true, policy: backgroundPolicy }),
          );
          assert.equal(streamed.headers.deploymentId, local.id);
          assert.equal(streamed.headers.queued, true);
          const waiting = yield* Effect.forkChild(
            router.complete(work({ requestId: "w", policy: backgroundPolicy })),
          );
          yield* Effect.sleep("100 millis");
          assert.equal(
            attempts,
            2,
            "the waiter must not reach Gufo while the stream holds the slot",
          );
          yield* Effect.promise(() => streamed.body.cancel());
          const done = yield* Fiber.join(waiting);
          assert.equal(done.headers.deploymentId, local.id);
        }),
      ),
      layer({ catalogue: [local], fetch: net.fetchImpl, waitMs: { flex: 5_000 } }),
    );
    assert.equal(attempts, 3);
  });
});

describe("batch", () => {
  it("runs batch items locally as flex, only while no interactive work runs", async () => {
    const local = gufo("gufo-a", { capacity: { maxParallel: 4, reservedInteractiveSlots: 0 } });
    const net = network({ generate: holdStreams });
    await run(
      ModelRouter.use((router) =>
        Effect.gen(function* () {
          const held = yield* router.stream(work({ requestId: "fg", stream: true }));
          assert.equal(router.interactiveIdle(), false);
          const blocked = yield* router
            .completeBatch(work({ requestId: "b1" }), "auto")
            .pipe(Effect.exit);
          assert.match(String(Exit.isFailure(blocked) ? blocked.cause : ""), /CapacityBusy/);
          yield* Effect.promise(() => held.body.cancel());
          assert.equal(router.interactiveIdle(), true);
          const done = yield* router.completeBatch(work({ requestId: "b2" }), "auto");
          assert.equal(done.headers.deploymentId, local.id);
        }),
      ),
      layer({ catalogue: [local, cloudGlm], fetch: net.fetchImpl }),
    );
    assert.equal(net.generations.at(-1)?.body.service_tier, "flex");
    assert.equal(
      net.generations.some((call) => call.id === cloudGlm.id),
      false,
    );
  });

  it("plans an OpenRouter batch spill without provider contact, only for a cloud key", async () => {
    const net = network({});
    const routerLayer = layer({
      catalogue: [gufo("gufo-a")],
      fetch: net.fetchImpl,
      credentials: () => "fixture-key",
    });
    const plan = await run(
      ModelRouter.use((router) =>
        router.planBatchSpill(
          work({ policy: { ...backgroundPolicy, cloud: true } }),
          [frontier],
          "auto",
        ),
      ),
      routerLayer,
    );
    assert.equal(plan.deployment.id, frontier.id);
    assert.equal(plan.body.model, frontier.modelId);
    assert.equal(plan.metadata.deploymentId, frontier.id);
    const refused = await run(
      ModelRouter.use((router) =>
        router
          .planBatchSpill(work({ policy: backgroundPolicy }), [frontier], "auto")
          .pipe(Effect.exit),
      ),
      routerLayer,
    );
    assert.ok(Exit.isFailure(refused));
    assert.match(String(refused.cause), /NoEligibleModel/);
    assert.equal(net.generations.length, 0);
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
              { headers: { "content-type": "text/event-stream" } },
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
          const routerLayer = layer({
            catalogue: [provider],
            onOpenRouterCompleted: verifyPin,
            fetch: fetchImpl,
          });
          let accounting: RequestAccounting;
          if (streaming) {
            const result = await run(
              ModelRouter.use((router) =>
                router.stream(work({ stream: true, policy: interactivePolicy })),
              ),
              routerLayer,
            );
            await new Response(result.body).text();
            accounting = result.accounting;
          } else {
            const result = await run(
              ModelRouter.use((router) => router.complete(work({ policy: interactivePolicy }))),
              routerLayer,
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
