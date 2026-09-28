import { Effect, Predicate, Schema } from "effect";
import { CatalogueInvalid } from "./errors.ts";

export const RequestedEffort = Schema.Literals(["none", "low", "medium", "high", "xhigh"]);
export type RequestedEffort = typeof RequestedEffort.Type;

export const AppliedEffort = Schema.Literals(["none", "low", "medium", "high", "xhigh", "on"]);
export type AppliedEffort = typeof AppliedEffort.Type;

export const Priority = Schema.Literals(["high", "medium", "low"]);
export type Priority = typeof Priority.Type;

export const Location = Schema.Literals(["local", "cloud"]);
export type Location = typeof Location.Type;

/** Low-priority keys run on Gufo's flex tier (idle compute only); any key may ask for flex. */
export const serviceTierFor = (
  priority: Priority,
  requested: "flex" | undefined,
): "flex" | undefined => requested ?? (priority === "low" ? "flex" : undefined);

/**
 * A client app's OpenRouter attribution (`HTTP-Referer`, `X-OpenRouter-Title`,
 * `X-OpenRouter-Categories`, `X-OpenRouter-App-Visibility`), already validated.
 * Advisory metadata: recorded per request and forwarded to OpenRouter, never
 * used for routing, auth or key policy. At least one of `url`/`title` is set.
 */
export type AppAttribution = {
  readonly url?: string;
  readonly title?: string;
  readonly categories?: string;
  readonly visibility?: "hidden";
};

/** Gufo is the local runtime; openai-compatible is the generic escape hatch. */
export const Transport = Schema.Literals(["gufo", "openai-compatible", "openrouter"]);
export type Transport = typeof Transport.Type;

export const ClassifierMode = Schema.Literals(["laya", "jev"]);
export type ClassifierMode = typeof ClassifierMode.Type;

export const ClassifierSource = Schema.Literals(["full-input", "caller-brief"]);
export type ClassifierSource = typeof ClassifierSource.Type;

export const ClassificationReuse = Schema.Literals(["classified", "exact-cache", "session"]);
export type ClassificationReuse = typeof ClassificationReuse.Type;

export const ReasoningKind = Schema.Literals(["none", "binary", "mandatory", "graded", "budget"]);
export type ReasoningKind = typeof ReasoningKind.Type;

export const RequestOutcome = Schema.Literals(["success", "error", "cancelled", "incomplete"]);
export type RequestOutcome = typeof RequestOutcome.Type;

export const EFFORT_ORDER = ["none", "low", "medium", "high", "xhigh"] as const;

export const MAX_CAPACITY_WAIT_MS = 30_000;
export const API_KEY_TOKEN_PREFIX = "jrv_";
export const API_KEY_SELECTOR_HEX_LENGTH = 24;
export const API_KEY_SECRET_LENGTH = 43;
/** Fresh dymoo/llm-router HMAC domain. Not compatible with unpublished v0.3 peppers or databases. */
export const API_KEY_HMAC_DOMAIN = "dymoo-llm-router/api-key/v1";
export const CONTROL_PLANE_SCHEMA_IDENTITY = "dymoo-llm-router-control-plane";

