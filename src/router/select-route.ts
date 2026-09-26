import {
  FRESH_FACTS_RETRIEVAL_THRESHOLD,
  LOCAL_SUFFICIENCY_THRESHOLD,
  VISIBLE_OUTPUT_TOKENS,
  type Assessment,
  type Deployment,
  type KeyPolicy,
  type RequestedEffort,
  type SessionBoundary,
  type TaskKind,
} from "../domain.ts";
import {
  lowestSupportedEffort,
  mapAppliedEffort,
  pinRequestedEffort,
  resolveRequestedEffort,
  type AppliedEffort,
} from "./effort.ts";

export type DenialCode =
  | "allowlist"
  | "health"
  | "credential"
  | "capability"
  | "context"
  | "output"
  | "quality"
  | "reasoning"
  | "cost"
  | "impossible-limits"
  | "deny-all"
  | "retrieval-required"
  | "placeholder";

export interface CacheEvidence {
  readonly deploymentId: string;
  readonly cachedInputTokens: number;
  readonly authenticated: boolean;
}

export interface SelectRouteInput {
  /** Null is explicit Rules mode, not a fabricated semantic assessment. */
  readonly assessment: Assessment | null;
  readonly deployments: readonly Deployment[];
  readonly policy: KeyPolicy;
  readonly inputTokens: number;
  readonly generationAllowance: number;
  readonly tools: boolean;
  readonly json: boolean;
  readonly vision: boolean;
  readonly boundary: SessionBoundary;
  readonly freshFactsAvailable: boolean;
  readonly unavailable?: ReadonlySet<string>;
  readonly missingCredentials?: ReadonlySet<string>;
  readonly cacheEvidence?: CacheEvidence;
  readonly qualityOverride?: "highest";
  readonly preferredLocation?: "local" | "cloud" | null;
  readonly pinRequestedEffort?: RequestedEffort;
}

export interface RankedCandidate {
  readonly deployment: Deployment;
  readonly score: number;
  readonly requestedEffort: RequestedEffort;
  readonly appliedEffort: AppliedEffort;
  readonly estimatedUsd: number | null;
  readonly coldCacheUsd: number | null;
  readonly pricing: "known" | "unknown";
  readonly estimatedMs: number;
  readonly estimatedOutputTokens: number;
}

export interface CandidateDenial {
  readonly deploymentId: string;
  readonly code: DenialCode;
  readonly detail: string;
}

export type SelectRouteResult =
  | {
      readonly _tag: "Selected";
      readonly requestedEffort: RequestedEffort;
      readonly pinRequestedEffort: RequestedEffort;
      readonly ranked: readonly RankedCandidate[];
      readonly denials: readonly CandidateDenial[];
    }
  | {
      readonly _tag: "Denied";
      readonly code: DenialCode;
      readonly detail: string;
      readonly denials: readonly CandidateDenial[];
    };

const COST_ANCHOR_USD = 0.02;
const LATENCY_ANCHOR_MS = 10_000;

export function minimumTaskQuality(assessment: Assessment): number {
  if (assessment.difficulty.confidence < 0.55 || assessment.effort.confidence < 0.55) {
    return 0.4;
  }
  if (assessment.difficulty.value === "hard") {
    return 0.4;
  }
  if (assessment.difficulty.value === "moderate") {
    return 0.25;
  }
  return 0;
}

export function pricesAreUnknown(deployment: Deployment): boolean {
  if (deployment.prices.provenance.source === "unknown") {
    return true;
  }
  return (
    deployment.location === "cloud" &&
    deployment.prices.inputUsdPerMillion === 0 &&
    deployment.prices.outputUsdPerMillion === 0
  );
}

