import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import test from "node:test";
import type { AppAttribution } from "../../src/domain.ts";
import type { InferenceDeps, RoutedWork } from "../../src/http/contracts.ts";
import { ModelNotAllowed } from "../../src/errors.ts";
import { GatewayFailure } from "../../src/http/gateway-failure.ts";
import { handleChatCompletions } from "../../src/http/inference.ts";
import { GATEWAY_EFFECT_TIMEOUT_MS } from "../../src/http/limits.ts";
import { inferenceDeps, jsonRequest, memoryKeys, ORIGIN, samplePolicy } from "./helpers.ts";

const completion = {
  id: "cmpl",
  choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
};

test("chat requests release deadlines at terminal response or stream cancellation", async () => {
  const outstanding = new Set<number>();
  const hook = createHook({
    init(id, type, _trigger, resource) {
      if (
        type === "Timeout" &&
        (resource as { _idleTimeout?: number })._idleTimeout === GATEWAY_EFFECT_TIMEOUT_MS
      )
        outstanding.add(id);
    },
    destroy(id) {
      outstanding.delete(id);
    },
  });
  const keys = memoryKeys();
  let keepStreamOpen = false;
  const deps = inferenceDeps(keys, {
    complete: async () => ({
      headers: { requestId: "r", deploymentId: "d", sessionId: "s", appliedEffort: "low" },
      body: completion,
      metadata: () => ({ deploymentId: "d" }),
    }),
    stream: async () => ({
      headers: { requestId: "r", deploymentId: "d", sessionId: "s", appliedEffort: "low" },
      body: new ReadableStream({
        start(controller) {
          if (!keepStreamOpen) controller.close();
        },
      }),
      metadata: () => ({ deploymentId: "d" }),
    }),
  });
  hook.enable();
  try {
    for (const stream of [false, true]) {
      for (let index = 0; index < 4; index++) {
        const response = await handleChatCompletions(
          jsonRequest(ORIGIN + "/v1/chat/completions", {
            method: "POST",
            headers: { authorization: "Bearer k" },
            json: { model: "auto", stream, messages: [{ role: "user", content: "hi" }] },
          }),
          deps,
        );
        assert.equal(response.status, 200);
        if (stream) await response.text();
      }
    }
    // Node emits the async_hooks destroy notification for clearTimeout on the next turn.
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(outstanding.size, 0, "finished responses must not hold eleven-minute deadlines");
    keepStreamOpen = true;
    const active = await handleChatCompletions(
      jsonRequest(ORIGIN + "/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer k" },
        json: { model: "auto", stream: true, messages: [{ role: "user", content: "hi" }] },
      }),
      deps,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(outstanding.size, 1, "an open SSE response still needs its deadline");
    await active.body?.cancel();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(keys.finalizes.at(-1)?.status, "abandoned");
    assert.equal(outstanding.size, 0, "cancelling SSE must release its deadline");
  } finally {
    hook.disable();
  }
});

