import { Clock, Effect, Predicate } from "effect";
import type { AppliedEffort, Deployment } from "../../domain.ts";
import { UNKNOWN_SATURATION, type SaturationEvidence } from "../locality.ts";
import type { AdapterRequest, ProviderAdapter } from "./types.ts";
import {
  bearerHeaders,
  fetchResponse,
  joinUrl,
  readJsonCompletion,
  type FetchImpl,
} from "./http.ts";

const HEALTH_TTL_MS = 2_000;
// v0.12.1 /health waits up to HALOGEN_ENGINE_PING_S=30 for an engine PONG.
// A 1–2 second proxy timeout can incorrectly reject a healthy long prefill.
const HEALTH_TIMEOUT_MS = 35_000;
interface HealthSnapshot {
  unavailable: boolean;
  saturation: SaturationEvidence;
  at: number;
}

export function halogenAdapter(fetchImpl: FetchImpl = fetch): ProviderAdapter {
  const cache = new Map<string, HealthSnapshot>();
  const snapshot = (deployment: Deployment, credential: string | undefined) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const previous = cache.get(deployment.endpoint);
      if (previous !== undefined && now - previous.at < HEALTH_TTL_MS) return previous;
      const result = yield* Effect.tryPromise({
        try: async (signal) => {
          const response = await fetchImpl(joinUrl(deployment.endpoint, "/health"), {
            method: "GET",
            headers: bearerHeaders(credential),
            signal,
            redirect: "error",
          });
          const body: unknown = await response.json();
          const unavailable = !response.ok || halogenHealthUnavailable(body);
          return {
            unavailable,
            saturation: unavailable ? UNKNOWN_SATURATION : halogenSaturation(body),
          };
        },
        catch: () => true,
      }).pipe(
        Effect.timeout(`${HEALTH_TIMEOUT_MS} millis`),
        Effect.catch(() => Effect.succeed({ unavailable: true, saturation: UNKNOWN_SATURATION })),
      );
      const value = { ...result, at: yield* Clock.currentTimeMillis };
      cache.set(deployment.endpoint, value);
      return value;
    });
  return {
    complete: (request) =>
      fetchResponse(fetchImpl, joinUrl(request.deployment.endpoint, "/v1/chat/completions"), {
        method: "POST",
        headers: bearerHeaders(request.credential),
        body: JSON.stringify(halogenBody(request, false)),
      }).pipe(Effect.flatMap(readJsonCompletion)),
    stream: (request) =>
      fetchResponse(fetchImpl, joinUrl(request.deployment.endpoint, "/v1/chat/completions"), {
        method: "POST",
        headers: bearerHeaders(request.credential),
        body: JSON.stringify(halogenBody(request, true)),
      }),
    probeUnavailable: (deployment, credential) =>
      snapshot(deployment, credential).pipe(Effect.map((value) => value.unavailable)),
    readSaturation: (deployment, credential) =>
      snapshot(deployment, credential).pipe(Effect.map((value) => value.saturation)),
  };
}

export function halogenBody(request: AdapterRequest, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ...request.sampling,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    model: request.deployment.modelId,
    messages: request.messages,
    max_completion_tokens: request.maxCompletionTokens,
    stream,
    // Explicitly override a server-side thinking-off default for reasoning-enabled work.
    enable_thinking: request.appliedEffort !== "none",
  };
  if (request.tools !== undefined && request.tools !== null) body.tools = request.tools;
  if (request.toolChoice !== undefined && request.toolChoice !== null)
    body.tool_choice = request.toolChoice;
  if (request.responseFormat !== undefined && request.responseFormat !== null)
    body.response_format = request.responseFormat;
  const effort = halogenEffort(request.appliedEffort);
  if (effort !== undefined) body.reasoning_effort = effort;
  return body;
}

export function halogenEffort(
  applied: AppliedEffort,
): "none" | "low" | "medium" | "xhigh" | undefined {
  if (applied === "on") return undefined;
  if (applied === "high" || applied === "xhigh") return "xhigh";
  return applied;
}

export function halogenHealthUnavailable(body: unknown): boolean {
  return (
    !Predicate.isObject(body) ||
    body.status !== "ok" ||
    !Predicate.isObject(body.engine) ||
    body.engine.responds !== true
  );
}

export function halogenSaturation(body: unknown): SaturationEvidence {
  if (halogenHealthUnavailable(body) || !Predicate.isObject(body) || typeof body.busy !== "boolean")
    return UNKNOWN_SATURATION;
  // This is Halogen's own admission semaphore (engine.slots.locked()), not a gateway counter.
  return { verified: true, saturated: body.busy };
}
