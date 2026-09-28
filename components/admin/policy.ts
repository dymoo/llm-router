import type { KeyDraft, KeyPolicy, PublicKey } from "./types";

export function cloneDraft(draft: KeyDraft): KeyDraft {
  return { name: draft.name, expiresAt: draft.expiresAt, policy: { ...draft.policy } };
}

export function draftFromKey(key: PublicKey): KeyDraft {
  return { name: key.name, expiresAt: key.expiresAt, policy: { ...key.policy } };
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
  if (typeof policy.cloud !== "boolean") {
    return "Cloud must be on or off.";
  }
  if (!isNonNegativeInt(policy.requestsPerMinute)) {
    return "Requests per minute must be zero or a positive whole number.";
  }
  if (!isNonNegativeInt(policy.maxConcurrent)) {
    return "Max concurrent must be zero or a positive whole number.";
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
  return { draft: preserved, expectedVersion: latest.version, missing: false };
}

function isNonNegativeInt(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}