test("gateway deadline aborts a hung inference and records abandonment", async (t) => {
  const nativeSetTimeout = globalThis.setTimeout;
  let expire: (() => void) | undefined;
  t.mock.method(globalThis, "setTimeout", ((
    callback: (...args: unknown[]) => void,
    ms?: number,
    ...args: unknown[]
  ) => {
    if (ms === GATEWAY_EFFECT_TIMEOUT_MS) expire = () => callback(...args);
    return nativeSetTimeout(callback, ms, ...args);
  }) as typeof setTimeout);
  const keys = memoryKeys();
  let dispatched!: () => void;
  const started = new Promise<void>((resolve) => {
    dispatched = resolve;
  });
  const pending = handleChatCompletions(
    jsonRequest(ORIGIN + "/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer k" },
      json: { model: "auto", messages: [{ role: "user", content: "hi" }] },
    }),
    inferenceDeps(keys, {
      complete: async (_work, _hooks, signal) => {
        dispatched();
        assert.ok(signal);
        return await new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
      stream: async () => {
        throw new Error("unexpected stream");
      },
    }),
  );
  await started;
  assert.ok(expire, "an in-flight request must have an overall deadline");
  expire();
  await pending;
  assert.equal(keys.finalizes[0]?.status, "abandoned");
  assert.equal(keys.finalizes[0]?.errorCode, "Cancelled");
});
test("admits an OMP-shaped streamed request without sending client storage controls to routing", async () => {
  const keys = memoryKeys();
  let routed = false;
  const response = await handleChatCompletions(
    jsonRequest(ORIGIN + "/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer k" },
      json: {
        model: "auto",
        messages: [
          { role: "system", content: "You are a coding assistant." },
          { role: "user", content: "Reply captured" },
        ],
        tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
        max_completion_tokens: 8192,
        store: false,
        stream: true,
        stream_options: { include_usage: true },
      },
    }),
    inferenceDeps(keys, {
      complete: async () => {
        throw new Error("unexpected non-streaming dispatch");
      },
      stream: async (work) => {
        routed = true;
        assert.equal("store" in work, false);
        return {
          headers: { requestId: "r", deploymentId: "d", sessionId: "s", appliedEffort: "low" },
          body: new ReadableStream({
            start(controller) {
              controller.close();
            },
          }),
          metadata: () => ({ deploymentId: "d" }),
        };
      },
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(routed, true);
  await response.body?.cancel();
});

test("keeps client identity and storage metadata private while retaining parallel tool control", async () => {
  const keys = memoryKeys();
  let dispatched = false;
  const response = await handleChatCompletions(
    jsonRequest(ORIGIN + "/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer k" },
      json: {
        model: "auto",
        messages: [{ role: "user", content: "hi" }],
        store: true,
        user: "private-user",
        metadata: { account: "private-account" },
        service_tier: "priority",
        prompt_cache_key: "private-cache-key",
        safety_identifier: "private-safety-id",
        parallel_tool_calls: false,
        n: 1,
        stop: "HALT",
        max_completion_tokens: 128,
      },
    }),
    inferenceDeps(keys, {
      complete: async (work) => {
        dispatched = true;
        assert.equal(work.parallelToolCalls, false);
        assert.equal(work.sampling?.stop, "HALT");
        assert.equal(work.maxCompletionTokens, 128);
        for (const field of [
          "store",
          "user",
          "metadata",
          "service_tier",
          "prompt_cache_key",
          "safety_identifier",
        ]) {
          assert.equal(field in work, false);
        }
        return {
          headers: { requestId: "r", deploymentId: "d", sessionId: "s", appliedEffort: "low" },
          body: completion,
          metadata: () => ({ deploymentId: "d" }),
        };
      },
      stream: async () => {
        throw new Error("unexpected stream");
      },
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(dispatched, true);
});

test("rejects unknown, unsupported, and multi-choice controls before admission", async () => {
  for (const control of [
    { enable_thinking: false },
    { nonsense: 1 },
    { n: 2 },
    { logprobs: true },
    { top_logprobs: 2 },
    { logit_bias: { "42": 1 } },
    { reasoning_effort: "maximal" },
    { routing: { sessionId: "s", pin: true } },
    { parallel_tool_calls: "no" },
    { metadata: { user: 42 } },
  ]) {
    const keys = memoryKeys();
    const response = await handleChatCompletions(
      jsonRequest(ORIGIN + "/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer k" },
        json: { model: "auto", messages: [{ role: "user", content: "hi" }], ...control },
      }),
      inferenceDeps(keys, {
        complete: async () => {
          throw new Error("must not dispatch");
        },
        stream: async () => {
          throw new Error("must not dispatch");
        },
      }),
    );
    assert.equal(response.status, 400, JSON.stringify(control));
    assert.equal(keys.admits, 0, JSON.stringify(control));
  }
});

