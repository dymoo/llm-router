import { POLICY_SUGGESTIONS, type Deployment, type KeyPolicy } from "../../src/domain.ts";

const priceProvenance = { unit: "usd-per-million-tokens", source: "catalogue", asOf: "2026-09-20" };

export const interactivePolicy: KeyPolicy = POLICY_SUGGESTIONS.Interactive;
export const standardPolicy: KeyPolicy = POLICY_SUGGESTIONS.Standard;
export const backgroundPolicy: KeyPolicy = POLICY_SUGGESTIONS.Background;

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
    prices: partial.prices ?? {
      inputUsdPerMillion: partial.location === "local" ? 0 : 0.5,
      cachedInputUsdPerMillion: partial.location === "local" ? 0 : 0.05,
      outputUsdPerMillion: partial.location === "local" ? 0 : 1.5,
      provenance: priceProvenance,
    },
    reasoning: partial.reasoning ?? {
      kind: "graded",
      levels: ["none", "low", "medium", "high", "xhigh"],
    },
    ...partial,
  };
}

export const localQwen = deployment({
  id: "local-qwen",
  location: "local",
  transport: "openai-compatible",
  reasoning: { kind: "graded", levels: ["none", "low", "medium", "xhigh"] },
});

export const cloudGlm = deployment({
  id: "cloud-glm",
  location: "cloud",
  transport: "openai-compatible",
});

export const frontier = deployment({
  id: "frontier",
  location: "cloud",
  transport: "openrouter",
  prices: {
    inputUsdPerMillion: 5,
    cachedInputUsdPerMillion: 0.5,
    outputUsdPerMillion: 15,
    provenance: priceProvenance,
  },
});

export const catalogue = [localQwen, cloudGlm, frontier];