/** The whole per-key routing policy. `cloud` lets high and medium work leave Gufo. */
export const KeyPolicy = Schema.Struct({
  priority: Priority,
  cloud: Schema.Boolean,
  requestsPerMinute: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  maxConcurrent: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type KeyPolicy = typeof KeyPolicy.Type;

/**
 * A stored policy. Rows written before migration 0007 carry the old shape;
 * they derive `cloud` from `overloadAction` exactly as the migration does, so
 * an unmigrated row never bricks its key.
 */
export const decodeStoredKeyPolicy = (value: unknown): KeyPolicy =>
  Schema.decodeUnknownSync(KeyPolicy)(
    Predicate.isObject(value) && !("cloud" in value)
      ? { ...value, cloud: value.overloadAction === "failover" }
      : value,
  );

export const POLICY_SUGGESTIONS = {
  Interactive: { priority: "high", cloud: true, requestsPerMinute: 120, maxConcurrent: 4 },
  Standard: { priority: "medium", cloud: false, requestsPerMinute: 60, maxConcurrent: 2 },
  Background: { priority: "low", cloud: false, requestsPerMinute: 30, maxConcurrent: 2 },
} as const satisfies Record<string, KeyPolicy>;

export const EstimateProvenance = Schema.Struct({
  unit: Schema.NonEmptyString,
  source: Schema.NonEmptyString,
  asOf: Schema.NullOr(Schema.String),
});
export type EstimateProvenance = typeof EstimateProvenance.Type;

export const Capabilities = Schema.Struct({
  tools: Schema.Boolean,
  json: Schema.Boolean,
  vision: Schema.Boolean,
});
export type Capabilities = typeof Capabilities.Type;

export const Capacity = Schema.Struct({
  maxParallel: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  reservedInteractiveSlots: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type Capacity = typeof Capacity.Type;

export const Prices = Schema.Struct({
  inputUsdPerMillion: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  cachedInputUsdPerMillion: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  outputUsdPerMillion: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  provenance: EstimateProvenance,
});
export type Prices = typeof Prices.Type;

const reasoningShape = Schema.makeFilter<{
  readonly kind: ReasoningKind;
  readonly levels?: ReadonlyArray<RequestedEffort>;
  readonly maxThinkingTokens?: number;
}>((reasoning) => {
  if (
    reasoning.kind === "graded" &&
    (reasoning.levels === undefined || reasoning.levels.length === 0)
  ) {
    return "graded reasoning requires levels";
  }
  if (reasoning.kind === "budget" && reasoning.maxThinkingTokens === undefined) {
    return "budget reasoning requires maxThinkingTokens";
  }
  return true;
});

export const Reasoning = Schema.Struct({
  kind: ReasoningKind,
  levels: Schema.optional(Schema.Array(RequestedEffort)),
  maxThinkingTokens: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
}).check(reasoningShape);
export type Reasoning = typeof Reasoning.Type;

export const Deployment = Schema.Struct({
  id: Schema.NonEmptyString,
  modelId: Schema.NonEmptyString,
  endpoint: Schema.NonEmptyString,
  location: Location,
  transport: Transport,
  credentialEnvVar: Schema.NullOr(Schema.NonEmptyString),
  providerRestriction: Schema.NullOr(Schema.NonEmptyString),
  contextLimitTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  maxOutputTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  capabilities: Capabilities,
  capacity: Capacity,
  prices: Prices,
  reasoning: Reasoning,
});
export type Deployment = typeof Deployment.Type;

export const Catalogue = Schema.Array(Deployment).check(
  Schema.makeFilter<ReadonlyArray<Deployment>>(
    (deployments) => deployments.length > 0 || "Catalogue must contain at least one deployment",
  ),
);
export type Catalogue = typeof Catalogue.Type;

export const Reservation = Schema.Struct({
  requestId: Schema.NonEmptyString,
  deploymentId: Schema.NonEmptyString,
  requestedEffort: RequestedEffort,
  appliedEffort: AppliedEffort,
});
export type Reservation = typeof Reservation.Type;

export const ApiKeyPublic = Schema.Struct({
  id: Schema.NonEmptyString,
  prefix: Schema.NonEmptyString,
  name: Schema.String,
  policy: KeyPolicy,
  createdAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  expiresAt: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  revokedAt: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  lastUsedAt: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});
export type ApiKeyPublic = typeof ApiKeyPublic.Type;

export const UnknownCount = Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)));
export type UnknownCount = typeof UnknownCount.Type;

export const UnknownUsd = Schema.NullOr(Schema.Finite);
export type UnknownUsd = typeof UnknownUsd.Type;

export const RequestAccounting = Schema.Struct({
  classifierBackend: Schema.NullOr(ClassifierMode),
  modelRevision: Schema.NullOr(Schema.String),
  source: Schema.NullOr(ClassifierSource),
  classifierInputTokens: UnknownCount,
  classifierElapsedMs: UnknownCount,
  reuse: Schema.NullOr(ClassificationReuse),
  promptTokens: UnknownCount,
  completionTokens: UnknownCount,
  reasoningTokens: UnknownCount,
  cachedInputTokens: UnknownCount,
  ttftMs: UnknownCount,
  generationElapsedMs: UnknownCount,
  decodeTokensPerSecond: Schema.NullOr(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
  providerReportedUsd: UnknownUsd,
  estimatedCostUsd: UnknownUsd,
  estimatedCacheSavingsUsd: UnknownUsd,
  localComputeEstimatedUsd: UnknownUsd,
  costSource: Schema.optional(
    Schema.NullOr(Schema.Literals(["provider-reported", "local-rate-card", "estimated"])),
  ),
  priceVersion: Schema.NullOr(Schema.String),
  trajectoryHash: Schema.NullOr(Schema.String),
  errorCode: Schema.NullOr(Schema.String),
});
export type RequestAccounting = typeof RequestAccounting.Type;

export const CostSource = Schema.Literals(["provider-reported", "local-rate-card", "estimated"]);
export type CostSource = typeof CostSource.Type;

/** Internal normalized accounting; the adapter shapes the OpenRouter-compatible wire usage. */
export const GenerationUsage = Schema.Struct({
  prompt_tokens: UnknownCount,
  completion_tokens: UnknownCount,
  total_tokens: UnknownCount,
  cached_tokens: UnknownCount,
  reasoning_tokens: UnknownCount,
  cost: UnknownUsd,
  cost_source: Schema.NullOr(CostSource),
});
export type GenerationUsage = typeof GenerationUsage.Type;

export const SelectionCode = Schema.Literals([
  "deterministic-rules",
  "pinned",
  "local-preference",
  "cloud-quality",
  "complexity-escalation",
  "local-saturation",
  "local-overload-failover",
  "local-overloaded",
  "queue-admitted",
  "highest-quality",
  "no-eligible",
  "failed-precheck",
]);
export type SelectionCode = typeof SelectionCode.Type;

export const SelectionReason = Schema.Struct({
  code: SelectionCode,
  detail: Schema.String,
});
export type SelectionReason = typeof SelectionReason.Type;

export const ExclusionCode = Schema.Literals([
  "allowlist",
  "capability",
  "context",
  "cost",
  "health",
  "placeholder",
  "saturation",
  "quality",
  "affinity",
]);
export type ExclusionCode = typeof ExclusionCode.Type;

export const CandidateExclusion = Schema.Struct({
  deploymentId: Schema.NonEmptyString,
  code: ExclusionCode,
  detail: Schema.String,
});
export type CandidateExclusion = typeof CandidateExclusion.Type;

export const AnalyticsBucket = Schema.Struct({
  startMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  endMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  requests: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  httpSuccess: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  errors: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  cancelled: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  saturation: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  localRequests: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  cloudRequests: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  classifierExactCacheHits: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  sessionReuse: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  classifiedFresh: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  classifierInputTokens: UnknownCount,
  classifierEstimatedUsd: UnknownUsd,
  classifierCostUnknownCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  promptTokens: UnknownCount,
  completionTokens: UnknownCount,
  reasoningTokens: UnknownCount,
  cacheObservedRequests: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  cacheHitRequests: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  cachedInputTokens: UnknownCount,
  providerReportedUsd: UnknownUsd,
  estimatedCostUsd: UnknownUsd,
  localComputeEstimatedUsd: UnknownUsd,
  estimatedCacheSavingsUsd: UnknownUsd,
  unknownCostCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  unknownUsageCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  p50QueueWaitMs: UnknownCount,
  p50TtftMs: UnknownCount,
  p50GenerationElapsedMs: UnknownCount,
  p50DecodeTokensPerSecond: Schema.NullOr(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
  p95QueueWaitMs: UnknownCount,
  p95TtftMs: UnknownCount,
  p95GenerationElapsedMs: UnknownCount,
  p95DecodeTokensPerSecond: Schema.NullOr(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type AnalyticsBucket = typeof AnalyticsBucket.Type;

export const AnalyticsSnapshot = Schema.Struct({
  window: AnalyticsBucket,
  series: Schema.Array(AnalyticsBucket),
  bucketMs: Schema.Int.check(Schema.isGreaterThan(0)),
  byKeyId: Schema.Record(Schema.String, AnalyticsBucket),
  byPriority: Schema.Struct({
    high: AnalyticsBucket,
    medium: AnalyticsBucket,
    low: AnalyticsBucket,
  }),
  byDeploymentId: Schema.Record(Schema.String, AnalyticsBucket),
  byTask: Schema.Record(Schema.String, AnalyticsBucket),
  byDifficulty: Schema.Record(Schema.String, AnalyticsBucket),
  byEffort: Schema.Record(Schema.String, AnalyticsBucket),
  bySelectionCode: Schema.Record(Schema.String, AnalyticsBucket),
  exclusions: Schema.Record(Schema.String, Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  errors: Schema.Record(Schema.String, Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type AnalyticsSnapshot = typeof AnalyticsSnapshot.Type;

/** Batch job lifecycle. The four terminals are completed, failed, expired and cancelled. */
export const BatchStatus = Schema.Literals([
  "validating",
  "queued",
  "in_progress",
  "finalizing",
  "completed",
  "failed",
  "expired",
  "cancelling",
  "cancelled",
]);
export type BatchStatus = typeof BatchStatus.Type;

export const BatchItemStatus = Schema.Literals([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "expired",
  /** Crash marker: dispatch possibly executed but the process died before the outcome landed. */
  "interrupted",
]);
export type BatchItemStatus = typeof BatchItemStatus.Type;

export const BATCH_TERMINAL_STATUSES = [
  "completed",
  "failed",
  "expired",
  "cancelled",
] as const satisfies readonly BatchStatus[];
export type BatchTerminalStatus = (typeof BATCH_TERMINAL_STATUSES)[number];

const TERMINAL_BY_BATCH_STATUS: Record<BatchStatus, boolean> = {
  validating: false,
  queued: false,
  in_progress: false,
  finalizing: false,
  cancelling: false,
  completed: true,
  failed: true,
  expired: true,
  cancelled: true,
};

export const batchStatusIsTerminal = (status: BatchStatus): status is BatchTerminalStatus =>
  TERMINAL_BY_BATCH_STATUS[status];

export const batchItemStatusIsTerminal = (status: BatchItemStatus): boolean =>
  status !== "queued" && status !== "running";

/** Our submit limits; OpenRouter publishes none. 1000 items, 512KiB/item, 32MiB/job. */
export const BATCH_MAX_ITEMS_PER_JOB = 1_000;
export const BATCH_MAX_ITEM_BODY_BYTES = 512 * 1024;
export const BATCH_MAX_JOB_BODY_BYTES = 32 * 1024 * 1024;
export const BATCH_MAX_INFLIGHT_JOBS_PER_KEY = 4;
export const BATCH_MAX_CUSTOM_ID_CHARS = 128;

export const BatchRequestCounts = Schema.Struct({
  total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  completed: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  failed: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type BatchRequestCounts = typeof BatchRequestCounts.Type;

/** Batch-level usage only. Remote batch rows carry no per-item cost (the batch discount is
 * batch-level); local dispatch keeps configured COGS through ordinary request accounting. */
export const BatchUsage = Schema.Struct({
  prompt_tokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  completion_tokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  total_tokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  cost: Schema.NullOr(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
  is_byok: Schema.NullOr(Schema.Boolean),
});
export type BatchUsage = typeof BatchUsage.Type;

/** Metadata-only batch job. Never carries prompts or completions; those live in the dedicated
 * store's input files (item bodies) and result rows. All timestamps are epoch ms. */
export const BatchJob = Schema.Struct({
  id: Schema.NonEmptyString,
  keyId: Schema.NonEmptyString,
  model: Schema.NonEmptyString,
  status: BatchStatus,
  completionWindowMs: Schema.Int.check(Schema.isGreaterThan(0)),
  createdAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  finalizedAt: UnknownCount,
  spillAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** The submitting key allowed cloud: only then may undispatched items spill. */
  cloud: Schema.Boolean,
  requestCounts: BatchRequestCounts,
  usage: Schema.NullOr(BatchUsage),
  errorCode: Schema.NullOr(Schema.String),
});
export type BatchJob = typeof BatchJob.Type;

/** Durable remote spill intent: ONE row per compatibility group holding ONE proven remote id
 * (a job has many groups; compat splits create separate intents). `intended` is persisted —
 * with its exact itemIds assigned — before the POST; `confirmed` carries a provider id proven
 * to be ours (never replaced, never similarity-adopted); `unknown` marks an ambiguous POST
 * (possibly executed); `abandoned` marks a definite clean rejection (provably never executed,
 * assigned items return to queued). Terminal usage/harvest facts persist once per group. */
export const BatchRemoteIntent = Schema.Literals(["intended", "confirmed", "unknown", "abandoned"]);
export type BatchRemoteIntent = typeof BatchRemoteIntent.Type;

export const BatchRemote = Schema.Struct({
  id: Schema.NonEmptyString,
  jobId: Schema.NonEmptyString,
  groupKey: Schema.NonEmptyString,
  intent: BatchRemoteIntent,
  submitToken: Schema.NonEmptyString,
  /** The single proven provider id for this group; null until confirmed. */
  remoteBatchId: Schema.NullOr(Schema.String),
  /** Provider-reported usage for this group, persisted once at terminal harvest. */
  usage: Schema.NullOr(BatchUsage),
  harvestedAt: UnknownCount,
  createdAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  confirmedAt: UnknownCount,
});
export type BatchRemote = typeof BatchRemote.Type;

export const BatchItem = Schema.Struct({
  id: Schema.NonEmptyString,
  jobId: Schema.NonEmptyString,
  /** Durable correlation identity: nonempty, ≤128 chars, unique across ALL items of the job. */
  customId: Schema.NonEmptyString,
  status: BatchItemStatus,
  requestId: Schema.NullOr(Schema.String),
  deploymentId: Schema.NullOr(Schema.String),
  errorCode: Schema.NullOr(Schema.String),
  createdAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  dispatchedAt: UnknownCount,
  finishedAt: UnknownCount,
});
export type BatchItem = typeof BatchItem.Type;

export interface BatchJobDraft {
  /** Defaults to `batch_` + uuid when omitted. */
  readonly id?: string;
  readonly keyId: string;
  readonly model: string;
  readonly completionWindowMs: number;
  /** Computed by the scheduler's spill rule before create; stored verbatim. */
  readonly spillAt: number;
  /** Whether undispatched items may spill to cloud. Default true. */
  readonly cloud?: boolean;
  readonly createdAt?: number;
  readonly status?: BatchStatus;
  readonly errorCode?: string | null;
}

export interface BatchItemDraft {
  readonly customId: string;
  readonly status?: BatchItemStatus;
  readonly errorCode?: string | null;
}

export const decodeCatalogue = Schema.decodeUnknownEffect(Catalogue);
export const decodeRequestAccounting = Schema.decodeUnknownEffect(RequestAccounting);
export const decodeGenerationUsage = Schema.decodeUnknownEffect(GenerationUsage);

export const isPlaceholderValue = (value: string): boolean => value.includes("REPLACE_");

export const deploymentIsPlaceholder = (deployment: Deployment): boolean =>
  isPlaceholderValue(deployment.modelId) ||
  isPlaceholderValue(deployment.endpoint) ||
  (deployment.providerRestriction !== null && isPlaceholderValue(deployment.providerRestriction));

export const catalogueCredentialEnvVars = (catalogue: readonly Deployment[]): readonly string[] => {
  const names: string[] = [];
  for (const deployment of catalogue) {
    if (deployment.credentialEnvVar !== null && !names.includes(deployment.credentialEnvVar)) {
      names.push(deployment.credentialEnvVar);
    }
  }
  return names;
};

/** Apply catalogue rate card to observed tokens. Null if any count is unknown. Configured zero rates yield 0. */
export const applyConfiguredRateCardUsd = (
  prices: Prices,
  tokens: {
    readonly prompt: number | null;
    readonly cached: number | null;
    readonly completion: number | null;
  },
): number | null => {
  if (
    prices.provenance.source === "unknown" ||
    tokens.prompt === null ||
    tokens.completion === null
  ) {
    return null;
  }
  if (tokens.cached === null && prices.inputUsdPerMillion !== prices.cachedInputUsdPerMillion)
    return null;
  const cached = tokens.cached ?? 0; // Equal rates make cache status irrelevant to price, not to hit statistics.
  if (cached > tokens.prompt) return null;
  const uncachedPrompt = tokens.prompt - cached;
  return (
    (uncachedPrompt * prices.inputUsdPerMillion +
      cached * prices.cachedInputUsdPerMillion +
      tokens.completion * prices.outputUsdPerMillion) /
    1_000_000
  );
};

export const checkCatalogueForInference = (
  catalogue: readonly Deployment[],
): Effect.Effect<Catalogue, CatalogueInvalid> => {
  if (catalogue.length === 0) {
    return Effect.fail(
      new CatalogueInvalid({ message: "Catalogue must contain at least one deployment" }),
    );
  }
  if (catalogue.some(deploymentIsPlaceholder)) {
    return Effect.fail(
      new CatalogueInvalid({
        message:
          "Catalogue contains unverified REPLACE_ placeholders and cannot be used for inference",
      }),
    );
  }
  return Schema.decodeUnknownEffect(Catalogue)(catalogue).pipe(
    Effect.mapError(() => new CatalogueInvalid({ message: "Catalogue failed runtime validation" })),
  );
};