test("rejects malformed tool choice and response format before dispatch", async () => {
  for (const control of [
    { tool_choice: true },
    { tool_choice: 2 },
    { tool_choice: "" },
    { tool_choice: "sometimes" },
    { tool_choice: [] },
    { tool_choice: {} },
    { tool_choice: { type: "function", function: { name: 2 } } },
    { response_format: 2 },
    { response_format: { type: "magic" } },
    { response_format: { type: "json_schema" } },
    { response_format: { type: "json_schema", json_schema: { name: "data", schema: 2 } } },
  ]) {
    const keys = memoryKeys();
    const response = await handleChatCompletions(
      jsonRequest(ORIGIN + "/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer k" },
        json: { model: "auto", messages: [{ role: "user", content: "hi" }], ...control },
      }),
      inferenceDeps(keys, {
        complete: async () => ({
          headers: { requestId: "r", deploymentId: "d", sessionId: "s", appliedEffort: "low" },
          body: completion,
          metadata: () => ({ deploymentId: "d" }),
        }),
        stream: async () => {
          throw new Error("unexpected stream");
        },
      }),
    );
    assert.equal(response.status, 400, JSON.stringify(control));
    assert.equal(((await response.json()) as { error: { code: string } }).error.code, "invalid");
    assert.equal(keys.admits, 0, JSON.stringify(control));
    assert.equal(keys.finalizes.length, 0, JSON.stringify(control));
  }
});

test("accepts validated named tools and JSON schema without discarding their constraints", async () => {
  const keys = memoryKeys();
  let routed = false;
  const choice = { type: "function", function: { name: "read" } };
  const format = {
    type: "json_schema",
    json_schema: { name: "result", schema: { type: "object" }, strict: true },
  };
  const response = await handleChatCompletions(
    jsonRequest(ORIGIN + "/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer k" },
      json: {
        model: "auto",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
        tool_choice: choice,
        response_format: format,
      },
    }),
    inferenceDeps(keys, {
      complete: async (work) => {
        routed = true;
        assert.deepEqual(work.toolChoice, choice);
        assert.deepEqual(work.responseFormat, format);
        assert.equal(work.capabilities.json, true);
        return {
          headers: { requestId: "r", deploymentId: "d", sessionId: "s", appliedEffort: "low" },
          body: completion,
          metadata: () => ({ deploymentId: "d" }),
        };
      },
      stream: async () => {
        throw new Error("unexpected stream");
      },
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(routed, true);
});

test("treats an explicit text response format as the default so format-less deployments stay eligible", async () => {
  const keys = memoryKeys();
  let routed = false;
  const response = await handleChatCompletions(
    jsonRequest(ORIGIN + "/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer k" },
      json: {
        model: "auto",
        messages: [{ role: "user", content: "hi" }],
        response_format: { type: "text" },
      },
    }),
    inferenceDeps(keys, {
      complete: async (work) => {
        routed = true;
        assert.equal(work.responseFormat, undefined);
        assert.equal(work.capabilities.json, false);
        return {
          headers: { requestId: "r", deploymentId: "d", sessionId: "s", appliedEffort: "low" },
          body: completion,
          metadata: () => ({ deploymentId: "d" }),
        };
      },
      stream: async () => {
        throw new Error("unexpected stream");
      },
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(routed, true);
});

test("returns local overload with Retry-After and records the typed error", async () => {
  const keys = memoryKeys();
  const response = await handleChatCompletions(
    jsonRequest(ORIGIN + "/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer k" },
      json: { model: "auto", messages: [{ role: "user", content: "hi" }] },
    }),
    inferenceDeps(keys, {
      complete: async () => {
        throw new GatewayFailure(
          Object.assign(new Error("secret not exposed"), {
            _tag: "LocalOverloaded",
            retryAfterSeconds: 7,
          }),
          { deploymentId: "local-qwen" },
        );
      },
      stream: async () => {
        throw new Error("unexpected stream");
      },
    }),
  );
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "7");
  assert.deepEqual(await response.json(), {
    error: { code: "local_overloaded", message: "local deployment overloaded" },
  });
  assert.equal(keys.finalizes[0]?.errorCode, "LocalOverloaded");
  assert.equal(keys.finalizes[0]?.deploymentId, "local-qwen");
});
test("requires bearer authentication", async () => {
  const keys = memoryKeys();
  const response = await handleChatCompletions(
    jsonRequest(`${ORIGIN}/v1/chat/completions`, {
      method: "POST",
      json: { model: "auto", messages: [{ role: "user", content: "hi" }] },
    }),
    inferenceDeps(keys, {
      complete: async () => ({
        headers: { requestId: "r", deploymentId: "d", sessionId: "s", appliedEffort: "low" },
        body: completion,
        metadata: () => ({
          deploymentId: { requestId: "r", deploymentId: "d", sessionId: "s", appliedEffort: "low" }
            .deploymentId,
        }),
      }),
      stream: async () => ({
        headers: { requestId: "r", deploymentId: "d", sessionId: "s", appliedEffort: "low" },
        body: new ReadableStream(),
        metadata: () => ({
          deploymentId: { requestId: "r", deploymentId: "d", sessionId: "s", appliedEffort: "low" }
            .deploymentId,
        }),
      }),
    }),
  );
  assert.equal(response.status, 401);
});

