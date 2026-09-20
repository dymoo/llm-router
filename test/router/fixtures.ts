import {
  POLICY_SUGGESTIONS,
  type Assessment,
  type Deployment,
  type KeyPolicy,
} from "../../src/domain.ts";

const priceProvenance = { unit: "usd-per-million-tokens", source: "catalogue", asOf: "2026-09-20" };
const latencyProvenance = { unit: "ms", source: "catalogue", asOf: "2026-09-20" };
const qualityProvenance = { unit: "prior", source: "catalogue", asOf: "2026-09-20" };

export const dylanPolicy: KeyPolicy = POLICY_SUGGESTIONS.Dylan;
export const balancedPolicy: KeyPolicy = POLICY_SUGGESTIONS.Balanced;
export const freePolicy: KeyPolicy = POLICY_SUGGESTIONS["Free Vibecode"];

export function deployment(
  partial: Partial<Deployment> & Pick<Deployment, "id" | "location" | "transport">,
): Deployment {
  return {
    modelId: partial.modelId ?? `${partial.id}-model`,
    endpoint: partial.endpoint ?? `http://127.0.0.1:9/${partial.id}`,
    credentialEnvVar: partial.credentialEnvVar ?? null,
    providerRestriction: partial.providerRestriction ?? null,
    contextLimitTokens: partial.contextLimitTokens ?? 32_768,
    maxOutputTokens: partial.maxOutputTokens ?? 8192,
    capabilities: partial.capabilities ?? { tools: true, json: true, vision: false },
    capacity: partial.capacity ?? { maxParallel: 2, reservedInteractiveSlots: 1 },
    quality: partial.quality ?? {
      chat: 0.7,
      coding: 0.7,
      math: 0.6,
      analysis: 0.65,
      writing: 0.7,
      extraction: 0.7,
      provenance: qualityProvenance,
    },
    prices: partial.prices ?? {
      inputUsdPerMillion: partial.location === "local" ? 0 : 0.5,
      cachedInputUsdPerMillion: partial.location === "local" ? 0 : 0.05,
      outputUsdPerMillion: partial.location === "local" ? 0 : 1.5,
      provenance: priceProvenance,
    },
    latency: partial.latency ?? {
      initialMs: partial.location === "local" ? 80 : 400,
      tokensPerSecond: partial.location === "local" ? 40 : 80,
      provenance: latencyProvenance,
    },
    reasoning: partial.reasoning ?? {
      kind: "graded",
      levels: ["none", "low", "medium", "high", "xhigh"],
    },
    reasoningTokenEstimates: partial.reasoningTokenEstimates ?? {
      none: 0,
      low: 256,
      medium: 1024,
      high: 2048,
      xhigh: 4096,
    },
    ...partial,
  };
}

export const localQwen = deployment({
  id: "local-qwen",
  location: "local",
  transport: "llamacpp",
  quality: {
    chat: 0.7,
    coding: 0.55,
    math: 0.5,
    analysis: 0.5,
    writing: 0.6,
    extraction: 0.6,
    provenance: qualityProvenance,
  },
  reasoning: { kind: "graded", levels: ["none", "low", "medium", "xhigh"] },
});

export const cloudGlm = deployment({
  id: "cloud-glm",
  location: "cloud",
  transport: "openai-compatible",
  quality: {
    chat: 0.8,
    coding: 0.78,
    math: 0.75,
    analysis: 0.76,
    writing: 0.8,
    extraction: 0.77,
    provenance: qualityProvenance,
  },
});

export const frontier = deployment({
  id: "frontier",
  location: "cloud",
  transport: "openrouter",
  quality: {
    chat: 0.95,
    coding: 0.96,
    math: 0.95,
    analysis: 0.96,
    writing: 0.94,
    extraction: 0.93,
    provenance: qualityProvenance,
  },
  prices: {
    inputUsdPerMillion: 5,
    cachedInputUsdPerMillion: 0.5,
    outputUsdPerMillion: 15,
    provenance: priceProvenance,
  },
});

export const catalogue = [localQwen, cloudGlm, frontier];

export function assessment(partial: Partial<Assessment> & Pick<Assessment, "task">): Assessment {
  return {
    difficulty: partial.difficulty ?? { value: "easy", confidence: 0.9 },
    effort: partial.effort ?? { value: "low", confidence: 0.9 },
    trivialChat: partial.trivialChat ?? 0,
    localSufficiency: partial.localSufficiency ?? 0.9,
    freshFacts: partial.freshFacts ?? 0,
    expectedLength: partial.expectedLength ?? "short",
    ...partial,
  };
}

export const easyLocalCoding = assessment({
  task: "coding",
  difficulty: { value: "easy", confidence: 0.92 },
  effort: { value: "low", confidence: 0.9 },
  localSufficiency: 0.95,
});

export const hardCoding = assessment({
  task: "coding",
  difficulty: { value: "hard", confidence: 0.88 },
  effort: { value: "high", confidence: 0.86 },
  localSufficiency: 0.2,
  expectedLength: "long",
});

export const greeting = assessment({
  task: "chat",
  difficulty: { value: "easy", confidence: 0.97 },
  effort: { value: "low", confidence: 0.96 },
  trivialChat: 0.995,
  localSufficiency: 0.99,
  freshFacts: 0.01,
});
