import type { Effect } from "effect";
import type { SamplingOptions } from "../../sampling.ts";
import type { AppliedEffort, Deployment, RequestedEffort } from "../../domain.ts";
import type { ProviderFailure } from "../../errors.ts";
import type { ProviderUsage } from "../accounting.ts";
import type { SaturationEvidence } from "../locality.ts";
import type { ChatMessage } from "../messages.ts";

export interface AdapterRequest {
  readonly deployment: Deployment;
  readonly messages: readonly ChatMessage[];
  readonly tools: unknown;
  readonly toolChoice: unknown;
  readonly responseFormat: unknown;
  readonly sampling?: SamplingOptions;
  readonly maxCompletionTokens: number;
  readonly requestedEffort: RequestedEffort;
  readonly appliedEffort: AppliedEffort;
  readonly credential: string | undefined;
}

export interface AdapterCompletion {
  readonly body: Record<string, unknown>;
  readonly usage: ProviderUsage;
}

export interface ProviderAdapter {
  readonly complete: (request: AdapterRequest) => Effect.Effect<AdapterCompletion, ProviderFailure>;
  readonly stream: (request: AdapterRequest) => Effect.Effect<Response, ProviderFailure>;
  readonly probeUnavailable: (
    deployment: Deployment,
    credential: string | undefined,
  ) => Effect.Effect<boolean>;
  readonly readSaturation?: (
    deployment: Deployment,
    credential: string | undefined,
  ) => Effect.Effect<SaturationEvidence>;
}