test("rejects orphan tools before dispatch", async () => {
  const keys = memoryKeys();
  let completeCalls = 0;
  const response = await handleChatCompletions(
    jsonRequest(`${ORIGIN}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization:
          "Bearer jrv_aaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
      json: { model: "auto", messages: [{ role: "tool", content: "x", tool_call_id: "1" }] },
    }),
    inferenceDeps(keys, {
      complete: async () => {
        completeCalls += 1;
        return {
          headers: { requestId: "r", deploymentId: "d", sessionId: "s", appliedEffort: "low" },
          body: completion,
          metadata: () => ({
            deploymentId: {
              requestId: "r",
              deploymentId: "d",
              sessionId: "s",
              appliedEffort: "low",
            }.deploymentId,
          }),
        };
      },
      stream: async () => ({
        headers: { requestId: "r", deploymentId: "d", sessionId: "s", appliedEffort: "low" },
        body: new ReadableStream(),
        metadata: () => ({
          deploymentId: { requestId: "r", deploymentId: "d", sessionId: "s", appliedEffort: "low" }
            .deploymentId,
        }),
      }),
    }),
  );
  assert.equal(response.status, 400);
  assert.equal(completeCalls, 0);
  assert.equal(keys.admits, 0);
});

test("exposes session metadata and does not retry provider failure", async () => {
  const keys = memoryKeys();
  let completeCalls = 0;
  const ok = await handleChatCompletions(
    jsonRequest(`${ORIGIN}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer k" },
      json: {
        model: "auto",
        messages: [{ role: "user", content: "hi" }],
        routing: { sessionId: "agent-1", boundary: "new-task" },
      },
    }),
    inferenceDeps(keys, {
      complete: async () => {
        completeCalls += 1;
        return {
          headers: {
            requestId: "r",
            deploymentId: "local-qwen",
            sessionId: "agent-1",
            appliedEffort: "low",
          },
          body: completion,
          metadata: () => ({
            deploymentId: {
              requestId: "r",
              deploymentId: "local-qwen",
              sessionId: "agent-1",
              appliedEffort: "low",
            }.deploymentId,
          }),
        };
      },
      stream: async () => ({
        headers: { requestId: "r", deploymentId: "d", sessionId: "s", appliedEffort: "low" },
        body: new ReadableStream(),
        metadata: () => ({
          deploymentId: { requestId: "r", deploymentId: "d", sessionId: "s", appliedEffort: "low" }
            .deploymentId,
        }),
      }),
    }),
  );
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("x-session-id"), "agent-1");
  assert.equal(ok.headers.get("x-deployment-id"), "local-qwen");
  assert.equal(ok.headers.get("x-applied-effort"), "low");
  const failedKeys = memoryKeys();
  const failed = await handleChatCompletions(
    jsonRequest(`${ORIGIN}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer k" },
      json: { model: "auto", messages: [{ role: "user", content: "hi" }] },
    }),
    inferenceDeps(failedKeys, {
      complete: async () => {
        completeCalls += 1;
        throw Object.assign(new Error("upstream"), { _tag: "ProviderFailure" });
      },
      stream: async () => ({
        headers: { requestId: "r", deploymentId: "d", sessionId: "s", appliedEffort: "low" },
        body: new ReadableStream(),
        metadata: () => ({
          deploymentId: { requestId: "r", deploymentId: "d", sessionId: "s", appliedEffort: "low" }
            .deploymentId,
        }),
      }),
    }),
  );
  assert.equal(failed.status, 502);
  assert.equal(completeCalls, 2);
  const error = (await failed.json()) as { error: { message: string } };
  assert.equal(error.error.message.includes("Bearer"), false);
});

test("SSE responses use event-stream and do not call complete", async () => {
  const keys = memoryKeys();
  let completeCalls = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
      controller.close();
    },
  });
  const response = await handleChatCompletions(
    jsonRequest(`${ORIGIN}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer k" },
      json: { model: "auto", stream: true, messages: [{ role: "user", content: "hi" }] },
    }),
    inferenceDeps(keys, {
      complete: async () => {
        completeCalls += 1;
        return {
          headers: { requestId: "r", deploymentId: "d", sessionId: "s", appliedEffort: "low" },
          body: completion,
          metadata: () => ({
            deploymentId: {
              requestId: "r",
              deploymentId: "d",
              sessionId: "s",
              appliedEffort: "low",
            }.deploymentId,
          }),
        };
      },
      stream: async () => ({
        headers: { requestId: "r", deploymentId: "d", sessionId: "s", appliedEffort: "low" },
        body,
        metadata: () => ({
          deploymentId: { requestId: "r", deploymentId: "d", sessionId: "s", appliedEffort: "low" }
            .deploymentId,
        }),
      }),
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type")?.includes("text/event-stream"), true);
  assert.equal(completeCalls, 0);
});

