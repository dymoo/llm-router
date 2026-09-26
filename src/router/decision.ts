import type {
  Assessment,
  CandidateExclusion,
  ExclusionCode,
  KeyPolicy,
  Priority,
  SelectionCode,
  SelectionReason,
} from "../domain.ts";
import type { SaturationEvidence } from "./locality.ts";
import type { AppliedEffort, RequestedEffort } from "./effort.ts";
import type { CandidateDenial, DenialCode } from "./select-route.ts";

export type RouteDecisionReason = SelectionCode;

export const ROUTE_DECISION_REASONS: readonly SelectionCode[] = [
  "deterministic-rules",
  "pinned",
  "local-preference",
  "cloud-quality",
  "complexity-escalation",
  "local-saturation",
  "local-overload-failover",
  "local-overloaded",
  "queue-admitted",
  "highest-quality",
  "no-eligible",
  "failed-precheck",
];
export interface RouteDecision {
  readonly reason: RouteDecisionReason;
  readonly selectionReason: SelectionReason;
  readonly exclusions: readonly CandidateExclusion[];
  readonly assessment: {
    readonly task: Assessment["task"] | null;
    readonly difficulty: Assessment["difficulty"]["value"] | null;
    readonly difficultyConfidence: number | null;
    readonly requestedEffort: RequestedEffort | null;
    readonly appliedEffort: AppliedEffort | null;
    readonly localSufficiency: number | null;
    readonly freshFacts: number | null;
    readonly trivialChat: number | null;
    readonly effortConfidence: number | null;
  };
  readonly keyPolicyVersion: number | null;
  readonly catalogueVersion: string;
  readonly priority: Priority;
  readonly localityBias: number;
  readonly bias: KeyPolicy["bias"];
  readonly queue: {
    readonly queued: boolean;
    readonly waitedMs: number;
  };
  readonly saturation: SaturationEvidence & {
    readonly observedAtMs: number | null;
    readonly ageMs: number | null;
  };
}

const EXCLUSION_BY_DENIAL: Record<DenialCode, ExclusionCode> = {
  allowlist: "allowlist",
  "deny-all": "allowlist",
  capability: "capability",
  reasoning: "capability",
  context: "context",
  output: "context",
  "impossible-limits": "context",
  cost: "cost",
  health: "health",
  credential: "health",
  placeholder: "placeholder",
  quality: "quality",
  "retrieval-required": "quality",
};

export function exclusionsOf(denials: readonly CandidateDenial[]): readonly CandidateExclusion[] {
  return denials.map((denial) => ({
    deploymentId: denial.deploymentId,
    code: EXCLUSION_BY_DENIAL[denial.code],
    detail: denial.detail,
  }));
}

export function decideReason(input: {
  readonly pinned: boolean;
  readonly qualityOverride: boolean;
  readonly queued: boolean;
  readonly selectedLocation: "local" | "cloud";
  readonly spilledForSaturation: boolean;
  readonly spilledForComplexity: boolean;
}): RouteDecisionReason {
  if (input.pinned) {
    return "pinned";
  }
  if (input.qualityOverride) {
    return "highest-quality";
  }
  if (input.queued) {
    return "queue-admitted";
  }
  if (input.spilledForSaturation) {
    return "local-saturation";
  }
  if (input.spilledForComplexity) {
    return "complexity-escalation";
  }
  if (input.selectedLocation === "local") {
    return "local-preference";
  }
  return "cloud-quality";
}

export function selectionReasonOf(code: RouteDecisionReason): SelectionReason {
  return { code, detail: code };
}
