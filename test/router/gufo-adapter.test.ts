import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Effect } from "effect";
import { LocalOverloaded } from "../../src/errors.ts";
import { gufoAdapter, gufoMessages } from "../../src/router/adapters/gufo.ts";
import { deployment } from "./fixtures.ts";
import type { AdapterRequest } from "../../src/router/adapters/types.ts";

const gufo = deployment({
  id: "gufo-local",
  modelId: "qwen3.8-flash-next-gufo",
  transport: "gufo",
  location: "local",
  endpoint: "http://127.0.0.1:9/v1",
  credentialEnvVar: "GUFO_API_KEY",
  reasoning: { kind: "graded", levels: ["none", "low", "medium", "xhigh"] },
});
const request = (partial: Partial<AdapterRequest> = {}): AdapterRequest => ({
  deployment: gufo,
  messages: [{ role: "user", content: "Summarize" }],
  tools: null,
  toolChoice: null,
  responseFormat: null,
  maxCompletionTokens: 128,
  requestedEffort: "none",
  appliedEffort: "none",
  credential: "fixture-key",
  ...partial,
});

const failure =
  (message: RegExp) =>
  (error: unknown): boolean => {
    assert.ok(error instanceof Error);
    assert.match(error.message, message);
    assert.equal("_tag" in error && error._tag, "ProviderFailure");
    return true;
  };

