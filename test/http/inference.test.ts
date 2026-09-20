import assert from "node:assert/strict";
import test from "node:test";
import { handleChatCompletions } from "../../src/http/inference.ts";
import { inferenceDeps, jsonRequest, memoryKeys, ORIGIN } from "./helpers.ts";

const completion = {
  id: "cmpl",
  choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
};

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
