import type { Effect } from "effect";
import type { SamplingOptions } from "../../sampling.ts";
import type { AppAttribution, AppliedEffort, Deployment, RequestedEffort } from "../../domain.ts";
import type { InvalidInput, LocalOverloaded, ProviderFailure } from "../../errors.ts";
import type { ProviderUsage } from "../accounting.ts";
import type { ChatMessage } from "../messages.ts";

export interface AdapterRequest {
  readonly deployment: Deployment;
  readonly messages: readonly ChatMessage[];
  readonly tools: unknown;
  readonly parallelToolCalls?: boolean;
  readonly toolChoice: unknown;
  readonly responseFormat: unknown;
  readonly sampling?: SamplingOptions;
  readonly maxCompletionTokens: number;
  readonly requestedEffort: RequestedEffort;
  readonly appliedEffort: AppliedEffort;
  readonly credential: string | undefined;
  /** Router request id, forwarded where the runtime logs it. */
  readonly requestId?: string;
  /** OpenAI service tier; Gufo serves `flex` only from spare capacity. */
  readonly serviceTier?: "flex";
  /** Client app attribution; only the OpenRouter adapter sends it upstream. */
  readonly appAttribution?: AppAttribution;
}

export interface AdapterCompletion {
  readonly body: Record<string, unknown>;
  readonly usage: ProviderUsage;
}

export interface ProviderAdapter {
  readonly complete: (
    request: AdapterRequest,
  ) => Effect.Effect<AdapterCompletion, ProviderFailure | LocalOverloaded | InvalidInput>;
  readonly stream: (
    request: AdapterRequest,
  ) => Effect.Effect<Response, ProviderFailure | LocalOverloaded | InvalidInput>;
  readonly probeUnavailable: (
    deployment: Deployment,
    credential: string | undefined,
  ) => Effect.Effect<boolean>;
  /** Gufo's `sessions.flex_limit`, or undefined when the runtime cannot say. */
  readonly readFlexLimit?: (
    deployment: Deployment,
    credential: string | undefined,
  ) => Effect.Effect<number | undefined>;
}