test("streaming overload sends a terminal structured SSE error after commitment", async () => {
  const keys = memoryKeys();
  const response = await handleChatCompletions(
    jsonRequest(ORIGIN + "/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer k" },
      json: { model: "auto", stream: true, messages: [{ role: "user", content: "hi" }] },
    }),
    inferenceDeps(keys, {
      complete: async () => {
        throw new Error("unexpected completion");
      },
      stream: async () => {
        throw Object.assign(new Error("private overload detail"), {
          _tag: "LocalOverloaded",
          retryAfterSeconds: 3,
        });
      },
    }),
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  const events = await response.text();
  assert.match(events, /event: router\.error/);
  assert.match(events, /"code":"local_overloaded"/);
  assert.match(events, /"retry_after_seconds":3/);
  assert.doesNotMatch(events, /private overload detail/);
  assert.equal(keys.finalizes[0]?.errorCode, "LocalOverloaded");
});
test("streaming failures before provider output send a terminal structured SSE error", async () => {
  const keys = memoryKeys();
  const response = await handleChatCompletions(
    jsonRequest(ORIGIN + "/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer k" },
      json: { model: "auto", stream: true, messages: [{ role: "user", content: "hi" }] },
    }),
    inferenceDeps(keys, {
      complete: async () => {
        throw new Error("unexpected completion");
      },
      stream: async () => {
        throw Object.assign(new Error("private routing detail"), { _tag: "NoEligibleModel" });
      },
    }),
  );
  assert.equal(response.status, 200);
  const events = await response.text();
  assert.match(events, /event: router\.error/);
  assert.match(events, /"code":"no_eligible_model"/);
  assert.doesNotMatch(events, /retry_after_seconds/);
  assert.doesNotMatch(events, /private routing detail/);
  assert.equal(keys.finalizes[0]?.errorCode, "NoEligibleModel");
});
test("provider failure after streamed output aborts instead of closing cleanly", async () => {
  const keys = memoryKeys();
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      if (pulls === 1) controller.enqueue(new TextEncoder().encode('data: {"partial":true}\n\n'));
      else controller.error(new Error("upstream reset"));
    },
  });
  const response = await handleChatCompletions(
    jsonRequest(ORIGIN + "/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer k" },
      json: { model: "auto", stream: true, messages: [{ role: "user", content: "hi" }] },
    }),
    inferenceDeps(keys, {
      complete: async () => {
        throw new Error("unexpected completion");
      },
      stream: async () => ({
        headers: { requestId: "r", deploymentId: "d", sessionId: "s", appliedEffort: "low" },
        body,
        metadata: () => ({ deploymentId: "d" }),
      }),
    }),
  );
  assert.equal(response.status, 200);
  await assert.rejects(response.text());
});
test("reasoning_effort passes through, with minimal folded into low", async () => {
  for (const [requested, expected] of [
    ["minimal", "low"],
    ["none", "none"],
    ["xhigh", "xhigh"],
    [undefined, undefined],
  ] as const) {
    let seen: unknown = "not called";
    const response = await handleChatCompletions(
      jsonRequest(ORIGIN + "/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer k" },
        json: {
          model: "auto",
          messages: [{ role: "user", content: "hi" }],
          ...(requested === undefined ? {} : { reasoning_effort: requested }),
        },
      }),
      inferenceDeps(memoryKeys(), {
        complete: async (work) => {
          seen = work.reasoningEffort;
          return {
            headers: { requestId: "r", deploymentId: "d", appliedEffort: "low" },
            body: completion,
            metadata: () => ({ deploymentId: "d" }),
          };
        },
        stream: async () => {
          throw new Error("unexpected stream");
        },
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(seen, expected, String(requested));
  }
});

test("a session comes from routing.sessionId or the Open WebUI chat id and never fails a request", async () => {
  const cases: Array<{ json?: Record<string, unknown>; header?: string; session?: string }> = [
    // Older clients' boundary protocol is accepted and ignored.
    {
      json: {
        routing: {
          sessionId: "agent-1",
          boundary: "continue",
          taskBrief: "fix the bug",
          qualityOverride: "highest",
        },
      },
      session: "agent-1",
    },
    { json: { routing: { boundary: "checkpoint" } }, session: undefined },
    { header: "chat-42", session: "webui:chat-42" },
    { json: { routing: { sessionId: "explicit" } }, header: "chat-42", session: "explicit" },
    { header: "not a valid id!", session: undefined },
    { session: undefined },
  ];
  for (const { json, header, session } of cases) {
    let seen: unknown = "not called";
    const response = await handleChatCompletions(
      jsonRequest(ORIGIN + "/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer k",
          ...(header === undefined ? {} : { "x-openwebui-chat-id": header }),
        },
        json: {
          model: "auto",
          messages: [
            { role: "user", content: "hi" },
            { role: "assistant", content: "hello" },
            { role: "user", content: "again" },
          ],
          ...json,
        },
      }),
      inferenceDeps(memoryKeys(), {
        complete: async (work) => {
          seen = work.sessionId;
          return {
            headers: {
              requestId: "r",
              deploymentId: "d",
              ...(work.sessionId === undefined ? {} : { sessionId: work.sessionId }),
              appliedEffort: "low",
            },
            body: completion,
            metadata: () => ({ deploymentId: "d" }),
          };
        },
        stream: async () => {
          throw new Error("unexpected stream");
        },
      }),
    );
    assert.equal(response.status, 200, JSON.stringify({ json, header }));
    assert.equal(seen, session, JSON.stringify({ json, header }));
    const header_ = response.headers.get("x-session-id");
    assert.equal(header_ === null ? undefined : decodeURIComponent(header_), session);
  }
});

