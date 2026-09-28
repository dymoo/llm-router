import { clonePolicy } from "./presets";
import type { KeyDraft, KeyPolicy, PublicKey } from "./types";

export function cloneDraft(draft: KeyDraft): KeyDraft {
  return {
    name: draft.name,
    expiresAt: draft.expiresAt,
    policy: clonePolicy(draft.policy),
  };
}

export function draftFromKey(key: PublicKey): KeyDraft {
  return {
    name: key.name,
    expiresAt: key.expiresAt,
    policy: clonePolicy(key.policy),
  };
}

export function validateDraft(draft: KeyDraft): string | null {
  const name = draft.name.trim();
  if (name.length === 0) {
    return "Name a key so you can recognise it later.";
  }
  if (name.length > 80) {
    return "Keep the name to 80 characters.";
  }
  if (draft.expiresAt !== null) {
    if (!Number.isFinite(draft.expiresAt) || draft.expiresAt <= 0) {
      return "Expiry must be a real date, or left empty.";
    }
  }
  return validatePolicy(draft.policy);
}

export function validatePolicy(policy: KeyPolicy): string | null {
  if (policy.priority !== "high" && policy.priority !== "medium" && policy.priority !== "low") {
    return "Priority must be high, medium, or low.";
  }
  if (policy.overloadAction !== "report" && policy.overloadAction !== "failover") {
    return "Local overload action must be report or failover.";
  }
  if (!Number.isFinite(policy.localityBias) || policy.localityBias < 0 || policy.localityBias > 1) {
    return "Locality must be between 0 and 1.";
  }
  if (!isPositiveInt(policy.contextLimitTokens)) {
    return "Context cap must be a positive whole number of tokens.";
  }
  if (!isPositiveInt(policy.maxCompletionTokens)) {
    return "Completion cap must be a positive whole number of tokens.";
  }
  if (!isNonNegativeInt(policy.requestsPerMinute)) {
    return "Requests per minute must be zero or a positive whole number.";
  }
  if (!isNonNegativeInt(policy.maxConcurrent)) {
    return "Concurrent requests must be zero or a positive whole number.";
  }
  if (!isNonNegativeInt(policy.maxWaitMs) || policy.maxWaitMs > 30_000) {
    return "Capacity wait must be between 0 and 30,000 milliseconds.";
  }
  if (policy.maxEstimatedUsd !== null) {
    if (!Number.isFinite(policy.maxEstimatedUsd) || policy.maxEstimatedUsd < 0) {
      return "Estimate ceiling must be empty or a number at or above zero.";
    }
  }
  if (policy.allowedModels !== null) {
    if (policy.allowedModels.some((id) => id.trim().length === 0)) {
      return "Remove empty deployment IDs from the allowlist.";
    }
  }
  const { cost, quality, latency } = policy.bias;
  if (!isUnitBias(cost) || !isUnitBias(quality) || !isUnitBias(latency)) {
    return "Cost, quality, and latency biases must each be between 0 and 1.";
  }
  if (cost + quality + latency <= 0) {
    return "Set at least one ranking bias above zero.";
  }
  return null;
}

export function resolveStaleEdit(
  draft: KeyDraft,
  latest: PublicKey | undefined,
): {
  draft: KeyDraft;
  expectedVersion: number | null;
  missing: boolean;
} {
  const preserved = cloneDraft(draft);
  if (!latest) {
    return { draft: preserved, expectedVersion: null, missing: true };
  }
  return {
    draft: preserved,
    expectedVersion: latest.version,
    missing: false,
  };
}

export function allowedModelsToText(allowed: readonly string[] | null): string {
  if (allowed === null) {
    return "";
  }
  return allowed.join("\n");
}

export function parseAllowedModels(
  mode: "all" | "deny" | "specific",
  text: string,
): readonly string[] | null {
  if (mode === "all") {
    return null;
  }
  if (mode === "deny") {
    return [];
  }
  const ids = text
    .split(/[\n,]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return ids;
}

export function allowedModelsMode(allowed: readonly string[] | null): "all" | "deny" | "specific" {
  if (allowed === null) {
    return "all";
  }
  if (allowed.length === 0) {
    return "deny";
  }
  return "specific";
}

function isPositiveInt(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function isNonNegativeInt(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function isUnitBias(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}
