import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import {
  POLICY_SUGGESTIONS,
  checkCatalogueForInference,
  checkFeasibility,
  decodeCatalogue,
  decodeKeyPolicy,
  explainLocalityBias,
  type Deployment,
  type KeyPolicy,
} from "../src/domain.ts";

const provenance = {
  unit: "operator-configured",
  source: "unverified-sample",
  asOf: null,
};

const localHalogen: Deployment = {
  id: "local-qwen",
  modelId: "qwen3.8-flash-next",
  endpoint: "http://127.0.0.1:8731/v1",
  location: "local",
  transport: "halogen",
  credentialEnvVar: null,
  providerRestriction: null,
  contextLimitTokens: 32_768,
  maxOutputTokens: 8_192,
  capabilities: { tools: true, json: true, vision: false },
  capacity: { maxParallel: 2, reservedInteractiveSlots: 1 },
  quality: {
    chat: 0.6,
    coding: 0.7,
    math: 0.6,
    analysis: 0.6,
    writing: 0.5,
    extraction: 0.6,
    provenance: { unit: "quality prior 0-1", source: "unverified-sample", asOf: null },
  },
  prices: {
    inputUsdPerMillion: 0,
    cachedInputUsdPerMillion: 0,
    outputUsdPerMillion: 0,
    provenance,
  },
  latency: {
    initialMs: 200,
    tokensPerSecond: 40,
    provenance: {
      unit: "milliseconds / tokens per second",
      source: "unverified-sample",
      asOf: null,
    },
  },
  reasoning: { kind: "binary" },
  reasoningTokenEstimates: { none: 0, low: 64, medium: 256, high: 512, xhigh: 1024 },
};

const cloudGlm: Deployment = {
  ...localHalogen,
  id: "cloud-glm",
  modelId: "glm-5.3",
  endpoint: "https://openrouter.ai/api/v1",
  location: "cloud",
  transport: "openrouter",
  credentialEnvVar: "OPENROUTER_API_KEY",
  providerRestriction: "zhipu",
  capabilities: { tools: true, json: true, vision: true },
  prices: {
    inputUsdPerMillion: 1,
    cachedInputUsdPerMillion: 0.1,
    outputUsdPerMillion: 3,
    provenance,
  },
};

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

test("decodes a valid halogen catalogue entry", async () => {
  const catalogue = await run(decodeCatalogue([localHalogen]));
  assert.equal(catalogue[0]?.transport, "halogen");
  assert.equal(catalogue[0]?.location, "local");
});

test("rejects a catalogue missing required deployment fields", async () => {
  await assert.rejects(() => run(decodeCatalogue([{ id: "broken" }])));
});

test("rejects REPLACE_ placeholders for inference", async () => {
  const placeholder: Deployment = {
    ...cloudGlm,
    modelId: "REPLACE_GLM_MODEL",
  };
  await assert.rejects(() => run(checkCatalogueForInference([placeholder])));
});

test("policy suggestions decode as KeyPolicy", async () => {
  for (const policy of Object.values(POLICY_SUGGESTIONS)) {
    const decoded = await run(decodeKeyPolicy(policy));
    assert.equal(
      decoded.priority === "high" || decoded.priority === "medium" || decoded.priority === "low",
      true,
    );
  }
  assert.equal(POLICY_SUGGESTIONS.Dylan.priority, "high");
  assert.equal(POLICY_SUGGESTIONS.Dylan.localityBias, 0.15);
  assert.equal(POLICY_SUGGESTIONS.Balanced.priority, "medium");
  assert.equal(POLICY_SUGGESTIONS.Balanced.localityBias, 0.65);
  assert.equal(POLICY_SUGGESTIONS["Free Vibecode"].localityBias, 0.95);
});

test("explainLocalityBias describes preference not chance", () => {
  assert.match(explainLocalityBias(0), /Cloud-first/);
  assert.match(explainLocalityBias(0.15), /Lean cloud/);
  assert.match(explainLocalityBias(0.65), /Prefer local/);
  assert.match(explainLocalityBias(0.95), /verified runtime saturation/);
});

test("rejects localityBias outside 0-1", async () => {
  await assert.rejects(() =>
    run(
      decodeKeyPolicy({
        ...POLICY_SUGGESTIONS.Dylan,
        localityBias: 1.2,
      }),
    ),
  );
});

test("rejects an all-zero bias", async () => {
  await assert.rejects(() =>
    run(
      decodeKeyPolicy({
        ...POLICY_SUGGESTIONS.Balanced,
        bias: { cost: 0, quality: 0, latency: 0 },
      }),
    ),
  );
});

test("empty allowlist fails closed before ranking", async () => {
  const policy: KeyPolicy = { ...POLICY_SUGGESTIONS.Balanced, allowedModels: [] };
  await assert.rejects(() =>
    run(
      checkFeasibility({
        policy,
        catalogue: [localHalogen, cloudGlm],
        estimatedInputTokens: 100,
        requestedCompletionTokens: 64,
        capabilities: { tools: false, json: false, vision: false },
      }),
    ),
  );
});

test("unsupported vision fails closed", async () => {
  await assert.rejects(() =>
    run(
      checkFeasibility({
        policy: POLICY_SUGGESTIONS.Balanced,
        catalogue: [localHalogen],
        estimatedInputTokens: 100,
        requestedCompletionTokens: 64,
        capabilities: { tools: false, json: false, vision: true },
      }),
    ),
  );
});

test("impossible completion tokens fail closed", async () => {
  await assert.rejects(() =>
    run(
      checkFeasibility({
        policy: POLICY_SUGGESTIONS.Balanced,
        catalogue: [localHalogen],
        estimatedInputTokens: 100,
        requestedCompletionTokens: 100_000,
        capabilities: { tools: false, json: false, vision: false },
      }),
    ),
  );
});

test("feasible local coding request remains eligible", async () => {
  const eligible = await run(
    checkFeasibility({
      policy: POLICY_SUGGESTIONS.Balanced,
      catalogue: [localHalogen, cloudGlm],
      estimatedInputTokens: 800,
      requestedCompletionTokens: 512,
      capabilities: { tools: true, json: true, vision: false },
    }),
  );
  assert.equal(
    eligible.some((deployment) => deployment.id === "local-qwen"),
    true,
  );
});
