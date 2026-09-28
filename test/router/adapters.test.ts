import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Effect } from "effect";
import { gufoBody } from "../../src/router/adapters/gufo.ts";
import { joinUrl } from "../../src/router/adapters/http.ts";
import { completionBody } from "../../src/router/adapters/openai-compatible.ts";
import {
  createOpenRouterPinVerifier,
  OPENROUTER_APP_HEADERS,
  openRouterAdapter,
  openRouterAppHeaders,
  openRouterBody,
} from "../../src/router/adapters/openrouter.ts";
import { localQwen, cloudGlm, frontier } from "./fixtures.ts";
import type { AdapterRequest } from "../../src/router/adapters/types.ts";

const request = (
  partial: Partial<AdapterRequest> & Pick<AdapterRequest, "deployment" | "appliedEffort">,
): AdapterRequest => ({
  messages: [{ role: "user", content: "hi", reasoning_content: "secret-thought" }],
  tools: [{ type: "function", function: { name: "read" } }],
  toolChoice: "auto",
  responseFormat: null,
  maxCompletionTokens: 128,
  requestedEffort: "high",
  credential: undefined,
  ...partial,
});

describe("adapters", () => {
  it("only sends parallel tool control to upstreams that understand it", () => {
    for (const enabled of [true, false]) {
      const options = { parallelToolCalls: enabled, appliedEffort: "none" as const };
      const openai = completionBody(request({ ...options, deployment: cloudGlm }), false);
      const openrouter = openRouterBody(request({ ...options, deployment: frontier }), false);
      const gufo = gufoBody(
        request({ ...options, deployment: { ...localQwen, transport: "gufo" } }),
        false,
      );
      assert.equal(openai.parallel_tool_calls, enabled);
      assert.equal(openrouter.parallel_tool_calls, enabled);
      for (const body of [openai, openrouter, gufo]) {
        assert.equal("store" in body, false);
        assert.equal("metadata" in body, false);
      }
      for (const body of [gufo]) {
        assert.equal("parallel_tool_calls" in body, false);
      }
    }
  });

  it("identifies llm-router to OpenRouter on completions, streams and generation lookups", async () => {
    const seen: Headers[] = [];
    const fake = async (_url: string | URL | Request, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return new Response(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const adapter = openRouterAdapter(fake);
    await Effect.runPromise(
      adapter.complete(request({ deployment: frontier, appliedEffort: "none" })),
    );
    await Effect.runPromise(
      adapter.stream(request({ deployment: frontier, appliedEffort: "none" })),
    );
    await new Promise<void>((done) => {
      createOpenRouterPinVerifier({
        fetchImpl: async (url, init) => {
          await fake(url, init);
          done();
          return new Response("{}", { status: 200 });
        },
        credential: () => "sk-test",
        stopping: () => false,
        onVerified: () => undefined,
        delayMs: 0,
      })({ ...frontier, providerRestriction: "inference-net" }, "gen-1");
    });
    assert.equal(seen.length, 3);
    for (const headers of seen)
      for (const [name, value] of Object.entries(OPENROUTER_APP_HEADERS))
        assert.equal(headers.get(name), value);
  });

  it("forwards a self-identified client's attribution to OpenRouter instead of the router's", async () => {
    const seen: Headers[] = [];
    const adapter = openRouterAdapter(async (_url, init) => {
      seen.push(new Headers(init?.headers));
      return Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] });
    });
    const app = {
      url: "https://vibe.example/studio",
      title: "Free Vibecode",
      categories: "programming-app,native-app-builder",
      visibility: "hidden" as const,
    };
    await Effect.runPromise(
      adapter.complete(
        request({ deployment: frontier, appliedEffort: "none", appAttribution: app }),
      ),
    );
    await Effect.runPromise(
      adapter.stream(request({ deployment: frontier, appliedEffort: "none", appAttribution: app })),
    );
    assert.equal(seen.length, 2);
    for (const headers of seen) {
      assert.equal(headers.get("HTTP-Referer"), app.url);
      assert.equal(headers.get("X-OpenRouter-Title"), app.title);
      assert.equal(headers.get("X-Title"), app.title);
      assert.equal(headers.get("X-OpenRouter-Categories"), app.categories);
      assert.equal(headers.get("X-OpenRouter-App-Visibility"), "hidden");
    }

    // Referer/Title replace the router's as a pair; the router's `hidden` is its own default.
    assert.deepEqual(openRouterAppHeaders({ url: app.url }), { "HTTP-Referer": app.url });
    assert.deepEqual(openRouterAppHeaders({ title: app.title }), {
      "X-OpenRouter-Title": app.title,
      "X-Title": app.title,
    });
    assert.equal(openRouterAppHeaders(undefined), OPENROUTER_APP_HEADERS);
    assert.equal(openRouterAppHeaders({ categories: "game" }), OPENROUTER_APP_HEADERS);
  });

  it("pins OpenRouter provider without hidden fallbacks", () => {
    const body = openRouterBody(
      request({
        deployment: { ...frontier, providerRestriction: "anthropic" },
        appliedEffort: "high",
      }),
      false,
    );
    assert.deepEqual(body.provider, {
      only: ["anthropic"],
      allow_fallbacks: false,
      require_parameters: true,
    });
    assert.deepEqual(body.reasoning, { effort: "high" });
    assert.ok((body.messages as { reasoning_content?: string }[])[0]?.reasoning_content);
  });

  it("does not double /v1 when the endpoint already includes it", () => {
    assert.equal(
      joinUrl("http://127.0.0.1:8080", "/v1/chat/completions"),
      "http://127.0.0.1:8080/v1/chat/completions",
    );
    assert.equal(
      joinUrl("http://127.0.0.1:8080/v1", "/v1/chat/completions"),
      "http://127.0.0.1:8080/v1/chat/completions",
    );
    assert.equal(joinUrl("http://127.0.0.1:8080/v1", "/health"), "http://127.0.0.1:8080/health");
    assert.equal(
      joinUrl("http://127.0.0.1:8080/proxy/v1", "/health"),
      "http://127.0.0.1:8080/proxy/health",
    );
  });
});