describe("Gufo ProviderAdapter", () => {
  it("sends a mid-conversation system message as a user note and keeps a leading one", () => {
    const messages = gufoMessages([
      { role: "system", content: "rules" },
      { role: "user", content: "hi" },
      { role: "system", content: "reminder" },
      { role: "developer", content: [{ type: "text", text: "dev" }] },
    ] as unknown as AdapterRequest["messages"]);
    assert.deepEqual(
      messages.map((message) => message.role),
      ["system", "user", "user", "user"],
    );
    assert.equal(messages[0]?.content, "rules");
    assert.equal(messages[2]?.content, "[System note]\nreminder");
    assert.deepEqual(messages[3]?.content, [
      { type: "text", text: "[System note]" },
      { type: "text", text: "dev" },
    ]);
  });

  it("reports Gufo's 400 as the client's invalid request, with Gufo's reason", async () => {
    const adapter = gufoAdapter(async () =>
      Response.json(
        { error: { message: "System message must be at the beginning.", code: "invalid_prompt" } },
        { status: 400 },
      ),
    );
    const exit = await Effect.runPromise(adapter.complete(request()).pipe(Effect.exit));
    assert.equal(exit._tag, "Failure");
    const error = exit._tag === "Failure" ? exit.cause.reasons[0] : undefined;
    const failure = error?._tag === "Fail" ? error.error : undefined;
    assert.equal(failure?._tag, "InvalidInput");
    assert.match(String(failure?.message), /System message must be at the beginning/);
  });

  it("fails closed without a bearer credential before contacting Gufo", async () => {
    let called = false;
    const adapter = gufoAdapter(async () => {
      called = true;
      return Response.json({});
    });
    assert.equal(await Effect.runPromise(adapter.probeUnavailable(gufo, undefined)), true);
    await assert.rejects(
      Effect.runPromise(adapter.complete(request({ credential: undefined }))),
      failure(/credential/i),
    );
    await assert.rejects(
      Effect.runPromise(adapter.stream(request({ credential: "" }))),
      failure(/credential/i),
    );
    assert.equal(called, false);
  });
  it("requires an authenticated exact model alias before routing", async () => {
    const seen: string[] = [];
    const adapter = gufoAdapter(async (url, init) => {
      seen.push(String(url));
      assert.equal(init?.method, "GET");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-key");
      return Response.json({ data: [{ id: "other-model" }] });
    });
    assert.equal(await Effect.runPromise(adapter.probeUnavailable(gufo, "fixture-key")), true);
    assert.deepEqual(seen, ["http://127.0.0.1:9/v1/models"]);
  });

  it("accepts only a valid bounded model listing containing the exact alias", async () => {
    const healthy = gufoAdapter(async () => Response.json({ data: [{ id: gufo.modelId }] }));
    const malformed = gufoAdapter(async () => new Response("<html>proxy</html>"));
    const invalid = gufoAdapter(async () => Response.json({ data: [{ model: gufo.modelId }] }));
    const unauthorized = gufoAdapter(async () => new Response("denied", { status: 401 }));
    assert.equal(await Effect.runPromise(healthy.probeUnavailable(gufo, "fixture-key")), false);
    assert.equal(await Effect.runPromise(malformed.probeUnavailable(gufo, "fixture-key")), true);
    assert.equal(await Effect.runPromise(invalid.probeUnavailable(gufo, "fixture-key")), true);
    assert.equal(await Effect.runPromise(unauthorized.probeUnavailable(gufo, "fixture-key")), true);
    assert.equal(typeof healthy.readFlexLimit, "function");
  });

  it("counts a slow model listing as up, and a refused connection as down", async () => {
    const slow = gufoAdapter(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          }),
        ),
    );
    assert.equal(await Effect.runPromise(slow.probeUnavailable(gufo, "fixture-key")), false);
    const refused = gufoAdapter(async () => {
      throw new TypeError("fetch failed");
    });
    assert.equal(await Effect.runPromise(refused.probeUnavailable(gufo, "fixture-key")), true);
  });

  it("reads flex_limit only from a known runtime contract", async () => {
    const reader = (body: unknown, status = 200) =>
      gufoAdapter(async (url, init) => {
        assert.equal(String(url), "http://127.0.0.1:9/v1/runtime");
        assert.equal(init?.method, "GET");
        return Response.json(body, { status });
      }).readFlexLimit!;
    const runtime = (flexLimit: number, version = 1) => ({
      contract_version: version,
      sessions: { capacity: 24, flex_limit: flexLimit },
    });
    const read = (body: unknown, status?: number) =>
      Effect.runPromise(reader(body, status)(gufo, "fixture-key"));
    assert.equal(await read(runtime(3)), 3);
    assert.equal(await read(runtime(0)), 0);
    assert.equal(await read(runtime(3, 2)), undefined);
    assert.equal(await read({ error: { code: "not_found" } }, 404), undefined);
    assert.equal(await Effect.runPromise(reader(runtime(3))(gufo, undefined)), undefined);
  });

  it("caches one runtime observation", async () => {
    let calls = 0;
    const adapter = gufoAdapter(async () => {
      calls += 1;
      return Response.json({ contract_version: 1, sessions: { flex_limit: 4 } });
    });
    const read = () => Effect.runPromise(adapter.readFlexLimit!(gufo, "fixture-key"));
    assert.equal(await read(), 4);
    assert.equal(await read(), 4);
    assert.equal(calls, 1);
  });

  it("sends batch work as flex and forwards the router request id", async () => {
    let seen: { body: Record<string, unknown>; requestId: string | null } | undefined;
    const adapter = gufoAdapter(async (_url, init) => {
      seen = {
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        requestId: new Headers(init?.headers).get("X-Request-ID"),
      };
      return Response.json({
        model: gufo.modelId,
        choices: [{ index: 0, message: { role: "assistant", content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    });
    await Effect.runPromise(adapter.complete(request({ serviceTier: "flex", requestId: "r-1" })));
    assert.equal(seen?.body.service_tier, "flex");
    assert.equal(seen?.requestId, "r-1");
    await Effect.runPromise(adapter.complete(request()));
    assert.equal("service_tier" in (seen?.body ?? {}), false);
    assert.equal(seen?.requestId, null);
  });

  it("never forwards client app attribution to Gufo", async () => {
    let names: string[] = [];
    const adapter = gufoAdapter(async (_url, init) => {
      names = [...new Headers(init?.headers).keys()];
      return Response.json({
        model: gufo.modelId,
        choices: [{ index: 0, message: { role: "assistant", content: "ok" } }],
      });
    });
    await Effect.runPromise(
      adapter.complete(
        request({ appAttribution: { url: "https://vibe.example", title: "Free Vibecode" } }),
      ),
    );
    assert.ok(names.includes("authorization"));
    assert.deepEqual(
      names.filter(
        (name) => name === "http-referer" || name === "x-title" || name.startsWith("x-openrouter-"),
      ),
      [],
    );
  });

  it("sends Gufo's exact completion protocol and returns tool and usage data", async () => {
    const tool = { id: "call_1", type: "function", function: { name: "read", arguments: "{}" } };
    const adapter = gufoAdapter(async (url, init) => {
      assert.equal(String(url), "http://127.0.0.1:9/v1/chat/completions");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-key");
      assert.equal(init?.method, "POST");
      const body: unknown = JSON.parse(String(init?.body));
      assert.deepEqual(body, {
        model: "qwen3.8-flash-next-gufo",
        messages: [{ role: "user", content: "Summarize" }],
        max_tokens: 128,
        reasoning_effort: "medium",
        stream: false,
        temperature: 0.5,
        tools: [{ type: "function", function: { name: "read" } }],
        tool_choice: "auto",
      });
      return Response.json({
        model: gufo.modelId,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: null, tool_calls: [tool] },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
      });
    });
    const result = await Effect.runPromise(
      adapter.complete(
        request({
          appliedEffort: "medium",
          requestedEffort: "medium",
          sampling: { temperature: 0.5 },
          tools: [{ type: "function", function: { name: "read" } }],
          toolChoice: "auto",
        }),
      ),
    );
    assert.equal(result.usage.promptTokens, 12);
    assert.deepEqual(result.body.choices, [
      {
        index: 0,
        message: { role: "assistant", content: null, tool_calls: [tool] },
        finish_reason: "tool_calls",
      },
    ]);
  });

  it("rejects a successful-looking response for another or missing model", async () => {
    for (const model of ["qwen3.8-flash-next", undefined]) {
      const adapter = gufoAdapter(async () =>
        Response.json({
          model,
          choices: [{ index: 0, message: { role: "assistant", content: "bad" } }],
        }),
      );
      await assert.rejects(Effect.runPromise(adapter.complete(request())), failure(/model/i));
    }
  });

  it("does not send unsupported controls and maps none to Gufo off", async () => {
    const adapter = gufoAdapter(async (_url, init) => {
      const body: unknown = JSON.parse(String(init?.body));
      assert.deepEqual(body, {
        model: gufo.modelId,
        messages: [{ role: "user", content: "Summarize" }],
        max_tokens: 128,
        reasoning_effort: "off",
        stream: false,
      });
      return Response.json({ model: gufo.modelId, choices: [{ message: { content: "ok" } }] });
    });
    await Effect.runPromise(adapter.complete(request()));
  });

  it("rejects unsupported stop and response_format rather than silently ignoring them", async () => {
    let called = false;
    const adapter = gufoAdapter(async () => {
      called = true;
      return Response.json({});
    });
    for (const partial of [
      { sampling: { stop: "HALT" } },
      { responseFormat: { type: "json_object" } },
    ]) {
      await assert.rejects(
        Effect.runPromise(adapter.complete(request(partial))),
        failure(/support/i),
      );
    }
    assert.equal(called, false);
  });

  it("constrains a named choice to its one tool and requires that function", async () => {
    const tools = [
      { type: "function", function: { name: "discard", parameters: { type: "object" } } },
      {
        type: "function",
        function: {
          name: "read",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      },
    ];
    const expected = tools[1];
    for (const operation of ["complete", "stream"] as const) {
      const adapter = gufoAdapter(async (_url, init) => {
        const body: unknown = JSON.parse(String(init?.body));
        assert.ok(body && typeof body === "object" && "tools" in body && "tool_choice" in body);
        assert.deepEqual(body.tools, [expected]);
        assert.equal(body.tool_choice, "required");
        if (operation === "complete")
          return Response.json({
            model: gufo.modelId,
            choices: [
              {
                message: {
                  role: "assistant",
                  tool_calls: [{ function: { name: "read", arguments: "{}" } }],
                },
              },
            ],
          });
        return new Response(
          'data: {"model":"qwen3.8-flash-next-gufo","choices":[{"delta":{"role":"assistant"}}]}\n\ndata: [DONE]\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      });
      const adapterRequest = request({
        tools,
        toolChoice: { type: "function", function: { name: "read" } },
      });
      if (operation === "complete") {
        await Effect.runPromise(adapter.complete(adapterRequest));
      } else {
        const response = await Effect.runPromise(adapter.stream(adapterRequest));
        assert.match(await response.text(), /\[DONE\]/);
      }
    }
  });

  it("rejects an absent or ambiguous named tool before contacting Gufo", async () => {
    let contacted = false;
    const adapter = gufoAdapter(async () => {
      contacted = true;
      return Response.json({});
    });
    for (const tools of [
      [{ type: "function", function: { name: "discard" } }],
      [
        { type: "function", function: { name: "read" } },
        { type: "function", function: { name: "read" } },
      ],
      null,
    ]) {
      for (const operation of ["complete", "stream"] as const) {
        const adapterRequest = request({
          tools,
          toolChoice: { type: "function", function: { name: "read" } },
        });
        await assert.rejects(
          operation === "complete"
            ? Effect.runPromise(adapter.complete(adapterRequest))
            : Effect.runPromise(adapter.stream(adapterRequest)),
          failure(/named tool/i),
        );
      }
    }
    assert.equal(contacted, false);
  });

  it("rejects a mismatched first SSE model before exposing content", async () => {
    const adapter = gufoAdapter(async (_url, init) => {
      const body: unknown = JSON.parse(String(init?.body));
      assert.ok(body && typeof body === "object" && "stream_options" in body);
      assert.deepEqual(body.stream_options, { include_usage: true });
      return new Response(
        'data: {"model":"wrong-model","choices":[{"delta":{"content":"secret"}}]}\n\ndata: [DONE]\n\n',
        {
          headers: { "content-type": "text/event-stream" },
        },
      );
    });
    await assert.rejects(Effect.runPromise(adapter.stream(request())), failure(/model/i));
  });

  it("passes split Gufo tool, usage and completion SSE frames to the router pipeline", async () => {
    const chunks = [
      'data: {"model":"qwen3.8-flash-next-gufo","choices":[{"delta":{"role":"assistant"}}]}\n\n',
      'data: {"model":"qwen3.8-flash-next-gufo","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read","arguments":"{}"}}]}}]}\n',
      '\ndata: {"model":"qwen3.8-flash-next-gufo","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":7}}\n\ndata: [DONE]\n\n',
    ];
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });
    const adapter = gufoAdapter(async (_url, init) => {
      const body: unknown = JSON.parse(String(init?.body));
      assert.deepEqual(body, {
        model: gufo.modelId,
        messages: [{ role: "user", content: "Summarize" }],
        max_tokens: 128,
        reasoning_effort: "xhigh",
        stream: true,
        stream_options: { include_usage: true },
        tools: [{ type: "function", function: { name: "read" } }],
        tool_choice: "required",
      });
      return new Response(source, { headers: { "content-type": "text/event-stream" } });
    });
    const response = await Effect.runPromise(
      adapter.stream(
        request({
          appliedEffort: "xhigh",
          requestedEffort: "xhigh",
          tools: [{ type: "function", function: { name: "read" } }],
          toolChoice: "required",
        }),
      ),
    );
    assert.equal(await response.text(), chunks.join(""));
  });

  it("stops before forwarding a later mismatched SSE content frame", async () => {
    const adapter = gufoAdapter(
      async () =>
        new Response(
          'data: {"model":"qwen3.8-flash-next-gufo","choices":[{"delta":{"role":"assistant"}}]}\n\n' +
            'data: {"model":"wrong-model","choices":[{"delta":{"content":"secret"}}]}\n\ndata: [DONE]\n\n',
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const response = await Effect.runPromise(adapter.stream(request()));
    assert.ok(response.body);
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.equal(new TextDecoder().decode(first.value).includes("secret"), false);
    await assert.rejects(reader.read(), failure(/model/i));
  });

  it("rejects malformed and oversized readiness and stream bodies", async () => {
    const tooLarge = "x".repeat(8 * 1024 * 1024 + 1);
    const probe = gufoAdapter(async () => new Response(tooLarge));
    assert.equal(await Effect.runPromise(probe.probeUnavailable(gufo, "fixture-key")), true);
    for (const event of [
      'data: {"error":{"message":"wrong"}}\n\n',
      'data: {"choices":[{"delta":{"content":"unverified"}}]}\n\n',
      "data: " + "x".repeat(256 * 1024 + 1) + "\n\n",
    ]) {
      const adapter = gufoAdapter(
        async () => new Response(event, { headers: { "content-type": "text/event-stream" } }),
      );
      await assert.rejects(Effect.runPromise(adapter.stream(request())), failure(/SSE/i));
    }
  });

  it("cancels an upstream Gufo stream when SSE model preflight is interrupted", async () => {
    let cancelled = false;
    const adapter = gufoAdapter(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull() {
              return new Promise<void>(() => {});
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    await assert.rejects(
      Effect.runPromise(adapter.stream(request()).pipe(Effect.timeout("20 millis"))),
    );
    assert.equal(cancelled, true);
  });

  it("marks only Gufo pre-enqueue queue refusals as typed local overload", async () => {
    for (const operation of ["complete", "stream"] as const) {
      for (const code of ["queue_full", "client_queue_full", "resource_unavailable"]) {
        const adapter = gufoAdapter(
          async () =>
            new Response(JSON.stringify({ error: { code } }), {
              status: 429,
              headers: { "retry-after": "2", "content-type": "application/json" },
            }),
        );
        const run =
          operation === "complete"
            ? Effect.runPromise(adapter.complete(request()))
            : Effect.runPromise(adapter.stream(request()));
        await assert.rejects(run, (error: unknown) => {
          assert.ok(error instanceof LocalOverloaded);
          assert.equal(error.retryAfterSeconds, 2);
          assert.equal(error.flexRefused === true, code === "resource_unavailable");
          return true;
        });
      }
    }
  });

  it("opts into Gufo fast rejection and reports empty-body 429 with Retry-After", async () => {
    for (const operation of ["complete", "stream"] as const) {
      const adapter = gufoAdapter(async (_url, init) => {
        assert.equal(new Headers(init?.headers).get("X-Gufo-No-Queue"), "1");
        return new Response(null, {
          status: 429,
          headers: { "content-length": "0", "retry-after": "301" },
        });
      });
      const run =
        operation === "complete"
          ? Effect.runPromise(adapter.complete(request()))
          : Effect.runPromise(adapter.stream(request()));
      await assert.rejects(run, (error: unknown) => {
        assert.ok(error instanceof LocalOverloaded);
        assert.equal(error.retryAfterSeconds, 301);
        return true;
      });
    }
  });

  it("reports empty Gufo 429 bodies without Retry-After as local overload", async () => {
    for (const operation of ["complete", "stream"] as const) {
      const adapter = gufoAdapter(async (_url, init) => {
        assert.equal(new Headers(init?.headers).get("X-Gufo-No-Queue"), "1");
        return new Response("", { status: 429 });
      });
      const run =
        operation === "complete"
          ? Effect.runPromise(adapter.complete(request()))
          : Effect.runPromise(adapter.stream(request()));
      await assert.rejects(run, (error: unknown) => {
        assert.ok(error instanceof LocalOverloaded);
        assert.equal(error.retryAfterSeconds, null);
        return true;
      });
    }
  });

  it("does not infer fast rejection from a non-empty unknown 429 response", async () => {
    for (const body of ["unknown upstream throttle", "\uFEFF"]) {
      for (const operation of ["complete", "stream"] as const) {
        const adapter = gufoAdapter(async (_url, init) => {
          assert.equal(new Headers(init?.headers).get("X-Gufo-No-Queue"), "1");
          return new Response(body, { status: 429 });
        });
        const run =
          operation === "complete"
            ? Effect.runPromise(adapter.complete(request()))
            : Effect.runPromise(adapter.stream(request()));
        await assert.rejects(run, failure(/HTTP 429/));
      }
    }
  });

  it("treats a draining Gufo as local overload before enqueue", async () => {
    for (const operation of ["complete", "stream"] as const) {
      const adapter = gufoAdapter(
        async () =>
          new Response(JSON.stringify({ error: { code: "draining" } }), {
            status: 503,
            headers: { "retry-after": "1" },
          }),
      );
      const run =
        operation === "complete"
          ? Effect.runPromise(adapter.complete(request()))
          : Effect.runPromise(adapter.stream(request()));
      await assert.rejects(run, (error: unknown) => {
        assert.ok(error instanceof LocalOverloaded);
        assert.match(error.message, /draining/);
        assert.equal(error.retryAfterSeconds, 1);
        return true;
      });
    }
  });

  it("keeps ambiguous HTTP 429/503 failures distinct from local overload", async () => {
    for (const [status, body, retryAfter] of [
      [429, { error: { code: "rate_limit" } }, "10"],
      [429, { error: { code: "queue_full" } }, "not-seconds"],
      [503, { error: { code: "queue_full" } }, "2"],
    ] as const) {
      const adapter = gufoAdapter(
        async () =>
          new Response(JSON.stringify(body), {
            status,
            headers: { "retry-after": retryAfter },
          }),
      );
      if (status === 429 && retryAfter === "not-seconds") {
        await assert.rejects(Effect.runPromise(adapter.complete(request())), (error: unknown) => {
          assert.ok(error instanceof LocalOverloaded);
          assert.equal(error.retryAfterSeconds, null);
          return true;
        });
      } else {
        await assert.rejects(Effect.runPromise(adapter.complete(request())), (error: unknown) => {
          assert.equal(error instanceof LocalOverloaded, false);
          return failure(/HTTP/)(error);
        });
      }
    }
  });
});
