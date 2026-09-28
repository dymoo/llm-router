import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Effect } from "effect";
import { selectRoute } from "../src/router/select-route.ts";
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

test("unknown Gufo prices deny requests with a hard estimated-spend ceiling", async () => {
  const raw: unknown = JSON.parse(
    await readFile(new URL("../catalog.example.json", import.meta.url), "utf8"),
  );
  const [template] = await run(decodeCatalogue(raw));
  const gufo = { ...template!, endpoint: "http://127.0.0.1:1/v1" };
  const result = selectRoute({
    assessment: {
      task: "coding",
      difficulty: { value: "easy", confidence: 1 },
      effort: { value: "low", confidence: 1 },
      trivialChat: 0,
      localSufficiency: 1,
      freshFacts: 0,
      expectedLength: "short",
    },
    deployments: [gufo],
    policy: { ...POLICY_SUGGESTIONS.Balanced, maxEstimatedUsd: 0.01 },
    inputTokens: 100,
    generationAllowance: 512,
    tools: true,
    json: false,
    vision: false,
    boundary: "new-task",
    freshFactsAvailable: false,
  });
  assert.equal(result._tag === "Denied" ? result.code : null, "cost");
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
test("historical policies default to reporting local overload and invalid actions are rejected", async () => {
  const { overloadAction: _omitted, ...historical } = POLICY_SUGGESTIONS.Balanced;
  const decoded = await run(decodeKeyPolicy(historical));
  assert.equal(decoded.overloadAction, "report");
  await assert.rejects(() =>
    run(decodeKeyPolicy({ ...historical, overloadAction: "always-cloud" })),
  );
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
        catalogue: [localGufo, cloudGlm],
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
        catalogue: [localGufo],
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
        catalogue: [localGufo],
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
      catalogue: [localGufo, cloudGlm],
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