export function selectRoute(input: SelectRouteInput): SelectRouteResult {
  const denials: CandidateDenial[] = [];
  if (
    input.assessment !== null &&
    input.assessment.freshFacts >= FRESH_FACTS_RETRIEVAL_THRESHOLD &&
    !input.freshFactsAvailable
  ) {
    return {
      _tag: "Denied",
      code: "retrieval-required",
      detail: "fresh facts required and no trusted retrieval evidence",
      denials,
    };
  }

  if (input.policy.allowedModels !== null && input.policy.allowedModels.length === 0) {
    return {
      _tag: "Denied",
      code: "deny-all",
      detail: "empty allowlist denies every deployment",
      denials,
    };
  }

  if (input.deployments.length === 0 || input.generationAllowance < 1) {
    return {
      _tag: "Denied",
      code: "impossible-limits",
      detail: "no deployment can satisfy context or output limits",
      denials,
    };
  }
  if (input.inputTokens + input.generationAllowance > input.policy.contextLimitTokens) {
    return {
      _tag: "Denied",
      code: "impossible-limits",
      detail: "input plus generation allowance exceeds key context limit",
      denials,
    };
  }

  const requestedEffort =
    input.assessment === null
      ? (input.pinRequestedEffort ?? "none")
      : resolveRequestedEffort({
          assessment: input.assessment,
          qualityBias: input.policy.bias.quality,
          tools: input.tools,
          json: input.json,
          vision: input.vision,
          boundary: input.boundary,
          pinRequestedEffort: input.pinRequestedEffort,
        });
  const pinEffort =
    input.assessment === null ? requestedEffort : pinRequestedEffort(requestedEffort);
  const qualityFloor = input.assessment === null ? 0 : minimumTaskQuality(input.assessment);
  const ranked: RankedCandidate[] = [];

  for (const deployment of input.deployments) {
    const candidateEffort =
      input.assessment === null
        ? (input.pinRequestedEffort ?? lowestSupportedEffort(deployment))
        : requestedEffort;
    const denial = denyDeployment(input, deployment, candidateEffort, qualityFloor);
    if (denial !== undefined) {
      denials.push(denial);
      continue;
    }
    const appliedEffort = mapAppliedEffort(candidateEffort, deployment);
    if (appliedEffort === undefined) {
      denials.push({
        deploymentId: deployment.id,
        code: "reasoning",
        detail: "deployment cannot apply the required reasoning configuration",
      });
      continue;
    }
    const estimate = estimateCandidate(input, deployment, candidateEffort);
    if (input.policy.maxEstimatedUsd !== null) {
      if (estimate.pricing === "unknown" || estimate.coldCacheUsd === null) {
        denials.push({
          deploymentId: deployment.id,
          code: "cost",
          detail: "unknown pricing cannot be charged against a configured estimate ceiling",
        });
        continue;
      }
      if (estimate.coldCacheUsd > input.policy.maxEstimatedUsd) {
        denials.push({
          deploymentId: deployment.id,
          code: "cost",
          detail: `cold-cache estimate ${estimate.coldCacheUsd} exceeds ceiling ${input.policy.maxEstimatedUsd}`,
        });
        continue;
      }
    }
    if (input.assessment === null && input.unavailable?.has(deployment.id)) {
      denials.push({
        deploymentId: deployment.id,
        code: "health",
        detail: "deployment marked unavailable",
      });
      continue;
    }
    ranked.push({
      deployment,
      requestedEffort: candidateEffort,
      appliedEffort,
      ...estimate,
    });
  }

  ranked.sort(
    input.assessment === null
      ? (left, right) => {
          const preferred = input.preferredLocation ?? "local";
          const locality =
            Number(right.deployment.location === preferred) -
            Number(left.deployment.location === preferred);
          return (
            locality ||
            right.score - left.score ||
            left.deployment.id.localeCompare(right.deployment.id)
          );
        }
      : compareCandidates(input.assessment.task),
  );

  if (ranked.length === 0) {
    return {
      _tag: "Denied",
      code: denials[0]?.code ?? "impossible-limits",
      detail: denials[0]?.detail ?? "no eligible deployment",
      denials,
    };
  }

  return {
    _tag: "Selected",
    requestedEffort,
    pinRequestedEffort: pinEffort,
    ranked,
    denials,
  };
}

function denyDeployment(
  input: SelectRouteInput,
  deployment: Deployment,
  requestedEffort: RequestedEffort,
  qualityFloor: number,
): CandidateDenial | undefined {
  if (input.policy.allowedModels !== null && !input.policy.allowedModels.includes(deployment.id)) {
    return {
      deploymentId: deployment.id,
      code: "allowlist",
      detail: "deployment is not on the key allowlist",
    };
  }
  if (deployment.modelId.includes("REPLACE_") || deployment.endpoint.includes("REPLACE_")) {
    return {
      deploymentId: deployment.id,
      code: "placeholder",
      detail: "unverified placeholder catalogue entry",
    };
  }
  if (input.assessment !== null && input.unavailable?.has(deployment.id)) {
    return { deploymentId: deployment.id, code: "health", detail: "deployment marked unavailable" };
  }
  if (input.missingCredentials?.has(deployment.id)) {
    return {
      deploymentId: deployment.id,
      code: "credential",
      detail: "required credential missing",
    };
  }
  if (input.tools && !deployment.capabilities.tools) {
    return { deploymentId: deployment.id, code: "capability", detail: "tools required" };
  }
  if (input.json && !deployment.capabilities.json) {
    return { deploymentId: deployment.id, code: "capability", detail: "json required" };
  }
  if (input.vision && !deployment.capabilities.vision) {
    return { deploymentId: deployment.id, code: "capability", detail: "vision required" };
  }
  const outputCap = Math.min(input.policy.maxCompletionTokens, deployment.maxOutputTokens);
  if (input.generationAllowance > outputCap) {
    return {
      deploymentId: deployment.id,
      code: "output",
      detail: "generation allowance exceeds key or deployment output limit",
    };
  }
  if (
    input.inputTokens + input.generationAllowance >
    Math.min(input.policy.contextLimitTokens, deployment.contextLimitTokens)
  ) {
    return {
      deploymentId: deployment.id,
      code: "context",
      detail: "input plus generation allowance exceeds context limit",
    };
  }
  const taskQuality = input.assessment === null ? 0 : deployment.quality[input.assessment.task];
  if (taskQuality < qualityFloor) {
    return {
      deploymentId: deployment.id,
      code: "quality",
      detail: `task quality ${taskQuality} below floor ${qualityFloor}`,
    };
  }
  if (
    deployment.location === "local" &&
    input.assessment !== null &&
    input.assessment.localSufficiency < LOCAL_SUFFICIENCY_THRESHOLD
  ) {
    return {
      deploymentId: deployment.id,
      code: "quality",
      detail: "local sufficiency below 0.8",
    };
  }
  if (mapAppliedEffort(requestedEffort, deployment) === undefined) {
    return {
      deploymentId: deployment.id,
      code: "reasoning",
      detail: "reasoning controls cannot satisfy requested effort",
    };
  }
  return undefined;
}

