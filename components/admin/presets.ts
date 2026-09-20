import type { KeyPolicy, PolicyPresetId } from "./types";

export type PolicyPreset = {
  id: PolicyPresetId;
  label: string;
  summary: string;
  policy: KeyPolicy;
};

const ALL_DEPLOYMENTS: KeyPolicy["allowedModels"] = null;

export const POLICY_PRESETS: readonly PolicyPreset[] = [
  {
    id: "dylan",
    label: "Dylan",
    summary: "High priority, quality bias, cloud-preferred locality.",
    policy: {
      priority: "high",
      localityBias: 0.15,
      contextLimitTokens: 131_072,
      maxCompletionTokens: 16_384,
      allowedModels: ALL_DEPLOYMENTS,
      requestsPerMinute: 120,
      maxConcurrent: 4,
      maxWaitMs: 0,
      maxEstimatedUsd: null,
      bias: { cost: 0.2, quality: 0.9, latency: 0.3 },
    },
  },
  {
    id: "balanced",
    label: "Balanced",
    summary: "Medium priority, cost bias, local-preferred locality.",
    policy: {
      priority: "medium",
      localityBias: 0.65,
      contextLimitTokens: 65_536,
      maxCompletionTokens: 8_192,
      allowedModels: ALL_DEPLOYMENTS,
      requestsPerMinute: 60,
      maxConcurrent: 2,
      maxWaitMs: 0,
      maxEstimatedUsd: null,
      bias: { cost: 0.7, quality: 0.5, latency: 0.3 },
    },
  },
  {
    id: "free-vibecode",
    label: "Free Vibecode",
    summary: "Low priority, strong cost bias, local until verified saturation.",
    policy: {
      priority: "low",
      localityBias: 0.95,
      contextLimitTokens: 32_768,
      maxCompletionTokens: 4_096,
      allowedModels: ALL_DEPLOYMENTS,
      requestsPerMinute: 30,
      maxConcurrent: 1,
      maxWaitMs: 5_000,
      maxEstimatedUsd: null,
      bias: { cost: 1, quality: 0.3, latency: 0.05 },
    },
  },
];

export function presetById(id: PolicyPresetId): PolicyPreset {
  const preset = POLICY_PRESETS.find((item) => item.id === id);
  if (!preset) {
    throw new Error(`Unknown policy suggestion: ${id}`);
  }
  return preset;
}

export function clonePolicy(policy: KeyPolicy): KeyPolicy {
  return {
    ...policy,
    allowedModels: policy.allowedModels === null ? null : [...policy.allowedModels],
    bias: { ...policy.bias },
  };
}

export function defaultDraft(): {
  name: string;
  expiresAt: number | null;
  policy: KeyPolicy;
} {
  return {
    name: "",
    expiresAt: null,
    policy: clonePolicy(presetById("balanced").policy),
  };
}
