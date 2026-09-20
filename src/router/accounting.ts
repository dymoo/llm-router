export interface ProviderUsage {
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly cachedTokens: number | null;
  readonly providerReportedCostUsd: number | null;
  readonly ttftMs: number | null;
  readonly decodeTokensPerSecond: number | null;
}

export function emptyProviderUsage(): ProviderUsage {
  return {
    promptTokens: null,
    completionTokens: null,
    reasoningTokens: null,
    cachedTokens: null,
    providerReportedCostUsd: null,
    ttftMs: null,
    decodeTokensPerSecond: null,
  };
}

function readFinite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function readCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function readProviderUsage(body: unknown): ProviderUsage {
  if (typeof body !== "object" || body === null) {
    return emptyProviderUsage();
  }
  const record = body as Record<string, unknown>;
  const usage = record.usage;
  const timings = record.timings;
  const usageRecord =
    typeof usage === "object" && usage !== null ? (usage as Record<string, unknown>) : undefined;
  const details =
    usageRecord !== undefined &&
    typeof usageRecord.prompt_tokens_details === "object" &&
    usageRecord.prompt_tokens_details !== null
      ? (usageRecord.prompt_tokens_details as Record<string, unknown>)
      : undefined;
  const completionDetails =
    usageRecord !== undefined &&
    typeof usageRecord.completion_tokens_details === "object" &&
    usageRecord.completion_tokens_details !== null
      ? (usageRecord.completion_tokens_details as Record<string, unknown>)
      : undefined;
  const timingRecord =
    typeof timings === "object" && timings !== null
      ? (timings as Record<string, unknown>)
      : undefined;
  const cachedFromUsage = details === undefined ? null : readCount(details.cached_tokens);
  const cachedFromTimings = timingRecord === undefined ? null : readCount(timingRecord.cache_n);
  const predictedMs = timingRecord === undefined ? null : readFinite(timingRecord.predicted_ms);
  const predictedN = timingRecord === undefined ? null : readCount(timingRecord.predicted_n);
  return {
    promptTokens: usageRecord === undefined ? null : readCount(usageRecord.prompt_tokens),
    completionTokens: usageRecord === undefined ? null : readCount(usageRecord.completion_tokens),
    reasoningTokens:
      completionDetails === undefined
        ? null
        : (readCount(completionDetails.reasoning_tokens) ??
          readCount(completionDetails.reasoningTokens)),
    cachedTokens: cachedFromUsage ?? cachedFromTimings,
    providerReportedCostUsd: usageRecord === undefined ? null : readFinite(usageRecord.cost),
    ttftMs: usageRecord === undefined ? null : readFinite(usageRecord.ttft_ms),
    decodeTokensPerSecond:
      predictedMs !== null && predictedN !== null && predictedMs > 0
        ? (predictedN / predictedMs) * 1000
        : null,
  };
}
