import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import test from "node:test";
import { GatewayFailure } from "../../src/http/gateway-failure.ts";
import { handleChatCompletions } from "../../src/http/inference.ts";
import { GATEWAY_EFFECT_TIMEOUT_MS } from "../../src/http/limits.ts";
import { inferenceDeps, jsonRequest, memoryKeys, ORIGIN } from "./helpers.ts";

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

test("client completion budget cannot exceed the key policy", async () => {
  const keys = memoryKeys();
  const response = await handleChatCompletions(
    jsonRequest(ORIGIN + "/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer k" },
      json: {
        model: "auto",
        messages: [{ role: "user", content: "hi" }],
        max_completion_tokens: 8193,
        store: false,
      },
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
  assert.equal(response.status, 422);
  assert.equal(((await response.json()) as { error: { code: string } }).error.code, "invalid");
  assert.equal(keys.admits, 1);
  assert.equal(keys.finalizes[0]?.errorCode, "ImpossibleLimits");
});

test("rejects unknown, unsupported, and multi-choice controls before admission", async () => {
  for (const control of [
    { enable_thinking: false },
    { nonsense: 1 },
    { n: 2 },
    { logprobs: true },
    { top_logprobs: 2 },
    { logit_bias: { "42": 1 } },
    { reasoning_effort: "none" },
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
        throw Object.assign(new Error("private classifier detail"), {
          _tag: "ClassifierUnqualified",
          reason: "missing",
        });
      },
    }),
  );
  assert.equal(response.status, 200);
  const events = await response.text();
  assert.match(events, /event: router\.error/);
  assert.match(events, /"code":"classifier_unqualified"/);
  assert.doesNotMatch(events, /retry_after_seconds/);
  assert.doesNotMatch(events, /private classifier detail/);
  assert.equal(keys.finalizes[0]?.errorCode, "ClassifierUnqualified");
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
test("tool schemas consume key context budget before any model dispatch", async () => {
  const keys = memoryKeys();
  const admit = keys.admit;
  keys.admit = async (secret) => {
    const lease = await admit(secret);
    return {
      ...lease,
      policy: { ...lease.policy, contextLimitTokens: 2048, maxCompletionTokens: 128 },
    };
  };
  let dispatched = false;
  const response = await handleChatCompletions(
    jsonRequest(`${ORIGIN}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer test" },
      json: {
        model: "auto",
        messages: [{ role: "user", content: "hi" }],
        tools: [
          { type: "function", function: { name: "large_schema", description: "x".repeat(4096) } },
        ],
      },
    }),
    inferenceDeps(keys, {
      complete: async () => {
        dispatched = true;
        throw new Error("must not dispatch");
      },
      stream: async () => {
        dispatched = true;
        throw new Error("must not dispatch");
      },
    }),
  );
  assert.equal(response.status, 422);
  assert.equal(dispatched, false);
  assert.equal(keys.finalizes[0]?.status, "error");
});