it(
  "bounds OpenRouter metadata lookups without retrying failures or dispatching during shutdown",
  { timeout: 5000 },
  async () => {
    const deployment = { ...frontier, providerRestriction: "inference-net" };
    let active = 0;
    let peak = 0;
    let requests = 0;
    let stopping = false;
    const observed: string[] = [];
    const finished = Promise.withResolvers<void>();
    const verify = createOpenRouterPinVerifier({
      fetchImpl: async () => {
        const requestNumber = ++requests;
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return requestNumber === 1
          ? new Response("unavailable", { status: 503 })
          : Response.json({ data: { provider_name: "InferenceNet" } });
      },
      credential: () => "fixture-key",
      stopping: () => stopping,
      delayMs: 0,
      onVerified: (_deployment, result) => {
        observed.push(result);
        if (observed.length === 10) finished.resolve();
      },
    });
    for (let index = 0; index < 10; index++) verify(deployment, `gen-${index}`);
    await finished.promise;
    assert.equal(requests, 10);
    assert.equal(peak, 4);
    assert.equal(observed.filter((result) => result === "unknown").length, 1);
    assert.equal(observed.filter((result) => result === "match").length, 9);
    stopping = true;
    verify(deployment, "gen-after-shutdown");
    assert.equal(requests, 10);
  },
);
it(
  "compares only the provider identity when an endpoint pin includes a variant",
  { timeout: 5000 },
  async () => {
    for (const [pin, served, expected] of [
      ["sail-research/fp8", "Sail Research", "match"],
      ["inference-net", "InferenceNet", "match"],
      ["inference-net", "DeepInfra", "mismatch"],
    ] as const) {
      const verified = Promise.withResolvers<string>();
      const verify = createOpenRouterPinVerifier({
        fetchImpl: async () => Response.json({ data: { provider_name: served } }),
        credential: () => "fixture-key",
        stopping: () => false,
        delayMs: 0,
        onVerified: (_deployment, result) => verified.resolve(result),
      });
      verify({ ...frontier, providerRestriction: pin }, "gen-test");
      assert.equal(await verified.promise, expected);
    }
  },
);

it("skips checks without a cloud provider restriction", () => {
  let fetches = 0;
  const observed: string[] = [];
  const verify = createOpenRouterPinVerifier({
    fetchImpl: async () => {
      fetches += 1;
      return Response.json({ data: { provider_name: "InferenceNet" } });
    },
    credential: () => "fixture-key",
    stopping: () => false,
    delayMs: 0,
    onVerified: (_deployment, result) => observed.push(result),
  });
  verify(frontier, "gen-unpinned");
  verify({ ...frontier, location: "local", providerRestriction: "inference-net" }, "gen-local");
  assert.equal(fetches, 0);
  assert.deepEqual(observed, []);
});

it(
  "drains rejected and malformed generation metadata before reporting unknown",
  { timeout: 5000 },
  async () => {
    for (const status of [503, 200]) {
      let cancelled = false;
      let pulled = false;
      let requests = 0;
      const verified = Promise.withResolvers<string>();
      const verify = createOpenRouterPinVerifier({
        fetchImpl: async () => {
          requests += 1;
          const source = new ReadableStream<Uint8Array>({
            pull(controller) {
              pulled = true;
              controller.enqueue(new TextEncoder().encode(status === 503 ? "error" : "{bad-json"));
              if (status === 200) controller.close();
            },
            cancel() {
              cancelled = true;
            },
          });
          return new Response(source, { status });
        },
        credential: () => "fixture-key",
        stopping: () => false,
        delayMs: 0,
        onVerified: (_deployment, result) => verified.resolve(result),
      });
      verify({ ...frontier, providerRestriction: "inference-net" }, "gen-error");
      assert.equal(await verified.promise, "unknown");
      assert.equal(requests, 1);
      assert.equal(pulled, true);
      if (status === 503) assert.equal(cancelled, true);
    }
  },
);