function estimateCandidate(
  input: SelectRouteInput,
  deployment: Deployment,
  requestedEffort: RequestedEffort,
): Pick<
  RankedCandidate,
  "score" | "estimatedUsd" | "coldCacheUsd" | "estimatedMs" | "estimatedOutputTokens" | "pricing"
> {
  const visible =
    input.assessment === null
      ? input.generationAllowance
      : Math.min(VISIBLE_OUTPUT_TOKENS[input.assessment.expectedLength], input.generationAllowance);
  const reasoningEstimate = Math.min(
    deployment.reasoningTokenEstimates[requestedEffort === "none" ? "none" : requestedEffort],
    Math.max(0, input.generationAllowance - visible),
  );
  const estimatedOutputTokens = Math.min(visible + reasoningEstimate, input.generationAllowance);
  const unknown = pricesAreUnknown(deployment);
  const evidence = input.cacheEvidence;
  const observedCache =
    evidence !== undefined && evidence.authenticated && evidence.deploymentId === deployment.id
      ? Math.min(evidence.cachedInputTokens, input.inputTokens)
      : 0;
  const inputPrice = deployment.prices.inputUsdPerMillion;
  const cachedPrice = deployment.prices.cachedInputUsdPerMillion;
  const outputPrice = deployment.prices.outputUsdPerMillion;
  const estimatedUsd = unknown
    ? null
    : ((input.inputTokens - observedCache) / 1_000_000) * inputPrice +
      (observedCache / 1_000_000) * cachedPrice +
      (estimatedOutputTokens / 1_000_000) * outputPrice;
  const coldCacheUsd = unknown
    ? null
    : (input.inputTokens / 1_000_000) * inputPrice +
      (input.generationAllowance / 1_000_000) * outputPrice;
  const tokensPerSecond = deployment.latency.tokensPerSecond;
  const estimatedMs =
    deployment.latency.initialMs + (estimatedOutputTokens / tokensPerSecond) * 1000;
  const bias =
    input.assessment !== null && input.qualityOverride === "highest"
      ? qualityOnlyBias(input.policy)
      : input.policy.bias;
  const quality = input.assessment === null ? 0 : deployment.quality[input.assessment.task];
  const costTerm = estimatedUsd === null ? 1 : estimatedUsd / (estimatedUsd + COST_ANCHOR_USD);
  const localityTerm =
    input.assessment !== null && input.qualityOverride === "highest"
      ? 0
      : (deployment.location === "local"
          ? input.policy.localityBias
          : 1 - input.policy.localityBias) * 0.5;
  const score =
    bias.quality * quality -
    bias.cost * costTerm -
    bias.latency * (estimatedMs / (estimatedMs + LATENCY_ANCHOR_MS)) +
    localityTerm;
  return {
    score,
    estimatedUsd,
    coldCacheUsd,
    estimatedMs,
    estimatedOutputTokens,
    pricing: unknown ? "unknown" : "known",
  };
}

function qualityOnlyBias(policy: KeyPolicy): KeyPolicy["bias"] {
  return { cost: 0, latency: 0, quality: policy.bias.quality > 0 ? policy.bias.quality : 1 };
}

function compareCandidates(task: TaskKind) {
  return (left: RankedCandidate, right: RankedCandidate): number => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    const qualityDelta = right.deployment.quality[task] - left.deployment.quality[task];
    if (qualityDelta !== 0) {
      return qualityDelta;
    }
    return left.deployment.id.localeCompare(right.deployment.id);
  };
}