test("flex requests carry the tier; running out of idle compute is 429 resource_unavailable", async () => {
  for (const stream of [false, true]) {
    const keys = memoryKeys();
    const tiers: unknown[] = [];
    const overloaded = () => {
      throw new GatewayFailure(
        Object.assign(new Error("private overload detail"), {
          _tag: "LocalOverloaded",
          retryAfterSeconds: 2,
          flexRefused: true,
        }),
        { deploymentId: "local-qwen" },
      );
    };
    const response = await handleChatCompletions(
      jsonRequest(ORIGIN + "/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer k" },
        json: {
          model: "auto",
          stream,
          service_tier: "flex",
          messages: [{ role: "user", content: "hi" }],
        },
      }),
      inferenceDeps(keys, {
        complete: async (work) => {
          tiers.push(work.serviceTier);
          return overloaded();
        },
        stream: async (work) => {
          tiers.push(work.serviceTier);
          return overloaded();
        },
      }),
    );
    if (stream) {
      // Flex streams take the normal path: 200 committed, then a terminal router.error.
      assert.equal(response.status, 200);
      const events = await response.text();
      assert.match(events, /event: router\.error/);
      assert.match(events, /"code":"resource_unavailable"/);
      assert.match(events, /"retry_after_seconds":2/);
      assert.doesNotMatch(events, /private overload detail/);
    } else {
      assert.equal(response.status, 429);
      assert.equal(response.headers.get("retry-after"), "2");
      assert.deepEqual(await response.json(), {
        error: {
          code: "resource_unavailable",
          message: "no spare local capacity for a flex request",
        },
      });
    }
    assert.deepEqual(tiers, ["flex"]);
    assert.equal(keys.finalizes[0]?.errorCode, "LocalOverloaded");
    assert.equal(keys.finalizes[0]?.deploymentId, "local-qwen");
  }
});

