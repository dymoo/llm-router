import assert from "node:assert/strict";
import test from "node:test";
import { decodeChatCompletion } from "../../src/http/decode.ts";
import { InvalidInput } from "../../src/http/errors.ts";
import { validateToolSequence } from "../../src/http/protocol.ts";

test("rejects orphan tool messages", () => {
  assert.throws(
    () =>
      decodeChatCompletion({
        model: "auto",
        messages: [{ role: "tool", content: "ok", tool_call_id: "call_1" }],
      }),
    InvalidInput,
  );
});

test("accepts assistant tool calls followed by matching results", () => {
  const decoded = decodeChatCompletion({
    model: "auto",
    messages: [
      { role: "user", content: "run" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "ls", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "ok" },
    ],
  });
  assert.equal(validateToolSequence(decoded.messages).pendingToolCalls, 0);
});

test("rejects provider-specific controls that could bypass routing policy", () => {
  assert.throws(
    () =>
      decodeChatCompletion({
        model: "auto",
        messages: [{ role: "user", content: "hi" }],
        enable_thinking: false,
      }),
    InvalidInput,
  );
});

test("rejects session ids that cannot be encoded or are oversized", () => {
  for (const sessionId of ["bad\uD800id", "s".repeat(257)]) {
    assert.throws(
      () =>
        decodeChatCompletion({
          model: "auto",
          messages: [{ role: "user", content: "hi" }],
          routing: { sessionId },
        }),
      InvalidInput,
    );
  }
});

test("model is auto, cheap or a model id; the llm-router/ prefix is the same name", () => {
  const decode = (model: unknown) =>
    decodeChatCompletion({ model, messages: [{ role: "user", content: "hi" }] }).model;
  assert.equal(decode("auto"), "auto");
  assert.equal(decode("llm-router/auto"), "auto");
  assert.equal(decode("llm-router/cheap"), "cheap");
  assert.equal(decode("z-ai/glm-5.3-flash"), "z-ai/glm-5.3-flash");
  for (const bad of [undefined, "", 7, "x".repeat(257)])
    assert.throws(() => decode(bad), InvalidInput);
});
