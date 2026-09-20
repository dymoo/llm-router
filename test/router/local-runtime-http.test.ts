import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { Effect, ManagedRuntime, Predicate } from "effect";
import { ModelRouter, modelRouterLayer } from "../../src/router/model-router.ts";
import { deployment, easyLocalCoding, balancedPolicy } from "./fixtures.ts";

for (const transport of ["llamacpp", "halogen"] as const) {
  test(`${transport} serves tools, reasoning, costs and canonical terminal SSE usage over HTTP`, async () => {
    const requests: Record<string, unknown>[] = [];
    const server = createServer(async (request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/health") {
        response.end(
          JSON.stringify(
            transport === "halogen"
              ? {
                  status: "ok",
                  engine: { responds: true },
                  busy: false,
                  slots: 2,
                  in_flight: 0,
                  slot_ctx: 32768,
                }
              : { status: "ok" },
          ),
        );
        return;
      }
      if (request.url === "/slots") {
        response.end(JSON.stringify([{ is_processing: false }, { is_processing: false }]));
        return;
      }
      if (request.url !== "/v1/chat/completions") {
        response.statusCode = 404;
        response.end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body: Record<string, unknown> = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(body);
      const budget = transport === "halogen" ? body.max_completion_tokens : body.max_tokens;
      const thinking =
        transport === "halogen"
          ? body.enable_thinking
          : Predicate.isObject(body.chat_template_kwargs)
            ? body.chat_template_kwargs.enable_thinking
            : undefined;
      if (
        budget !== 64 ||
        thinking !== true ||
        body.reasoning_effort !== "xhigh" ||
        !Array.isArray(body.tools)
      ) {
        response.statusCode = 400;
        response.end(JSON.stringify({ error: "invalid runtime contract" }));
        return;
      }
      const tool = {
        id: "call_read",
        type: "function",
        function: { name: "read", arguments: '{"path":"file.ts"}' },
      };
      const usage = {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        completion_tokens_details: { reasoning_tokens: 10 },
      };
      const timings = {
        prompt_n: 50,
        cache_n: 50,
        predicted_n: 20,
        prompt_ms: 100,
        predicted_ms: 250,
      };
      if (body.stream !== true) {
        response.end(
          JSON.stringify({
            id: "completion",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: null,
                  reasoning_content: "Inspecting the file.",
                  tool_calls: [tool],
                },
                finish_reason: "tool_calls",
              },
            ],
            usage,
            timings,
          }),
        );
        return;
      }
      if (
        !(
          body.stream_options &&
          typeof body.stream_options === "object" &&
          "include_usage" in body.stream_options &&
          body.stream_options.include_usage === true
        )
      ) {
        response.statusCode = 400;
        response.end(JSON.stringify({ error: "stream accounting not requested" }));
        return;
      }
      response.setHeader("content-type", "text/event-stream");
      const frames: Record<string, unknown>[] = [
        {
          id: "completion",
          model: "local",
          choices: [
            { index: 0, delta: { reasoning_content: "Inspecting the file." }, finish_reason: null },
          ],
          usage: null,
        },
        {
          id: "completion",
          choices: [
            { index: 0, delta: { tool_calls: [{ index: 0, ...tool }] }, finish_reason: null },
          ],
          usage: null,
        },
      ];
      const finish = {
        id: "completion",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        timings,
      };
      if (transport === "halogen")
        frames.push({ ...finish, usage: null }, { id: "completion", choices: [], usage, timings });
      else frames.push({ ...finish, usage });
      for (const frame of frames) response.write(`data: ${JSON.stringify(frame)}\n\n`);
      response.end("data: [DONE]\n\n");
    });
    const listening = Promise.withResolvers<void>();
    server.listen(0, "127.0.0.1", listening.resolve);
    await listening.promise;
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const local = deployment({
      id: `local-${transport}`,
      modelId: "local",
      location: "local",
      transport,
      endpoint: `http://127.0.0.1:${address.port}/v1`,
      reasoning: { kind: "graded", levels: ["none", "low", "medium", "xhigh"] },
    });
    const runtime = ManagedRuntime.make(
      modelRouterLayer({
        catalogue: [
          {
            ...local,
            prices: {
              ...local.prices,
              inputUsdPerMillion: 1,
              cachedInputUsdPerMillion: 0.5,
              outputUsdPerMillion: 2,
            },
          },
        ],
        catalogueVersion: "contract-test",
        classify: () =>
          Effect.succeed({
            assessment: { ...easyLocalCoding, effort: { value: "high", confidence: 1 } },
            usage: { input_tokens: 10, output_tokens: 0 },
            backend: "laya",
            modelRevision: "test",
            cacheHit: false,
            elapsedMs: 1,
            reuse: "classified",
            source: "full-input",
          }),
      }),
    );
    try {
      const router = await runtime.runPromise(ModelRouter);
      const work = {
        requestId: "request",
        keyId: "key",
        keyPolicyVersion: 1,
        policy: { ...balancedPolicy, localityBias: 1, maxWaitMs: 0 },
        messages: [{ role: "user" as const, content: "Inspect file.ts" }],
        tools: [
          {
            type: "function",
            function: {
              name: "read",
              parameters: { type: "object", properties: { path: { type: "string" } } },
            },
          },
        ],
        inputTokens: 100,
        maxCompletionTokens: 64,
        capabilities: { tools: true, json: false, vision: false },
        freshFactsAvailable: false,
        routing: { sessionId: "session", boundary: "new-task" as const },
        stream: false,
      };
      const completed = await runtime.runPromise(router.complete(work));
      assert.equal(completed.headers.appliedEffort, "xhigh");
      assert.equal(completed.accounting.cachedInputTokens, 50);
      assert.equal(completed.accounting.reasoningTokens, 10);
      assert.equal(completed.accounting.localComputeEstimatedUsd, 0.000115);
      assert.equal(completed.accounting.decodeTokensPerSecond, 80);
      const streamed = await runtime.runPromise(
        router.stream({
          ...work,
          requestId: "stream",
          routing: { sessionId: "session", boundary: "continue" },
          stream: true,
        }),
      );
      const text = await new Response(streamed.body).text();
      const events = text
        .split("\n\n")
        .filter(Boolean)
        .map((line) => line.slice(6));
      assert.equal(events.pop(), "[DONE]");
      const parsed = events.map((event) => JSON.parse(event));
      const usageEvents = parsed.filter(
        (event) => event.usage !== null && typeof event.usage === "object",
      );
      assert.equal(usageEvents.length, 1);
      assert.deepEqual(parsed.at(-1).choices, []);
      assert.equal(parsed.at(-1).usage.cost, 0.000115);
      assert.equal(
        parsed
          .flatMap((event) => event.choices)
          .filter((choice) => choice.finish_reason === "tool_calls").length,
        1,
      );
      assert.equal(
        parsed.some((event) =>
          event.choices.some(
            (choice: { delta?: { tool_calls?: unknown } }) => choice.delta?.tool_calls,
          ),
        ),
        true,
      );
      assert.equal(streamed.accounting.reuse, "session");
      assert.equal(streamed.accounting.cachedInputTokens, 50);
      assert.equal(requests.length, 2);
    } finally {
      await runtime.dispose();
      server.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    }
  });
}
