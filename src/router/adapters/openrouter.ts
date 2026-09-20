import { Effect } from "effect";
import type { AppliedEffort } from "../../domain.ts";
import type { AdapterRequest, ProviderAdapter } from "./types.ts";
import {
  bearerHeaders,
  fetchResponse,
  joinUrl,
  readJsonCompletion,
  type FetchImpl,
} from "./http.ts";

export function openRouterAdapter(fetchImpl: FetchImpl = fetch): ProviderAdapter {
  return {
    complete: (request) =>
      fetchResponse(fetchImpl, joinUrl(request.deployment.endpoint, "/v1/chat/completions"), {
        method: "POST",
        headers: bearerHeaders(request.credential, { "http-referer": "https://dymoo.local" }),
        body: JSON.stringify(openRouterBody(request, false)),
      }).pipe(Effect.flatMap(readJsonCompletion)),
    stream: (request) =>
      fetchResponse(fetchImpl, joinUrl(request.deployment.endpoint, "/v1/chat/completions"), {
        method: "POST",
        headers: bearerHeaders(request.credential, { "http-referer": "https://dymoo.local" }),
        body: JSON.stringify(openRouterBody(request, true)),
      }),
    probeUnavailable: () => Effect.succeed(false),
  };
}

export function openRouterBody(request: AdapterRequest, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ...request.sampling,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    model: request.deployment.modelId,
    messages: request.messages,
    max_completion_tokens: request.maxCompletionTokens,
    stream,
    provider: openRouterProvider(request.deployment.providerRestriction),
    reasoning: openRouterReasoning(request.appliedEffort),
  };
  if (request.tools !== undefined && request.tools !== null) {
    body.tools = request.tools;
  }
  if (request.toolChoice !== undefined && request.toolChoice !== null) {
    body.tool_choice = request.toolChoice;
  }
  if (request.responseFormat !== undefined && request.responseFormat !== null) {
    body.response_format = request.responseFormat;
  }
  return body;
}

function openRouterProvider(restriction: string | null): Record<string, unknown> {
  if (restriction === null) {
    return { allow_fallbacks: false, require_parameters: true };
  }
  return { only: [restriction], allow_fallbacks: false, require_parameters: true };
}

function openRouterReasoning(applied: AppliedEffort): Record<string, unknown> {
  if (applied === "none") {
    return { effort: "none", enabled: false };
  }
  if (applied === "on") {
    return { enabled: true };
  }
  return { effort: applied };
}
