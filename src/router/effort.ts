import {
  EFFORT_ORDER,
  type AppliedEffort,
  type Assessment,
  type Deployment,
  type RequestedEffort,
  type SessionBoundary,
} from "../domain.ts";

export type { AppliedEffort, RequestedEffort };

export interface EffortRequest {
  readonly assessment: Assessment;
  readonly qualityBias: number;
  readonly tools: boolean;
  readonly json: boolean;
  readonly vision: boolean;
  readonly boundary: SessionBoundary;
  readonly pinRequestedEffort?: RequestedEffort;
}

export function effortIndex(effort: RequestedEffort): number {
  return EFFORT_ORDER.indexOf(effort);
}

export function maxEffort(left: RequestedEffort, right: RequestedEffort): RequestedEffort {
  return effortIndex(left) >= effortIndex(right) ? left : right;
}

export function raiseEffort(effort: RequestedEffort): RequestedEffort {
  const next = effortIndex(effort) + 1;
  return next >= EFFORT_ORDER.length ? "xhigh" : EFFORT_ORDER[next]!;
}

export function canDisableReasoning(input: EffortRequest): boolean {
  if (input.boundary !== "new-task") {
    return false;
  }
  const { assessment } = input;
  return (
    assessment.task === "chat" &&
    assessment.difficulty.value === "easy" &&
    assessment.trivialChat >= 0.99 &&
    assessment.difficulty.confidence >= 0.9 &&
    assessment.effort.confidence >= 0.9 &&
    assessment.freshFacts < 0.1 &&
    !input.tools &&
    !input.json &&
    !input.vision
  );
}

export function resolveRequestedEffort(input: EffortRequest): RequestedEffort {
  if (input.boundary === "continue" && input.pinRequestedEffort !== undefined) {
    return input.pinRequestedEffort === "none" ? "low" : input.pinRequestedEffort;
  }

  if (canDisableReasoning(input)) {
    return "none";
  }

  const { assessment } = input;
  const uncertain = assessment.difficulty.confidence < 0.55 || assessment.effort.confidence < 0.55;
  const floor: RequestedEffort =
    uncertain || assessment.difficulty.value === "hard"
      ? "high"
      : assessment.difficulty.value === "moderate"
        ? "medium"
        : "low";

  const proposed = maxEffort(floor, assessment.effort.value);
  return input.qualityBias >= 0.85 ? raiseEffort(proposed) : proposed;
}

export function pinRequestedEffort(requested: RequestedEffort): RequestedEffort {
  return requested === "none" ? "low" : requested;
}

export function mapAppliedEffort(
  requested: RequestedEffort,
  deployment: Deployment,
): AppliedEffort | undefined {
  const support = deployment.reasoning;
  switch (support.kind) {
    case "none":
      return requested === "none" ? "none" : undefined;
    case "mandatory":
      return "on";
    case "binary":
      return requested === "none" ? "none" : "on";
    case "budget":
      return nearestSupported(requested, [...EFFORT_ORDER]);
    case "graded": {
      const levels = support.levels;
      if (levels === undefined || levels.length === 0) {
        return undefined;
      }
      return nearestSupported(requested, levels);
    }
  }
}

export function nearestSupported(
  requested: RequestedEffort,
  supported: readonly RequestedEffort[],
): RequestedEffort | undefined {
  const unique = [...supported].sort((left, right) => effortIndex(left) - effortIndex(right));
  if (unique.length === 0) {
    return undefined;
  }
  const req = effortIndex(requested);
  const atLeast = unique.find((level) => effortIndex(level) >= req);
  return atLeast ?? unique[unique.length - 1];
}
