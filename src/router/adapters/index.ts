import type { Deployment } from "../../domain.ts";
import { gufoAdapter } from "./gufo.ts";
import { openAiCompatibleAdapter } from "./openai-compatible.ts";
import { openRouterAdapter } from "./openrouter.ts";
import type { ProviderAdapter } from "./types.ts";
import type { FetchImpl } from "./http.ts";

export function adaptersFor(
  fetchImpl: FetchImpl = fetch,
): Record<Deployment["transport"], ProviderAdapter> {
  return {
    gufo: gufoAdapter(fetchImpl),
    "openai-compatible": openAiCompatibleAdapter(fetchImpl),
    openrouter: openRouterAdapter(fetchImpl),
  };
}

export type { ProviderAdapter, AdapterRequest, AdapterCompletion } from "./types.ts";
export { gufoAdapter } from "./gufo.ts";
export { openAiCompatibleAdapter } from "./openai-compatible.ts";
export { openRouterAdapter, openRouterBody } from "./openrouter.ts";
export { completionBody } from "./openai-compatible.ts";
