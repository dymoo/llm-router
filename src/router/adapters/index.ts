import type { Deployment } from "../../domain.ts";
import { halogenAdapter } from "./halogen.ts";
import { llamaCppAdapter } from "./llamacpp.ts";
import { openAiCompatibleAdapter } from "./openai-compatible.ts";
import { openRouterAdapter } from "./openrouter.ts";
import type { ProviderAdapter } from "./types.ts";
import type { FetchImpl } from "./http.ts";

export function adaptersFor(
  fetchImpl: FetchImpl = fetch,
): Record<Deployment["transport"], ProviderAdapter> {
  return {
    llamacpp: llamaCppAdapter(fetchImpl),
    halogen: halogenAdapter(fetchImpl),
    "openai-compatible": openAiCompatibleAdapter(fetchImpl),
    openrouter: openRouterAdapter(fetchImpl),
  };
}

export type { ProviderAdapter, AdapterRequest, AdapterCompletion } from "./types.ts";
export { halogenAdapter } from "./halogen.ts";
export { llamaCppAdapter } from "./llamacpp.ts";
export { openAiCompatibleAdapter } from "./openai-compatible.ts";
export { openRouterAdapter } from "./openrouter.ts";
export { halogenEffort, halogenBody } from "./halogen.ts";
export {
  llamaCppBody,
  llamaCppEffort,
  llamaCppSlotsSaturated,
  llamaCppHealthUnavailable,
} from "./llamacpp.ts";
export { openRouterBody } from "./openrouter.ts";
export { completionBody } from "./openai-compatible.ts";
