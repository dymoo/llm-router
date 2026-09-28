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

/**
 * OpenRouter app attribution, sent on every OpenRouter call (chat, generation
 * lookups, Batch, readiness). `hidden` keeps the app out of public rankings
 * while attribution and per-app analytics keep working.
 */
export const OPENROUTER_APP_HEADERS = {
  "HTTP-Referer": "https://github.com/dymoo/llm-router",
  "X-OpenRouter-Title": "llm-router",
  "X-OpenRouter-App-Visibility": "hidden",
} as const;

export function openRouterAdapter(fetchImpl: FetchImpl = fetch): ProviderAdapter {
  return {
    complete: (request) =>
      fetchResponse(fetchImpl, joinUrl(request.deployment.endpoint, "/v1/chat/completions"), {
        method: "POST",
        headers: bearerHeaders(request.credential, OPENROUTER_APP_HEADERS),
        body: JSON.stringify(openRouterBody(request, false)),
      }).pipe(Effect.flatMap(readJsonCompletion)),
    stream: (request) =>
      fetchResponse(fetchImpl, joinUrl(request.deployment.endpoint, "/v1/chat/completions"), {
        method: "POST",
        headers: bearerHeaders(request.credential, OPENROUTER_APP_HEADERS),
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
  if (request.parallelToolCalls !== undefined) {
    body.parallel_tool_calls = request.parallelToolCalls;
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
export type ProviderPinResult = "match" | "mismatch" | "unknown";

/** An OpenRouter completion identifies the actual serving provider, not the request preference. */
export function verifyOpenRouterProvider(
  deploymentId: string,
  restriction: string | null,
  servingProvider: unknown,
): ProviderPinResult {
  const normalize = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (restriction === null || typeof servingProvider !== "string") return "unknown";
  const actual = normalize(servingProvider);
  const variant = restriction.indexOf("/");
  const expected = normalize(variant < 0 ? restriction : restriction.slice(0, variant));
  if (actual.length === 0 || expected.length === 0) return "unknown";
  if (actual === expected) return "match";
  const safeName = servingProvider
    .split(/[\r\n]/, 1)[0]!
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 64);
  console.warn(`OpenRouter provider pin mismatch: deployment=${deploymentId} provider=${safeName}`);
  return "mismatch";
}

interface PinVerification {
  readonly deployment: Deployment;
  readonly generationId: unknown;
}

/** Generation metadata has the documented serving provider, unlike chat response schema. */
export function createOpenRouterPinVerifier(options: {
  readonly fetchImpl: FetchImpl;
  readonly credential: (deployment: Deployment) => string | undefined;
  readonly stopping: () => boolean;
  readonly onVerified: (deploymentId: string, result: ProviderPinResult) => void;
  readonly delayMs?: number;
}): (deployment: Deployment, generationId: unknown) => void {
  const queue: PinVerification[] = [];
  let active = 0;
  const report = (job: PinVerification, provider: unknown): void => {
    try {
      options.onVerified(
        job.deployment.id,
        verifyOpenRouterProvider(job.deployment.id, job.deployment.providerRestriction, provider),
      );
    } catch {
      // Observability must not turn a completed response into a failure.
    }
  };
  const verify = async (job: PinVerification): Promise<void> => {
    if (options.stopping()) return;
    const credential = options.credential(job.deployment);
    if (
      typeof job.generationId !== "string" ||
      job.generationId.length === 0 ||
      job.generationId.length > 128 ||
      credential === undefined
    ) {
      report(job, undefined);
      return;
    }
    let provider: unknown;
    try {
      const url = new URL(joinUrl(job.deployment.endpoint, "/v1/generation"));
      url.searchParams.set("id", job.generationId);
      const response = await options.fetchImpl(url, {
        method: "GET",
        headers: { ...OPENROUTER_APP_HEADERS, authorization: `Bearer ${credential}` },
        signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok) await response.body?.cancel().catch(() => undefined);
      else if (response.body !== null) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let text = "";
        let bytes = 0;
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            bytes += next.value.byteLength;
            if (bytes > 64 * 1024) throw new Error("metadata too large");
            text += decoder.decode(next.value, { stream: true });
          }
          text += decoder.decode();
        } finally {
          await reader.cancel().catch(() => undefined);
        }
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed === "object" && parsed !== null && "data" in parsed) {
          const data = parsed.data;
          if (typeof data === "object" && data !== null && "provider_name" in data)
            provider = data.provider_name;
        }
      }
    } catch {
      // A failed metadata lookup is unknown; never interfere with a served completion.
    }
    if (!options.stopping()) report(job, provider);
  };
  const pump = (): void => {
    while (!options.stopping() && active < 4 && queue.length > 0) {
      const job = queue.shift()!;
      active += 1;
      const timer = setTimeout(() => {
        void verify(job)
          .catch(() => undefined)
          .finally(() => {
            active -= 1;
            pump();
          });
      }, options.delayMs ?? 500);
      timer.unref();
    }
  };
  return (deployment, generationId) => {
    if (
      options.stopping() ||
      deployment.location !== "cloud" ||
      deployment.providerRestriction === null
    )
      return;
    const job = { deployment, generationId };
    if (active + queue.length >= 64) {
      report(job, undefined);
      return;
    }
    queue.push(job);
    pump();
  };
}
