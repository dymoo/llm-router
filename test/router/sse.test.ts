import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { observeSseUsage } from "../../src/router/sse.ts";
import type { ProviderUsage } from "../../src/router/accounting.ts";
import { attachUsage } from "../../src/router/cost.ts";
import { localQwen } from "./fixtures.ts";

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const next = await reader.read();
    if (next.done) {
      break;
    }
    chunks.push(next.value);
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

describe("observeSseUsage", () => {
  it("preserves original bytes and records final usage from split SSE frames", async () => {
    const encoder = new TextEncoder();
    const frames = [
      encoder.encode('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n'),
      encoder.encode('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n'),
      encoder.encode(
        'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":4,"completion_tokens_details":{"reasoning_tokens":2},"prompt_tokens_details":{"cached_tokens":3},"cost":0.002},"timings":{"prompt_ms":12,"predicted_ms":50,"predicted_n":4}}\n\n',
      ),
      encoder.encode("data: [DONE]\n\n"),
    ];
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) {
          controller.enqueue(frame);
        }
        controller.close();
      },
    });
    const seen: ProviderUsage[] = [];
    const observed = observeSseUsage(source, (usage) => {
      seen.push(usage);
    });
    const bytes = await collect(observed);
    const text = new TextDecoder().decode(bytes);
    assert.ok(text.includes("Hel"));
    assert.ok(text.includes("[DONE]"));
    assert.equal(seen.length > 0, true);
    const last = seen[seen.length - 1]!;
    assert.equal(last.promptTokens, 11);
    assert.equal(last.completionTokens, 4);
    assert.equal(last.reasoningTokens, 2);
    assert.equal(last.cachedTokens, 3);
    assert.equal(last.providerReportedCostUsd, 0.002);
    assert.equal(last.decodeTokensPerSecond, 80);
  });
});

it("normalizes local usage exactly once before DONE across UTF-8 byte boundaries", async () => {
  const input =
    [
      { id: "completion", choices: [{ delta: { content: "héllo" }, finish_reason: null }] },
      {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 20,
          completion_tokens: 5,
          prompt_tokens_details: { cached_tokens: 10 },
          completion_tokens_details: { reasoning_tokens: 3 },
        },
      },
    ]
      .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
      .join("") + "data: [DONE]\n\n";
  const bytes = new TextEncoder().encode(input);
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  });
  const deployment = {
    ...localQwen,
    prices: {
      ...localQwen.prices,
      inputUsdPerMillion: 2,
      cachedInputUsdPerMillion: 1,
      outputUsdPerMillion: 4,
    },
  };
  const output = new TextDecoder().decode(
    await collect(
      observeSseUsage(
        source,
        () => undefined,
        (frame, usage) => attachUsage(frame, deployment, usage),
      ),
    ),
  );
  const frames = output
    .split("\n\n")
    .filter(Boolean)
    .map((line) => line.slice(6));
  assert.equal(frames.pop(), "[DONE]");
  const parsed = frames.map((frame) => JSON.parse(frame));
  assert.equal(parsed.filter((frame) => frame.usage !== undefined).length, 1);
  const usage = parsed.at(-1).usage;
  assert.equal(usage.total_tokens, 25);
  assert.equal(usage.completion_tokens_details.reasoning_tokens, 3);
  assert.equal(usage.prompt_tokens_details.cached_tokens, 10);
  assert.equal(usage.cost, 0.00005);
  assert.equal("cost_source" in usage, false);
  assert.equal(parsed[0].choices[0].delta.content, "héllo");
});

it("rejects truncated and oversized streams instead of reporting success", async () => {
  for (const text of ['data: {"choices":[]}\n\n', `data: ${"x".repeat(256 * 1024 + 1)}`]) {
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    await assert.rejects(() => collect(observeSseUsage(source, () => undefined)));
  }
});
