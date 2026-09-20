import { Clock, Effect } from "effect";
import type { AppliedEffort, Deployment } from "../../domain.ts";
import type { SaturationEvidence } from "../locality.ts";
import type { AdapterRequest, ProviderAdapter } from "./types.ts";
import {
  bearerHeaders,
  fetchResponse,
  joinUrl,
  readJsonCompletion,
  type FetchImpl,
} from "./http.ts";

const SNAPSHOT_TTL_MS = 1_000;

interface LlamaCppSnapshot {
  readonly unavailable: boolean;
  readonly saturation: SaturationEvidence;
  readonly at: number;
}

export function llamaCppAdapter(fetchImpl: FetchImpl = fetch): ProviderAdapter {
  const cache = new Map<string, LlamaCppSnapshot>();

  const snapshot = (deployment: Deployment, credential: string | undefined) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const cached = cache.get(deployment.endpoint);
      if (cached !== undefined && now - cached.at < SNAPSHOT_TTL_MS) {
        return cached;
      }
      const next = yield* readLlamaCppSnapshot(fetchImpl, deployment, credential, now);
      cache.set(deployment.endpoint, next);
      return next;
    });

  return {
    complete: (request) =>
      fetchResponse(fetchImpl, joinUrl(request.deployment.endpoint, "/v1/chat/completions"), {
        method: "POST",
        headers: bearerHeaders(request.credential),
        body: JSON.stringify(llamaCppBody(request, false)),
      }).pipe(Effect.flatMap(readJsonCompletion)),
    stream: (request) =>
      fetchResponse(fetchImpl, joinUrl(request.deployment.endpoint, "/v1/chat/completions"), {
        method: "POST",
        headers: bearerHeaders(request.credential),
        body: JSON.stringify(llamaCppBody(request, true)),
      }),
    probeUnavailable: (deployment, credential) =>
      snapshot(deployment, credential).pipe(Effect.map((entry) => entry.unavailable)),
    readSaturation: (deployment, credential) =>
      snapshot(deployment, credential).pipe(Effect.map((entry) => entry.saturation)),
  };
}

export function llamaCppBody(request: AdapterRequest, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ...request.sampling,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    model: request.deployment.modelId,
    messages: request.messages,
    max_tokens: request.maxCompletionTokens,
    stream,
    cache_prompt: true,
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
  const effort = llamaCppEffort(request.appliedEffort);
  if (effort !== undefined) {
    body.reasoning_effort = effort;
    body.chat_template_kwargs = { enable_thinking: effort !== "none" };
  }
  if (request.appliedEffort === "on") body.chat_template_kwargs = { enable_thinking: true };
  return body;
}

export function llamaCppEffort(
  applied: AppliedEffort,
): "none" | "low" | "medium" | "high" | "xhigh" | undefined {
  if (applied === "on") {
    return undefined;
  }
  return applied;
}

export function llamaCppSlotsSaturated(body: unknown): SaturationEvidence {
  if (!Array.isArray(body) || body.length === 0) {
    return { verified: false, saturated: false };
  }
  let processing = 0;
  for (const slot of body) {
    if (typeof slot !== "object" || slot === null || !("is_processing" in slot)) {
      return { verified: false, saturated: false };
    }
    if (slot.is_processing === true) {
      processing += 1;
    }
  }
  return { verified: true, saturated: processing >= body.length };
}

export function llamaCppHealthUnavailable(status: number, body: unknown): boolean {
  if (status === 503 || status !== 200) {
    return true;
  }
  if (typeof body !== "object" || body === null || !("status" in body)) {
    return true;
  }
  return body.status !== "ok";
}

export function llamaCppTokenize(
  fetchImpl: FetchImpl,
  endpoint: string,
  content: string,
  credential: string | undefined,
): Effect.Effect<number | null> {
  return Effect.tryPromise({
    try: (signal) =>
      fetchImpl(joinUrl(endpoint, "/tokenize"), {
        method: "POST",
        headers: bearerHeaders(credential),
        body: JSON.stringify({ content, add_special: false }),
        signal,
      }).then(async (response) => {
        if (!response.ok) {
          return null;
        }
        const parsed: unknown = await response.json();
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          !("tokens" in parsed) ||
          !Array.isArray(parsed.tokens)
        ) {
          return null;
        }
        return parsed.tokens.length;
      }),
    catch: () => null,
  }).pipe(Effect.catch(() => Effect.succeed(null)));
}

function getJson(
  fetchImpl: FetchImpl,
  url: string,
  headers: Record<string, string>,
): Effect.Effect<{ readonly status: number; readonly body: unknown } | null> {
  return Effect.tryPromise({
    try: (signal) =>
      fetchImpl(url, { method: "GET", headers, signal }).then(async (response) => ({
        status: response.status,
        body: await response.json().catch(() => null),
      })),
    catch: () => null,
  }).pipe(
    Effect.timeout("1500 millis"),
    Effect.catch(() => Effect.succeed(null)),
  );
}

function readLlamaCppSnapshot(
  fetchImpl: FetchImpl,
  deployment: Deployment,
  credential: string | undefined,
  at: number,
): Effect.Effect<LlamaCppSnapshot> {
  const headers = bearerHeaders(credential);
  return Effect.gen(function* () {
    const health = yield* getJson(fetchImpl, joinUrl(deployment.endpoint, "/health"), headers);
    if (health === null || llamaCppHealthUnavailable(health.status, health.body)) {
      return { unavailable: true, saturation: { verified: false, saturated: false }, at };
    }
    const slots = yield* getJson(fetchImpl, joinUrl(deployment.endpoint, "/slots"), headers);
    if (slots === null || slots.status !== 200) {
      return { unavailable: false, saturation: { verified: false, saturated: false }, at };
    }
    return { unavailable: false, saturation: llamaCppSlotsSaturated(slots.body), at };
  });
}
