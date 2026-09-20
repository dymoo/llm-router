import { Effect } from "effect";
import type { AppliedEffort, Deployment } from "../../domain.ts";
import type { AdapterRequest, ProviderAdapter } from "./types.ts";
import {
  bearerHeaders,
  fetchResponse,
  joinUrl,
  readJsonCompletion,
  type FetchImpl,
} from "./http.ts";

export function openAiCompatibleAdapter(fetchImpl: FetchImpl = fetch): ProviderAdapter {
  return {
    complete: (request) =>
      fetchResponse(fetchImpl, joinUrl(request.deployment.endpoint, "/v1/chat/completions"), {
        method: "POST",
        headers: bearerHeaders(request.credential),
        body: JSON.stringify(completionBody(request, false)),
      }).pipe(Effect.flatMap(readJsonCompletion)),
    stream: (request) =>
      fetchResponse(fetchImpl, joinUrl(request.deployment.endpoint, "/v1/chat/completions"), {
        method: "POST",
        headers: bearerHeaders(request.credential),
        body: JSON.stringify(completionBody(request, true)),
      }),
    probeUnavailable: (deployment, credential) =>
      deployment.location === "local"
        ? probeHealth(fetchImpl, deployment, credential)
        : Effect.succeed(false),
  };
}

export function completionBody(request: AdapterRequest, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ...request.sampling,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    model: request.deployment.modelId,
    messages: request.messages,
    max_completion_tokens: request.maxCompletionTokens,
    stream,
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
  applyReasoning(body, request.deployment, request.appliedEffort);
  return body;
}

export function applyReasoning(
  body: Record<string, unknown>,
  deployment: Deployment,
  applied: AppliedEffort,
): void {
  switch (deployment.reasoning.kind) {
    case "none":
      return;
    case "binary":
    case "mandatory":
      body.enable_thinking = applied !== "none";
      return;
    case "budget":
      if (applied === "none") {
        body.enable_thinking = false;
        return;
      }
      body.max_thinking_tokens = deployment.reasoning.maxThinkingTokens;
      return;
    case "graded":
      if (applied === "on") {
        body.enable_thinking = true;
        return;
      }
      body.reasoning_effort = applied;
  }
}

function probeHealth(
  fetchImpl: FetchImpl,
  deployment: Deployment,
  credential: string | undefined,
): Effect.Effect<boolean> {
  return Effect.tryPromise({
    try: async (signal) => {
      const response = await fetchImpl(joinUrl(deployment.endpoint, "/health"), {
        method: "GET",
        headers: bearerHeaders(credential),
        signal,
        redirect: "error",
      });
      await response.body?.cancel();
      return !response.ok;
    },
    catch: () => true,
  }).pipe(
    Effect.timeout("1500 millis"),
    Effect.catch(() => Effect.succeed(true)),
  );
}
