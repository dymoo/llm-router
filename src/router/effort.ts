import {
  EFFORT_ORDER,
  type AppliedEffort,
  type Deployment,
  type RequestedEffort,
} from "../domain.ts";

export type { AppliedEffort, RequestedEffort };

export function effortIndex(effort: RequestedEffort): number {
  return EFFORT_ORDER.indexOf(effort);
}

/** The cheapest effort a deployment accepts: the default when a client sends none. */
export function lowestSupportedEffort(deployment: Deployment): RequestedEffort {
  if (deployment.reasoning.kind === "mandatory") return "low";
  if (deployment.reasoning.kind === "graded") {
    return EFFORT_ORDER.find((effort) => deployment.reasoning.levels?.includes(effort)) ?? "none";
  }
  return "none";
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

/**
 * The effort a request runs with on `deployment`: the client's
 * `reasoning_effort` mapped onto what the deployment supports, else its
 * lowest-cost default. A deployment that cannot think at all runs without.
 */
export function effortFor(
  requested: RequestedEffort | undefined,
  deployment: Deployment,
): { readonly requestedEffort: RequestedEffort; readonly appliedEffort: AppliedEffort } {
  const fallback = lowestSupportedEffort(deployment);
  const requestedEffort = requested ?? fallback;
  return {
    requestedEffort,
    appliedEffort:
      mapAppliedEffort(requestedEffort, deployment) ??
      mapAppliedEffort(fallback, deployment) ??
      "none",
  };
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
