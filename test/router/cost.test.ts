import assert from "node:assert/strict";
import test from "node:test";
import { attachUsage } from "../../src/router/cost.ts";
import { readProviderUsage } from "../../src/router/accounting.ts";
import { localQwen, cloudGlm } from "./fixtures.ts";

function costOf(usage: unknown) {
  assert.ok(usage !== null && typeof usage === "object" && "cost" in usage);
  return usage.cost;
}

const body = {
  choices: [{ message: { role: "assistant", content: "answer" } }],
  usage: {
    prompt_tokens: 100,
    completion_tokens: 20,
    prompt_tokens_details: { cached_tokens: 40 },
    completion_tokens_details: { reasoning_tokens: 8 },
  },
};
const priced = {
  ...localQwen,
  prices: {
    ...localQwen.prices,
    inputUsdPerMillion: 2,
    cachedInputUsdPerMillion: 1,
    outputUsdPerMillion: 4,
  },
};

test("local costs charge cached input once and never double-count reasoning output", () => {
  const result = attachUsage(body, priced, readProviderUsage(body));
  assert.deepEqual(result.usage, {
    ...body.usage,
    total_tokens: 120,
    cost: 0.00024,
    cost_details: {
      upstream_inference_cost: 0,
      upstream_inference_prompt_cost: 0,
      upstream_inference_completions_cost: 0,
    },
  });
});

test("unknown cache counts are not hits and cannot invent a discount", () => {
  const input = { ...body, usage: { prompt_tokens: 100, completion_tokens: 20 } };
  const result = attachUsage(input, priced, readProviderUsage(input));
  assert.equal(costOf(result.usage), null);
  const equalRates = { ...priced, prices: { ...priced.prices, cachedInputUsdPerMillion: 2 } };
  assert.equal(costOf(attachUsage(input, equalRates, readProviderUsage(input)).usage), 0.00028);
});

test("unknown local prices differ from explicitly configured zero rates", () => {
  const unknown = {
    ...localQwen,
    prices: {
      ...localQwen.prices,
      provenance: { ...localQwen.prices.provenance, source: "unknown" },
    },
  };
  assert.equal(costOf(attachUsage(body, unknown, readProviderUsage(body)).usage), null);
  assert.equal(costOf(attachUsage(body, localQwen, readProviderUsage(body)).usage), 0);
});

test("cloud provider usage is passed through without local rate-card rewrites", () => {
  const cloud = {
    ...body,
    usage: { ...body.usage, cost: 0.12, cost_details: { upstream_inference_cost: 0.1 } },
  };
  assert.deepEqual(attachUsage(cloud, cloudGlm, readProviderUsage(cloud)), cloud);
});

test("negative or fractional token counts are not accepted as measured usage", () => {
  const malformed = { usage: { prompt_tokens: -1, completion_tokens: 2.5, cost: -0.1 } };
  const usage = readProviderUsage(malformed);
  assert.equal(usage.promptTokens, null);
  assert.equal(usage.completionTokens, null);
  assert.equal(usage.providerReportedCostUsd, null);
  assert.throws(() => attachUsage(malformed, priced, usage), { _tag: "ProviderFailure" });
});