test("low-priority keys run as flex; other keys only when they ask", async () => {
  const cases = [
    { priority: "low", requested: undefined, tier: "flex" },
    { priority: "low", requested: "default", tier: "flex" },
    { priority: "medium", requested: undefined, tier: undefined },
    { priority: "high", requested: "flex", tier: "flex" },
  ] as const;
  for (const { priority, requested, tier } of cases) {
    const base = memoryKeys();
    const keys = {
      ...base,
      admit: async (raw: string) => ({
        ...(await base.admit(raw)),
        policy: samplePolicy({ priority }),
      }),
    };
    let seen: unknown = "not called";
    const response = await handleChatCompletions(
      jsonRequest(ORIGIN + "/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer k" },
        json: {
          model: "auto",
          messages: [{ role: "user", content: "hi" }],
          ...(requested === undefined ? {} : { service_tier: requested }),
        },
      }),
      inferenceDeps(keys, {
        complete: async (work) => {
          seen = work.serviceTier;
          throw new Error("stop after routing");
        },
        stream: async () => {
          throw new Error("not streaming");
        },
      }),
    );
    assert.equal(response.status >= 400, true);
    assert.equal(seen, tier, `${priority} asking for ${requested ?? "nothing"}`);
  }
});

test("other service tiers route normally and keep the local overload shape", async () => {
  for (const tier of ["auto", "default", "priority"]) {
    const keys = memoryKeys();
    let seen: unknown = "unset";
    const response = await handleChatCompletions(
      jsonRequest(ORIGIN + "/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer k" },
        json: { model: "auto", service_tier: tier, messages: [{ role: "user", content: "hi" }] },
      }),
      inferenceDeps(keys, {
        complete: async (work) => {
          seen = work.serviceTier;
          throw Object.assign(new Error("busy"), { _tag: "LocalOverloaded", retryAfterSeconds: 1 });
        },
        stream: async () => {
          throw new Error("unexpected stream");
        },
      }),
    );
    assert.equal(seen, undefined, tier);
    assert.equal(response.status, 503, tier);
    assert.equal((await response.json()).error.code, "local_overloaded");
  }
});

function attributedChat(headers: Record<string, string>, gateway: InferenceDeps["gateway"]) {
  const keys = memoryKeys();
  const response = handleChatCompletions(
    jsonRequest(ORIGIN + "/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer k", ...headers },
      json: { model: "auto", messages: [{ role: "user", content: "hi" }] },
    }),
    inferenceDeps(keys, gateway),
  );
  return { keys, response };
}

function capturingGateway(): { gateway: InferenceDeps["gateway"]; seen: RoutedWork[] } {
  const seen: RoutedWork[] = [];
  return {
    seen,
    gateway: {
      complete: async (work) => {
        seen.push(work);
        return {
          headers: { requestId: "r", deploymentId: "d", sessionId: "s", appliedEffort: "low" },
          body: completion,
          metadata: () => ({ deploymentId: "d" }),
        };
      },
      stream: async () => {
        throw new Error("unexpected stream");
      },
    },
  };
}

test("records client app attribution and hands it to routing as advisory metadata", async () => {
  const { gateway, seen } = capturingGateway();
  const { keys, response } = attributedChat(
    {
      "HTTP-Referer": "https://vibe.example/studio",
      "X-OpenRouter-Title": "  Free Vibecode ",
      "X-Title": "Legacy name",
      "X-OpenRouter-Categories": "programming-app, native-app-builder",
      "X-OpenRouter-App-Visibility": "hidden",
    },
    gateway,
  );
  assert.equal((await response).status, 200);
  assert.deepEqual(seen[0]?.appAttribution, {
    url: "https://vibe.example/studio",
    title: "Free Vibecode",
    categories: "programming-app,native-app-builder",
    visibility: "hidden",
  });
  assert.equal(seen[0]?.policy.priority, samplePolicy().priority);
  assert.equal(keys.finalizes[0]?.status, "success");
  assert.equal(keys.finalizes[0]?.appUrl, "https://vibe.example/studio");
  assert.equal(keys.finalizes[0]?.appTitle, "Free Vibecode");
});

