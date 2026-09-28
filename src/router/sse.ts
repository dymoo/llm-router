import { Predicate } from "effect";
import { emptyProviderUsage, readProviderUsage, type ProviderUsage } from "./accounting.ts";

const MAX_EVENT_BYTES = 256 * 1024;

type RewriteUsage = (
  frame: Record<string, unknown>,
  usage: ProviderUsage,
) => Record<string, unknown>;

/** Observe actual usage; optionally replace only the terminal accounting event. */
export function observeSseUsage(
  source: ReadableStream<Uint8Array>,
  onUsage: (usage: ProviderUsage) => void,
  rewriteFinalUsage?: RewriteUsage,
  startedAtMs = Date.now(),
  onCompleted?: (generationId: unknown) => void,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const encoder = new TextEncoder();
  const reader = source.getReader();
  let pending = "";
  let finished = false;
  let usage = emptyProviderUsage();
  let usageFrame: Record<string, unknown> | undefined;
  let firstTokenAt: number | undefined;
  let lastTokenAt: number | undefined;
  const metadata: Record<string, unknown> = {};

  const observe = (next: ProviderUsage): void => {
    usage = {
      promptTokens: next.promptTokens ?? usage.promptTokens,
      completionTokens: next.completionTokens ?? usage.completionTokens,
      reasoningTokens: next.reasoningTokens ?? usage.reasoningTokens,
      cachedTokens: next.cachedTokens ?? usage.cachedTokens,
      providerReportedCostUsd: next.providerReportedCostUsd ?? usage.providerReportedCostUsd,
      ttftMs:
        firstTokenAt === undefined ? (next.ttftMs ?? usage.ttftMs) : firstTokenAt - startedAtMs,
      decodeTokensPerSecond: next.decodeTokensPerSecond ?? usage.decodeTokensPerSecond,
    };
    if (
      usage.decodeTokensPerSecond === null &&
      usage.completionTokens !== null &&
      firstTokenAt !== undefined &&
      lastTokenAt !== undefined &&
      lastTokenAt > firstTokenAt
    ) {
      usage = {
        ...usage,
        decodeTokensPerSecond: (usage.completionTokens * 1000) / (lastTokenAt - firstTokenAt),
      };
    }
    onUsage(usage);
  };

  const emit = (
    event: string,
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): boolean => {
    if (encoder.encode(event).byteLength > MAX_EVENT_BYTES)
      throw new Error("Upstream SSE event is too large");
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data === "[DONE]") {
      observe(emptyProviderUsage());
      onCompleted?.(metadata.id);
      if (rewriteFinalUsage !== undefined) {
        const finalFrame = rewriteFinalUsage({ ...metadata, ...usageFrame }, usage);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalFrame)}\n\n`));
      }
      finished = true;
      controller.enqueue(encoder.encode(`${event}\n\n`));
      return true;
    }
    if (data.length === 0) {
      controller.enqueue(encoder.encode(`${event}\n\n`));
      return true;
    }
    const parsed: unknown = JSON.parse(data);
    if (!Predicate.isObject(parsed)) throw new Error("Invalid upstream SSE payload");
    if (parsed.error !== undefined) throw new Error("Upstream generation failed");
    for (const key of ["id", "object", "model", "created", "system_fingerprint"] as const) {
      if (parsed[key] !== undefined) metadata[key] = parsed[key];
    }
    if (Array.isArray(parsed.choices)) {
      for (const choice of parsed.choices) {
        if (!Predicate.isObject(choice)) continue;
        const delta = choice.delta;
        if (
          Predicate.isObject(delta) &&
          ["content", "reasoning", "reasoning_content", "tool_calls"].some((key) => {
            const value = delta[key];
            return typeof value === "string"
              ? value.length > 0
              : Array.isArray(value) && value.length > 0;
          })
        ) {
          lastTokenAt = Date.now();
          firstTokenAt ??= lastTokenAt;
        }
      }
    }
    if (Predicate.isObject(parsed.usage) || Predicate.isObject(parsed.timings)) {
      observe(readProviderUsage(parsed));
    }
    if (rewriteFinalUsage !== undefined && Predicate.isObject(parsed.usage)) {
      usageFrame = parsed;
      // Preserve finish reasons as well as content/tools when a runtime combines them with usage.
      // The detached, canonical accounting chunk is emitted once immediately before DONE.
      const hasChoices = Array.isArray(parsed.choices) && parsed.choices.length > 0;
      if (hasChoices) {
        const { usage: _usage, ...content } = parsed;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(content)}\n\n`));
      }
      return hasChoices;
    }
    controller.enqueue(encoder.encode(`${event}\n\n`));
    return true;
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        // A partial frame must keep reading in the same pull. Returning without an enqueue
        // can strand a pending reader indefinitely when TCP splits a frame at any byte.
        while (!finished) {
          const next = await reader.read();
          pending += next.done ? decoder.decode() : decoder.decode(next.value, { stream: true });
          let emitted = false;
          for (;;) {
            const boundary = /\r?\n\r?\n/.exec(pending);
            if (boundary === null) break;
            const event = pending.slice(0, boundary.index);
            pending = pending.slice(boundary.index + boundary[0].length);
            emitted = emit(event, controller) || emitted;
            if (finished) {
              pending = "";
              break;
            }
          }
          if (encoder.encode(pending).byteLength > MAX_EVENT_BYTES)
            throw new Error("Upstream SSE event is too large");
          if (finished) {
            await reader.cancel();
            controller.close();
            return;
          }
          if (next.done) throw new Error("Upstream stream ended before its completion marker");
          if (emitted) return;
        }
      } catch (error) {
        await reader.cancel().catch(() => undefined);
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}
