import type { KeyDraft, KeyPolicy, PolicyPresetId } from "./types";

export type PolicyPreset = {
  id: PolicyPresetId;
  label: string;
  summary: string;
  policy: KeyPolicy;
};

export const POLICY_PRESETS: readonly PolicyPreset[] = [
  {
    id: "interactive",
    label: "Interactive",
    summary: "High priority with cloud fallback, for a person waiting on the answer.",
    policy: { priority: "high", cloud: true, requestsPerMinute: 120, maxConcurrent: 4 },
  },
  {
    id: "standard",
    label: "Standard",
    summary: "Medium priority on the GPU only.",
    policy: { priority: "medium", cloud: false, requestsPerMinute: 60, maxConcurrent: 2 },
  },
  {
    id: "background",
    label: "Background",
    summary: "Low priority on idle GPU time only.",
    policy: { priority: "low", cloud: false, requestsPerMinute: 30, maxConcurrent: 2 },
  },
];

export function presetById(id: PolicyPresetId): PolicyPreset {
  const preset = POLICY_PRESETS.find((item) => item.id === id);
  if (!preset) {
    throw new Error(`Unknown policy suggestion: ${id}`);
  }
  return preset;
}

export function defaultDraft(): KeyDraft {
  return { name: "", expiresAt: null, policy: { ...presetById("standard").policy } };
}