test("records attribution on failed requests too", async () => {
  const { keys, response } = attributedChat(
    { "HTTP-Referer": "https://vibe.example", "X-Title": "Free Vibecode" },
    {
      complete: async () => {
        throw Object.assign(new Error("no route"), { _tag: "NoEligibleModel" });
      },
      stream: async () => {
        throw new Error("unexpected stream");
      },
    },
  );
  assert.notEqual((await response).status, 200);
  assert.equal(keys.finalizes[0]?.status, "error");
  assert.equal(keys.finalizes[0]?.appUrl, "https://vibe.example");
  assert.equal(keys.finalizes[0]?.appTitle, "Free Vibecode");
});

test("ignores invalid app attribution without failing the request", async () => {
  const cases: Array<[Record<string, string>, AppAttribution | undefined]> = [
    [
      {
        "HTTP-Referer": "javascript:alert(1)",
        "X-OpenRouter-Title": "   ",
        "X-OpenRouter-Categories": "game",
        "X-OpenRouter-App-Visibility": "hidden",
      },
      undefined,
    ],
    [{ "HTTP-Referer": "https://user:secret@vibe.example/" }, undefined],
    [{ "HTTP-Referer": "ftp://vibe.example/" }, undefined],
    [{ "HTTP-Referer": "/relative/path" }, undefined],
    [{ "HTTP-Referer": `https://vibe.example/${"a".repeat(512)}` }, undefined],
    [{ "X-OpenRouter-Title": "x".repeat(129) }, undefined],
    [{ "X-OpenRouter-Title": "Free\tVibecode" }, undefined],
    [
      {
        "HTTP-Referer": "https://vibe.example a",
        "X-OpenRouter-Title": "t".repeat(129),
        "X-Title": "Old tool",
        "X-OpenRouter-Categories": "cli-agent,game,roleplay",
        "X-OpenRouter-App-Visibility": "public",
      },
      { title: "Old tool" },
    ],
    [
      {
        "HTTP-Referer": "http://localhost:3000/",
        "X-OpenRouter-Categories": "Programming-App",
      },
      { url: "http://localhost:3000/" },
    ],
    [
      {
        "X-Title": "Old tool",
        "X-OpenRouter-Categories": `${"a".repeat(31)}`,
      },
      { title: "Old tool" },
    ],
  ];
  for (const [headers, expected] of cases) {
    const { gateway, seen } = capturingGateway();
    const { keys, response } = attributedChat(headers, gateway);
    assert.equal((await response).status, 200, JSON.stringify(headers));
    assert.deepEqual(seen[0]?.appAttribution, expected, JSON.stringify(headers));
    assert.equal(keys.finalizes[0]?.appUrl ?? null, expected?.url ?? null);
    assert.equal(keys.finalizes[0]?.appTitle ?? null, expected?.title ?? null);
  }
});
test("a pinned model the key may not use is a clear 403, and the pinned id reaches the gateway", async () => {
  const keys = memoryKeys();
  let requested: string | undefined;
  const response = await handleChatCompletions(
    jsonRequest(ORIGIN + "/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer k" },
      json: { model: "llm-router/z-ai/glm-5.3-flash", messages: [{ role: "user", content: "hi" }] },
    }),
    inferenceDeps(keys, {
      complete: async (work) => {
        requested = work.model;
        throw new ModelNotAllowed({
          message: "z-ai/glm-5.3-flash is a cloud model and this key has cloud disabled",
        });
      },
      stream: async () => {
        throw new Error("unexpected stream");
      },
    }),
  );
  assert.equal(requested, "z-ai/glm-5.3-flash");
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    error: {
      code: "forbidden",
      message: "z-ai/glm-5.3-flash is a cloud model and this key has cloud disabled",
    },
  });
});
