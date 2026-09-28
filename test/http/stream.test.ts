import assert from "node:assert/strict";
import test from "node:test";
import { handleChatCompletions } from "../../src/http/inference.ts";
import { memoryKeys, inferenceDeps, jsonRequest, type FinalizeSpy } from "./helpers.ts";

const headers = { requestId: "r", deploymentId: "local", sessionId: "s", appliedEffort: "high" };
function request() {
  return jsonRequest("http://gateway/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer key" },
    json: { model: "auto", stream: true, messages: [{ role: "user", content: "hi" }] },
  });
}

test(
  "downstream cancellation aborts pending routing and records abandonment once",
  { timeout: 2000 },
  async () => {
    const keys = memoryKeys();
    let aborted = false;
    const { promise: finalized, resolve: finish } = Promise.withResolvers<FinalizeSpy>();
    const save = keys.finalize;
    keys.finalize = async (admission, outcome) => {
      await save(admission, outcome);
      finish(outcome);
    };
    const response = await handleChatCompletions(
      request(),
      inferenceDeps(keys, {
        complete: async () => {
          throw new Error("wrong path");
        },
        stream: async (_work, _hooks, signal) => {
          const { promise, reject } = Promise.withResolvers<never>();
          const abort = () => {
            aborted = true;
            reject(new Error("cancelled"));
          };
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
          return promise;
        },
      }),
    );
    await response.body!.cancel();
    assert.equal((await finalized).status, "abandoned");
    assert.equal(aborted, true);
    assert.equal(keys.finalizes.length, 1);
  },
);

test("stream accounting uses terminal measured usage instead of unknown counters", async () => {
  const keys = memoryKeys();
  let usage = 0;
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      usage = 17;
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  const response = await handleChatCompletions(
    request(),
    inferenceDeps(keys, {
      complete: async () => {
        throw new Error("wrong path");
      },
      stream: async () => ({
        headers,
        body: source,
        metadata: () => ({
          deploymentId: "local",
          promptTokens: usage,
          completionTokens: 5,
          localComputeEstimatedUsd: 0.002,
        }),
      }),
    }),
  );
  await response.text();
  assert.equal(keys.finalizes.length, 1);
  assert.equal(keys.finalizes[0]?.promptTokens, 17);
  assert.equal(keys.finalizes[0]?.localComputeEstimatedUsd, 0.002);
  assert.equal(keys.finalizes[0]?.status, "success");
});

test(
  "disconnect after dispatch cancels the upstream reader and keeps observed metadata",
  { timeout: 2000 },
  async () => {
    const keys = memoryKeys();
    let cancelled = false;
    const { promise: finalized, resolve: finish } = Promise.withResolvers<FinalizeSpy>();
    keys.finalize = async (_admission, outcome) => {
      finish(outcome);
    };
    const response = await handleChatCompletions(
      request(),
      inferenceDeps(keys, {
        complete: async () => {
          throw new Error("wrong path");
        },
        stream: async () => ({
          headers,
          metadata: () => ({ deploymentId: "local", promptTokens: 10 }),
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('data: {"choices":[]}\n\n'));
            },
            cancel() {
              cancelled = true;
            },
          }),
        }),
      }),
    );
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    const outcome = await finalized;
    assert.equal(cancelled, true);
    assert.equal(outcome.status, "abandoned");
    assert.equal(outcome.promptTokens, 10);
  },
);

test("persistence failure cannot report a successfully completed stream", async () => {
  const keys = memoryKeys();
  keys.finalize = async () => {
    throw new Error("database unavailable");
  };
  const response = await handleChatCompletions(
    request(),
    inferenceDeps(keys, {
      complete: async () => {
        throw new Error("wrong path");
      },
      stream: async () => ({
        headers,
        metadata: () => ({}),
        body: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
      }),
    }),
  );
  await assert.rejects(() => response.text());
});
