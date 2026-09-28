import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Effect, Schema } from "effect";
import {
  KeyPolicy,
  POLICY_SUGGESTIONS,
  checkCatalogueForInference,
  decodeCatalogue,
  decodeStoredKeyPolicy,
  type Deployment,
} from "../src/domain.ts";

const provenance = {
  unit: "operator-configured",
  source: "unverified-sample",
  asOf: null,
};

const localGufo: Deployment = {
  id: "local-qwen",
  modelId: "qwen3.8-flash-next",
  endpoint: "http://127.0.0.1:8000/v1",
  location: "local",
  transport: "gufo",
  credentialEnvVar: null,
  providerRestriction: null,
  contextLimitTokens: 32_768,
  maxOutputTokens: 8_192,
  capabilities: { tools: true, json: true, vision: false },
  capacity: { maxParallel: 2, reservedInteractiveSlots: 1 },
  prices: {
    inputUsdPerMillion: 0,
    cachedInputUsdPerMillion: 0,
    outputUsdPerMillion: 0,
    provenance,
  },
  reasoning: { kind: "binary" },
};

const cloudGlm: Deployment = {
  ...localGufo,
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

test("decodes a valid Gufo catalogue entry", async () => {
  const catalogue = await run(decodeCatalogue([localGufo]));
  assert.equal(catalogue[0]?.transport, "gufo");
  assert.equal(catalogue[0]?.location, "local");
});

test("the example catalogue's Gufo entry decodes but cannot be used before endpoint injection", async () => {
  const raw: unknown = JSON.parse(
    await readFile(new URL("../catalog.example.json", import.meta.url), "utf8"),
  );
  const [gufo] = await run(decodeCatalogue(raw));
  assert.equal(gufo?.transport, "gufo");
  assert.equal(gufo?.modelId, "qwen3.8-flash-next-gufo");
  assert.equal(gufo?.credentialEnvVar, "GUFO_API_KEY");
  assert.deepEqual(gufo?.reasoning, {
    kind: "graded",
    levels: ["none", "low", "medium", "xhigh"],
  });
  assert.deepEqual(gufo?.capacity, { maxParallel: 24, reservedInteractiveSlots: 4 });
  assert.deepEqual(gufo?.capabilities, { tools: true, json: false, vision: false });
  assert.equal(gufo?.contextLimitTokens, 131_072);
  assert.equal(gufo?.maxOutputTokens, 8_192);
  await assert.rejects(() => run(checkCatalogueForInference([gufo!])), /placeholder/i);
});

test("an old catalogue with ranking fields still loads; the extra keys are ignored", async () => {
  const legacy = {
    ...localGufo,
    quality: { chat: 0.6, coding: 0.7, provenance },
    latency: { initialMs: 200, tokensPerSecond: 40, provenance },
    reasoningTokenEstimates: { none: 0, low: 64, medium: 256, high: 512, xhigh: 1024 },
  };
  const [decoded] = await run(decodeCatalogue([legacy]));
  assert.deepEqual(decoded, localGufo);
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

test("policy suggestions are the three generic presets", () => {
  for (const policy of Object.values(POLICY_SUGGESTIONS))
    assert.deepEqual(Schema.decodeUnknownSync(KeyPolicy)(policy), policy);
  assert.deepEqual(POLICY_SUGGESTIONS, {
    Interactive: { priority: "high", cloud: true, requestsPerMinute: 120, maxConcurrent: 4 },
    Standard: { priority: "medium", cloud: false, requestsPerMinute: 60, maxConcurrent: 2 },
    Background: { priority: "low", cloud: false, requestsPerMinute: 30, maxConcurrent: 2 },
  });
});

test("a stored legacy policy derives cloud from its overload action", () => {
  const legacy = {
    priority: "high",
    localityBias: 0.15,
    contextLimitTokens: 131_072,
    maxCompletionTokens: 16_384,
    allowedModels: null,
    requestsPerMinute: 120,
    maxConcurrent: 4,
    maxWaitMs: 0,
    maxEstimatedUsd: null,
    bias: { cost: 0.2, quality: 0.9, latency: 0.3 },
  };
  const base = { priority: "high", requestsPerMinute: 120, maxConcurrent: 4 };
  assert.deepEqual(decodeStoredKeyPolicy({ ...legacy, overloadAction: "failover" }), {
    ...base,
    cloud: true,
  });
  assert.deepEqual(decodeStoredKeyPolicy({ ...legacy, overloadAction: "report" }), {
    ...base,
    cloud: false,
  });
  assert.deepEqual(decodeStoredKeyPolicy(legacy), { ...base, cloud: false });
  assert.deepEqual(decodeStoredKeyPolicy({ ...base, cloud: true }), { ...base, cloud: true });
  assert.throws(() => decodeStoredKeyPolicy({ ...base, cloud: "yes" }));
});
