import type { CandidateExclusion, Priority, SelectionCode, SelectionReason } from "../domain.ts";
import type { AppliedEffort, RequestedEffort } from "./effort.ts";

export type RouteDecisionReason = SelectionCode;

/** Every code a stored decision may carry; older rows use the retired ranking codes. */
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

/** Why a request went where it did (stored as the request's decision trace). */
export interface RouteDecision {
  readonly reason: RouteDecisionReason;
  readonly selectionReason: SelectionReason;
  readonly exclusions: readonly CandidateExclusion[];
  readonly requestedEffort: RequestedEffort | null;
  readonly appliedEffort: AppliedEffort | null;
  readonly keyPolicyVersion: number | null;
  readonly catalogueVersion: string;
  readonly priority: Priority;
  readonly cloud: boolean;
  readonly serviceTier: "default" | "flex";
  readonly queue: {
    readonly queued: boolean;
    readonly waitedMs: number;
  };
}
