import { Predicate } from "effect";
import { ProviderFailure } from "../errors.ts";
import {
  applyConfiguredRateCardUsd,
  type CostSource,
  type Deployment,
  type GenerationUsage,
} from "../domain.ts";
import type { ProviderUsage } from "./accounting.ts";

export function toGenerationUsage(deployment: Deployment, usage: ProviderUsage): GenerationUsage {
  const prompt = usage.promptTokens;
  const completion = usage.completionTokens;
  const cached = usage.cachedTokens;
  const reasoning = usage.reasoningTokens;
  const total = prompt !== null && completion !== null ? prompt + completion : null;
  if (deployment.location === "cloud") {
    return {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: total,
      cached_tokens: cached,
      reasoning_tokens: reasoning,
      cost: usage.providerReportedCostUsd,
      cost_source: usage.providerReportedCostUsd !== null ? "provider-reported" : null,
    };
  }
  const cost = applyConfiguredRateCardUsd(deployment.prices, {
    prompt,
    cached,
    completion,
  });
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
    cached_tokens: cached,
    reasoning_tokens: reasoning,
    cost,
    cost_source: cost === null ? null : "local-rate-card",
  };
}

export function localUpstreamCostDetails(
  deployment: Deployment,
): Record<string, number> | undefined {
  if (deployment.location !== "local") {
    return undefined;
  }
  return {
    upstream_inference_cost: 0,
    upstream_inference_prompt_cost: 0,
    upstream_inference_completions_cost: 0,
  };
}

export function attachUsage(
  body: Record<string, unknown>,
  deployment: Deployment,
  usage: ProviderUsage,
): Record<string, unknown> {
  if (deployment.location === "cloud") return body;
  const generation = toGenerationUsage(deployment, usage);
  const details = localUpstreamCostDetails(deployment);
  if (generation.prompt_tokens === null || generation.completion_tokens === null) {
    throw new ProviderFailure({ message: "Local runtime did not report token usage" });
  }
  const original = Predicate.isObject(body.usage) ? body.usage : {};
  const usageObject: Record<string, unknown> = {
    ...original,
    prompt_tokens: generation.prompt_tokens,
    completion_tokens: generation.completion_tokens,
    total_tokens: generation.total_tokens,
    cost: generation.cost,
  };
  if (generation.cached_tokens !== null) {
    usageObject.prompt_tokens_details = {
      ...(Predicate.isObject(original.prompt_tokens_details) ? original.prompt_tokens_details : {}),
      cached_tokens: generation.cached_tokens,
    };
  }
  if (generation.reasoning_tokens !== null) {
    usageObject.completion_tokens_details = {
      ...(Predicate.isObject(original.completion_tokens_details)
        ? original.completion_tokens_details
        : {}),
      reasoning_tokens: generation.reasoning_tokens,
    };
  }
  if (details !== undefined) {
    usageObject.cost_details = details;
  }
  return { ...body, usage: usageObject };
}

export function costSourceOf(generation: GenerationUsage): CostSource | null {
  return generation.cost_source;
}
