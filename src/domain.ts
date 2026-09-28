import { Effect, Schema } from "effect";
import {
  CatalogueInvalid,
  EmptyAllowlist,
  ImpossibleLimits,
  UnsupportedCapabilities,
  type FeasibilityError,
} from "./errors.ts";

export const Probability = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
export type Probability = typeof Probability.Type;

export const TaskKind = Schema.Literals([
  "chat",
  "coding",
  "math",
  "analysis",
  "writing",
  "extraction",
]);
export type TaskKind = typeof TaskKind.Type;

export const Difficulty = Schema.Literals(["easy", "moderate", "hard"]);
export type Difficulty = typeof Difficulty.Type;

export const AssessedEffort = Schema.Literals(["low", "medium", "high", "xhigh"]);
export type AssessedEffort = typeof AssessedEffort.Type;

export const RequestedEffort = Schema.Literals(["none", "low", "medium", "high", "xhigh"]);
export type RequestedEffort = typeof RequestedEffort.Type;

export const AppliedEffort = Schema.Literals(["none", "low", "medium", "high", "xhigh", "on"]);
export type AppliedEffort = typeof AppliedEffort.Type;

export const ExpectedLength = Schema.Literals(["short", "medium", "long"]);
export type ExpectedLength = typeof ExpectedLength.Type;

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

export const OverloadAction = Schema.Literals(["report", "failover"]);
export type OverloadAction = typeof OverloadAction.Type;

/** Gufo is the local runtime; openai-compatible is the generic escape hatch. */
export const Transport = Schema.Literals(["gufo", "openai-compatible", "openrouter"]);
export type Transport = typeof Transport.Type;

export const SessionBoundary = Schema.Literals(["new-task", "continue", "checkpoint"]);
export type SessionBoundary = typeof SessionBoundary.Type;

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

export const VISIBLE_OUTPUT_TOKENS = {
  short: 256,
  medium: 1024,
  long: 3072,
} as const;

export const TOKEN_ESTIMATE_PER_MESSAGE_OVERHEAD = 32;
export const TOKEN_ESTIMATE_RESERVE = 1024;
export const CLASSIFIER_BRIEF_MAX_CHARS = 24_000;
export const CLASSIFIER_ATTEMPT_TIMEOUT_MS = 1_200;
export const CLASSIFIER_MAX_RETRIES = 1;
export const CLASSIFIER_TOTAL_TIMEOUT_MS = 2_500;
/** Documented Jev total budget for state + all questions. Not a tokenizer measurement. */
export const JEV_TOTAL_TOKEN_LIMIT = 64_000;
/** Documented Jev budget for state + the longest single question. Not a tokenizer measurement. */
export const JEV_STATE_PLUS_LONGEST_QUESTION_LIMIT = 32_000;
export const JEV_MODEL_ID = "jev-1.13.0";
export const FRESH_FACTS_RETRIEVAL_THRESHOLD = 0.8;
export const LOCAL_SUFFICIENCY_THRESHOLD = 0.8;
export const MAX_CAPACITY_WAIT_MS = 30_000;
export const ASSESSMENT_QUESTION_SCHEMA_VERSION = "dymoo-assessment-questions/v1";
export const CLASSIFICATION_CACHE_TTL_MS = 120_000;
export const CLASSIFICATION_CACHE_MAX_ENTRIES = 2_048;

export const API_KEY_TOKEN_PREFIX = "jrv_";
export const API_KEY_SELECTOR_HEX_LENGTH = 24;
export const API_KEY_SECRET_LENGTH = 43;
/** Fresh dymoo/llm-router HMAC domain. Not compatible with unpublished v0.3 peppers or databases. */
export const API_KEY_HMAC_DOMAIN = "dymoo-llm-router/api-key/v1";
export const CONTROL_PLANE_SCHEMA_IDENTITY = "dymoo-llm-router-control-plane";

const nonEmptyRecord = Schema.makeFilter<Readonly<Record<string, unknown>>>(
  (value) => Object.keys(value).length > 0 || "Expected at least one entry",
);

const positiveBias = Schema.makeFilter<{
  readonly cost: number;
  readonly quality: number;
  readonly latency: number;
}>(
  (bias) =>
    bias.cost > 0 || bias.quality > 0 || bias.latency > 0 || "At least one bias must be positive",
);

const Bias = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));

/** 0 = cloud-first. 1 = local until verified runtime saturation. */
export const LOCALITY_CLOUD_FIRST_MAX = 0.05;
export const LOCALITY_COMPLEXITY_CLOUD_MAX = 0.5;
export const LOCALITY_SATURATION_MIN = 0.95;

export const explainLocalityBias = (value: number): string => {
  if (value <= LOCALITY_CLOUD_FIRST_MAX) {
    return "Cloud-first. Local stays eligible when it satisfies hard limits; this is a preference, not a percentage guarantee.";
  }
  if (value >= LOCALITY_SATURATION_MIN) {
    return "Stay local until verified runtime saturation. Gateway slot counts and unknown telemetry are not saturation.";
  }
  if (value < LOCALITY_COMPLEXITY_CLOUD_MAX) {
    return "Lean cloud while keeping local eligible. Highly complex work may use cloud. Preference, not a chance guarantee.";
  }
  return "Prefer local. Highly complex tasks or verified saturation may use cloud. Preference, not a chance guarantee.";
};

export const KeyPolicy = Schema.Struct({
  priority: Priority,
  localityBias: Bias,
  contextLimitTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  maxCompletionTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  allowedModels: Schema.NullOr(Schema.Array(Schema.String)),
  requestsPerMinute: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  maxConcurrent: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  maxWaitMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_CAPACITY_WAIT_MS })),
  overloadAction: OverloadAction.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed<OverloadAction>("report")),
  ),
  maxEstimatedUsd: Schema.NullOr(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
  bias: Schema.Struct({
    cost: Bias,
    quality: Bias,
    latency: Bias,
  }).check(positiveBias),
});
export type KeyPolicy = typeof KeyPolicy.Type;

export const POLICY_SUGGESTIONS = {
  Balanced: {
    priority: "medium",
    localityBias: 0.65,
    contextLimitTokens: 65_536,
    maxCompletionTokens: 8_192,
    allowedModels: null,
    requestsPerMinute: 60,
    maxConcurrent: 2,
    maxWaitMs: 0,
    overloadAction: "report",
    maxEstimatedUsd: null,
    bias: { cost: 0.7, quality: 0.5, latency: 0.3 },
  },
  Dylan: {
    priority: "high",
    localityBias: 0.15,
    contextLimitTokens: 131_072,
    maxCompletionTokens: 16_384,
    allowedModels: null,
    requestsPerMinute: 120,
    maxConcurrent: 4,
    maxWaitMs: 0,
    overloadAction: "report",
    maxEstimatedUsd: null,
    bias: { cost: 0.2, quality: 0.9, latency: 0.3 },
  },
  "Free Vibecode": {
    priority: "low",
    localityBias: 0.95,
    contextLimitTokens: 32_768,
    maxCompletionTokens: 4_096,
    allowedModels: null,
    requestsPerMinute: 30,
    maxConcurrent: 1,
    maxWaitMs: 30_000,
    overloadAction: "report",
    maxEstimatedUsd: null,
    bias: { cost: 1, quality: 0.3, latency: 0.05 },
  },
} as const satisfies Record<string, KeyPolicy>;
export type PolicySuggestionName = keyof typeof POLICY_SUGGESTIONS;

export const KEY_POLICY_EDITABLE_FIELDS = [
  "priority",
  "localityBias",
  "contextLimitTokens",
  "maxCompletionTokens",
  "allowedModels",
  "requestsPerMinute",
  "maxConcurrent",
  "maxWaitMs",
  "overloadAction",
  "maxEstimatedUsd",
  "bias",
] as const;
export type KeyPolicyEditableField = (typeof KEY_POLICY_EDITABLE_FIELDS)[number];

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

export const Quality = Schema.Struct({
  chat: Probability,
  coding: Probability,
  math: Probability,
  analysis: Probability,
  writing: Probability,
  extraction: Probability,
  provenance: EstimateProvenance,
});
export type Quality = typeof Quality.Type;

export const Prices = Schema.Struct({
  inputUsdPerMillion: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  cachedInputUsdPerMillion: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  outputUsdPerMillion: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  provenance: EstimateProvenance,
});
export type Prices = typeof Prices.Type;

export const Latency = Schema.Struct({
  initialMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  tokensPerSecond: Schema.Finite.check(Schema.isGreaterThan(0)),
  provenance: EstimateProvenance,
});
export type Latency = typeof Latency.Type;

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

export const ReasoningTokenEstimates = Schema.Struct({
  none: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  low: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  medium: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  high: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  xhigh: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type ReasoningTokenEstimates = typeof ReasoningTokenEstimates.Type;

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
  quality: Quality,
  prices: Prices,
  latency: Latency,
  reasoning: Reasoning,
  reasoningTokenEstimates: ReasoningTokenEstimates,
});
export type Deployment = typeof Deployment.Type;

export const Catalogue = Schema.Array(Deployment).check(
  Schema.makeFilter<ReadonlyArray<Deployment>>(
    (deployments) => deployments.length > 0 || "Catalogue must contain at least one deployment",
  ),
);
export type Catalogue = typeof Catalogue.Type;

/** Confidence is output-distribution concentration, not calibrated task-success probability. */
export const Assessment = Schema.Struct({
  task: TaskKind,
  difficulty: Schema.Struct({
    value: Difficulty,
    confidence: Probability,
  }),
  effort: Schema.Struct({
    value: AssessedEffort,
    confidence: Probability,
  }),
  trivialChat: Probability,
  localSufficiency: Probability,
  freshFacts: Probability,
  expectedLength: ExpectedLength,
});
export type Assessment = typeof Assessment.Type;

export const SessionPin = Schema.Struct({
  deploymentId: Schema.NonEmptyString,
  requestedEffort: RequestedEffort,
  appliedEffort: AppliedEffort,
  continuityKey: Schema.NonEmptyString,
  assessment: Schema.NullOr(Assessment),
  createdAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type SessionPin = typeof SessionPin.Type;

export const Reservation = Schema.Struct({
  requestId: Schema.NonEmptyString,
  deploymentId: Schema.NonEmptyString,
  sessionId: Schema.NonEmptyString,
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

export const Entry = Schema.Union([
  Schema.String,
  Schema.JsonObject,
  Schema.Array(Schema.Json),
  Schema.Null,
]);
export type Entry = typeof Entry.Type;

export const ChoiceQuestion = Schema.Struct({
  type: Schema.Literal("choice"),
  instructions: Schema.optional(Entry),
  criteria: Schema.Record(Schema.String, Entry).check(nonEmptyRecord),
});
export type ChoiceQuestion = typeof ChoiceQuestion.Type;

export const NoulQuestion = Schema.Struct({
  type: Schema.Literal("noul"),
  instructions: Schema.optional(Entry),
  criteria: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        true: Schema.optional(Entry),
        false: Schema.optional(Entry),
      }),
    ),
  ),
});
export type NoulQuestion = typeof NoulQuestion.Type;

export const ScoreQuestion = Schema.Struct({
  type: Schema.Literal("score"),
  instructions: Schema.optional(Entry),
  criteria: Schema.TupleWithRest(Schema.Tuple([Entry, Entry]), [Entry]),
});
export type ScoreQuestion = typeof ScoreQuestion.Type;

export const Question = Schema.Union([ChoiceQuestion, NoulQuestion, ScoreQuestion]);
export type Question = typeof Question.Type;

export const ClassifierState = Schema.Union([
  Schema.String,
  Schema.JsonObject,
  Schema.Array(Schema.Json),
]);
export type ClassifierState = typeof ClassifierState.Type;

export const ClassifierRequest = Schema.Struct({
  state: ClassifierState,
  questions: Schema.Record(Schema.String, Question).check(nonEmptyRecord),
});
export type ClassifierRequest = typeof ClassifierRequest.Type;

export const NoulAnswer = Schema.Struct({
  type: Schema.Literal("noul"),
  noul: Probability,
});
export type NoulAnswer = typeof NoulAnswer.Type;

export const ChoiceAnswer = Schema.Struct({
  type: Schema.Literal("choice"),
  choice: Schema.String,
  confidence: Probability,
  probabilities: Schema.Record(Schema.String, Probability),
});
export type ChoiceAnswer = typeof ChoiceAnswer.Type;

export const ScoreAnswer = Schema.Struct({
  type: Schema.Literal("score"),
  score: Schema.Finite,
  confidence: Probability,
  legend: Schema.Record(Schema.String, Entry),
  probabilities: Schema.Record(Schema.String, Probability),
});
export type ScoreAnswer = typeof ScoreAnswer.Type;

export const ClassifierAnswer = Schema.Union([NoulAnswer, ChoiceAnswer, ScoreAnswer]);
export type ClassifierAnswer = typeof ClassifierAnswer.Type;

export const UnknownCount = Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)));
export type UnknownCount = typeof UnknownCount.Type;

export const UnknownUsd = Schema.NullOr(Schema.Finite);
export type UnknownUsd = typeof UnknownUsd.Type;

export const ClassifierUsage = Schema.Struct({
  input_tokens: UnknownCount,
  output_tokens: UnknownCount,
});
export type ClassifierUsage = typeof ClassifierUsage.Type;

export const LayaResponse = Schema.Struct({
  answers: Schema.Record(Schema.String, ClassifierAnswer).check(nonEmptyRecord),
  usage: Schema.Struct({
    input_tokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    output_tokens: Schema.Literal(0),
  }),
  backend: Schema.String,
});
export type LayaResponse = typeof LayaResponse.Type;

export const LayaHealth = Schema.Struct({
  ok: Schema.Boolean,
  ready: Schema.Boolean,
  backend: Schema.optional(Schema.String),
  model_id: Schema.optional(Schema.String),
  model_revision: Schema.NonEmptyString,
  max_len: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  head_budget: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  head_max_len: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  rss_mb: Schema.optional(Schema.Finite),
  oom: Schema.optional(Schema.Boolean),
  one_model: Schema.optional(Schema.Boolean),
});
export type LayaHealth = typeof LayaHealth.Type;

export const LayaBudget = Schema.Struct({
  input_tokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  max_len: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  head_budget: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  fits: Schema.Boolean,
  worst_state_budget: Schema.optional(Schema.Int),
});
export type LayaBudget = typeof LayaBudget.Type;

export const LocalDeploymentBrief = Schema.Struct({
  id: Schema.NonEmptyString,
  modelId: Schema.NonEmptyString,
  contextLimitTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  quality: Schema.Struct({
    chat: Probability,
    coding: Probability,
    math: Probability,
    analysis: Probability,
    writing: Probability,
    extraction: Probability,
  }),
});
export type LocalDeploymentBrief = typeof LocalDeploymentBrief.Type;

export const ClassifierInputMeta = Schema.Struct({
  fullPromptTokenEstimate: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  toolCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  turnCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  pendingToolCalls: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type ClassifierInputMeta = typeof ClassifierInputMeta.Type;

export const ClassifyInput = Schema.Struct({
  state: ClassifierState,
  localDeployments: Schema.Array(LocalDeploymentBrief),
  keyId: Schema.NonEmptyString,
  catalogueVersion: Schema.NonEmptyString,
  source: ClassifierSource,
  meta: Schema.optional(ClassifierInputMeta),
});
export type ClassifyInput = typeof ClassifyInput.Type;

export const ClassifiedAssessment = Schema.Struct({
  assessment: Assessment,
  backend: ClassifierMode,
  modelRevision: Schema.NullOr(Schema.String),
  usage: ClassifierUsage,
  elapsedMs: UnknownCount,
  cacheHit: Schema.Boolean,
  reuse: Schema.Literals(["classified", "exact-cache"]),
  source: ClassifierSource,
});
export type ClassifiedAssessment = typeof ClassifiedAssessment.Type;

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

export const CalibrationMetric = Schema.Struct({
  cases: Schema.Int.check(Schema.isGreaterThan(0)),
  negativeCases: Schema.optional(Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))),
  errors: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  falsePositives: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type CalibrationMetric = typeof CalibrationMetric.Type;

export const CalibrationThreshold = Schema.Struct({
  maxErrorRate: Schema.Finite.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(1),
  ),
  maxFalsePositiveRate: Schema.NullOr(
    Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1)),
  ),
});
export type CalibrationThreshold = typeof CalibrationThreshold.Type;

export const Calibration = Schema.Struct({
  evaluationSet: Schema.Struct({
    id: Schema.NonEmptyString,
    cases: Schema.Int.check(Schema.isGreaterThan(0)),
    labelsSource: Schema.NonEmptyString,
    asOf: Schema.NonEmptyString,
  }),
  measuredAt: Schema.NonEmptyString,
  method: Schema.NonEmptyString,
  metrics: Schema.Record(Schema.String, CalibrationMetric),
  thresholds: Schema.Record(Schema.String, CalibrationThreshold),
  verdict: Schema.Literals(["pass", "fail"]),
});
export type Calibration = typeof Calibration.Type;

export const ClassifierRates = Schema.Struct({
  inputUsdPerMillion: Schema.NullOr(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
  outputUsdPerMillion: Schema.NullOr(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
  provenance: EstimateProvenance,
});
export type ClassifierRates = typeof ClassifierRates.Type;

export const ClassifierQualification = Schema.Struct({
  backend: ClassifierMode,
  modelRevision: Schema.NonEmptyString,
  questionSchemaVersion: Schema.NonEmptyString,
  calibration: Calibration,
  rates: ClassifierRates,
});
export type ClassifierQualification = typeof ClassifierQualification.Type;

export const ClassifierQualifications = Schema.Array(ClassifierQualification).check(
  Schema.makeFilter<ReadonlyArray<ClassifierQualification>>(
    (records) =>
      new Set(records.map((r) => `${r.backend}\0${r.modelRevision}\0${r.questionSchemaVersion}`))
        .size === records.length ||
      "Classifier qualifications must be unique per backend, model revision and question schema",
  ),
);
export type ClassifierQualifications = typeof ClassifierQualifications.Type;

export type QualificationFailure =
  | { _tag: "missing" }
  | { _tag: "identity-mismatch" }
  | { _tag: "placeholder" }
  | { _tag: "not-passed" }
  | { _tag: "metric-invalid"; questionId: string }
  | { _tag: "unmeasured"; questionId: string }
  | { _tag: "error-rate"; questionId: string }
  | { _tag: "false-positive-rate"; questionId: string };

export type QualificationOutcome =
  | { _tag: "qualified"; record: ClassifierQualification }
  | QualificationFailure;

export const qualificationIsPlaceholder = (record: ClassifierQualification): boolean =>
  isPlaceholderValue(record.modelRevision) ||
  isPlaceholderValue(record.questionSchemaVersion) ||
  isPlaceholderValue(record.calibration.evaluationSet.id) ||
  isPlaceholderValue(record.calibration.evaluationSet.labelsSource) ||
  isPlaceholderValue(record.calibration.evaluationSet.asOf) ||
  isPlaceholderValue(record.calibration.measuredAt) ||
  isPlaceholderValue(record.calibration.method) ||
  isPlaceholderValue(record.rates.provenance.unit) ||
  isPlaceholderValue(record.rates.provenance.source) ||
  (record.rates.provenance.asOf !== null && isPlaceholderValue(record.rates.provenance.asOf));

export const evaluateClassifierQualification = (
  records: readonly ClassifierQualification[],
  selected: {
    backend: ClassifierMode;
    modelRevision: string | undefined;
    questionSchemaVersion: string;
  },
  requiredQuestionIds: readonly string[],
): QualificationOutcome => {
  const { backend, modelRevision, questionSchemaVersion } = selected;
  if (modelRevision === undefined || modelRevision === "") {
    return { _tag: "identity-mismatch" };
  }
  const record = records.find(
    (r) =>
      r.backend === backend &&
      r.modelRevision === modelRevision &&
      r.questionSchemaVersion === questionSchemaVersion,
  );
  if (record === undefined) {
    return records.some((r) => r.backend === backend)
      ? { _tag: "identity-mismatch" }
      : { _tag: "missing" };
  }
  if (qualificationIsPlaceholder(record)) {
    return { _tag: "placeholder" };
  }
  if (record.calibration.verdict !== "pass") {
    return { _tag: "not-passed" };
  }
  for (const questionId of requiredQuestionIds) {
    const metric = record.calibration.metrics[questionId];
    const threshold = record.calibration.thresholds[questionId];
    if (metric === undefined || threshold === undefined) {
      return { _tag: "unmeasured", questionId };
    }
    if (
      metric.errors > metric.cases ||
      metric.cases > record.calibration.evaluationSet.cases ||
      (metric.falsePositives !== null && metric.falsePositives > metric.cases)
    ) {
      return { _tag: "metric-invalid", questionId };
    }
    if (
      (questionId === "localSufficiency" || questionId === "trivialChat") &&
      threshold.maxFalsePositiveRate === null
    ) {
      return { _tag: "false-positive-rate", questionId };
    }
    if (threshold.maxFalsePositiveRate !== null) {
      const { negativeCases, falsePositives } = metric;
      if (
        negativeCases == null ||
        negativeCases === 0 ||
        negativeCases > metric.cases ||
        falsePositives === null ||
        falsePositives > negativeCases ||
        falsePositives > metric.errors
      ) {
        return { _tag: "metric-invalid", questionId };
      }
      if (metric.errors / metric.cases > threshold.maxErrorRate) {
        return { _tag: "error-rate", questionId };
      }
      if (falsePositives / negativeCases > threshold.maxFalsePositiveRate) {
        return { _tag: "false-positive-rate", questionId };
      }
    } else if (metric.errors / metric.cases > threshold.maxErrorRate) {
      return { _tag: "error-rate", questionId };
    }
  }
  return { _tag: "qualified", record };
};

export type ClassifierCost =
  | { _tag: "zero"; usd: 0 }
  | { _tag: "unknown" }
  | { _tag: "priced"; usd: number };

/** Linearity: callers may pass a group token sum. Only input tokens are persisted, so a backend
 * with a non-zero output rate cannot be priced from input counts alone. */
export const classifierCostUsd = (
  reuse: ClassificationReuse,
  inputTokens: number | null,
  rates: ClassifierRates | undefined,
): ClassifierCost => {
  if (reuse !== "classified") return { _tag: "zero", usd: 0 };
  if (rates === undefined || inputTokens === null) return { _tag: "unknown" };
  if (rates.outputUsdPerMillion !== 0) return { _tag: "unknown" };
  if (inputTokens === 0) return { _tag: "priced", usd: 0 };
  if (rates.inputUsdPerMillion === null) return { _tag: "unknown" };
  return { _tag: "priced", usd: (inputTokens * rates.inputUsdPerMillion) / 1_000_000 };
};

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

/** Metadata-only request drilldown. Never includes prompts, completions, reasoning text, or raw keys. */
export const AnalyticsRequestRow = Schema.Struct({
  requestId: Schema.NonEmptyString,
  keyId: Schema.NonEmptyString,
  createdAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  priority: Priority,
  localityBias: Probability,
  keyPolicyVersion: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  deploymentId: Schema.NullOr(Schema.String),
  location: Schema.NullOr(Location),
  transport: Schema.NullOr(Transport),
  boundary: Schema.NullOr(SessionBoundary),
  assessmentTask: Schema.NullOr(TaskKind),
  assessmentDifficulty: Schema.NullOr(Difficulty),
  assessmentEffort: Schema.NullOr(AssessedEffort),
  selectionReason: Schema.NullOr(SelectionReason),
  exclusions: Schema.Array(CandidateExclusion),
  queueWaitMs: UnknownCount,
  decodeTokensPerSecond: Schema.NullOr(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
  saturation: Schema.Boolean,
  /** Client-declared app attribution (advisory, unverified). */
  appUrl: Schema.NullOr(Schema.String),
  appTitle: Schema.NullOr(Schema.String),
  httpOutcome: RequestOutcome,
  /** Always null until an explicit future opt-in evaluator. HTTP success is not task success. */
  taskSuccess: Schema.Null,
  accounting: RequestAccounting,
});
export type AnalyticsRequestRow = typeof AnalyticsRequestRow.Type;

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
  readonly createdAt?: number;
  readonly status?: BatchStatus;
  readonly errorCode?: string | null;
}

export interface BatchItemDraft {
  readonly customId: string;
  readonly status?: BatchItemStatus;
  readonly errorCode?: string | null;
}

export const decodeKeyPolicy = Schema.decodeUnknownEffect(KeyPolicy);
export const decodeDeployment = Schema.decodeUnknownEffect(Deployment);
export const decodeCatalogue = Schema.decodeUnknownEffect(Catalogue);
export const decodeAssessment = Schema.decodeUnknownEffect(Assessment);
export const decodeClassifierRequest = Schema.decodeUnknownEffect(ClassifierRequest);
export const decodeLayaResponse = Schema.decodeUnknownEffect(LayaResponse);
export const decodeLayaHealth = Schema.decodeUnknownEffect(LayaHealth);
export const decodeLayaBudget = Schema.decodeUnknownEffect(LayaBudget);
export const decodeRequestAccounting = Schema.decodeUnknownEffect(RequestAccounting);
export const decodeGenerationUsage = Schema.decodeUnknownEffect(GenerationUsage);
export const decodeAnalyticsRequestRow = Schema.decodeUnknownEffect(AnalyticsRequestRow);
export const decodeAnalyticsSnapshot = Schema.decodeUnknownEffect(AnalyticsSnapshot);

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

export const estimateInputTokens = (serializedUtf8Bytes: number, messageCount: number): number =>
  serializedUtf8Bytes + TOKEN_ESTIMATE_PER_MESSAGE_OVERHEAD * messageCount + TOKEN_ESTIMATE_RESERVE;

export interface CapabilityNeeds {
  readonly tools: boolean;
  readonly json: boolean;
  readonly vision: boolean;
}

export interface FeasibilityInput {
  readonly policy: KeyPolicy;
  readonly catalogue: readonly Deployment[];
  readonly estimatedInputTokens: number;
  readonly requestedCompletionTokens: number;
  readonly capabilities: CapabilityNeeds;
}

export const permittedByAllowlist = (
  policy: KeyPolicy,
  catalogue: readonly Deployment[],
): readonly Deployment[] => {
  if (policy.allowedModels === null) return catalogue;
  const allowed = new Set(policy.allowedModels);
  return catalogue.filter((deployment) => allowed.has(deployment.id));
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

export const checkFeasibility = (
  input: FeasibilityInput,
): Effect.Effect<readonly Deployment[], FeasibilityError> => {
  if (input.policy.allowedModels !== null && input.policy.allowedModels.length === 0) {
    return Effect.fail(new EmptyAllowlist({ message: "Explicit allowlist is empty" }));
  }

  const keyContext = input.policy.contextLimitTokens;
  const keyCompletion = input.policy.maxCompletionTokens;
  if (
    input.estimatedInputTokens > keyContext ||
    input.requestedCompletionTokens > keyCompletion ||
    input.estimatedInputTokens + input.requestedCompletionTokens > keyContext
  ) {
    return Effect.fail(
      new ImpossibleLimits({
        message: "Requested context or completion tokens exceed the key policy",
      }),
    );
  }

  const allowed = permittedByAllowlist(input.policy, input.catalogue);
  const capable = allowed.filter(
    (deployment) =>
      (!input.capabilities.tools || deployment.capabilities.tools) &&
      (!input.capabilities.json || deployment.capabilities.json) &&
      (!input.capabilities.vision || deployment.capabilities.vision),
  );
  if (capable.length === 0) {
    return Effect.fail(
      new UnsupportedCapabilities({
        message:
          "No permitted deployment supports the requested tools, JSON, or vision capabilities",
      }),
    );
  }

  const fitting = capable.filter(
    (deployment) =>
      input.estimatedInputTokens <= deployment.contextLimitTokens &&
      input.requestedCompletionTokens <= deployment.maxOutputTokens &&
      input.estimatedInputTokens + input.requestedCompletionTokens <= deployment.contextLimitTokens,
  );
  if (fitting.length === 0) {
    return Effect.fail(
      new ImpossibleLimits({
        message: "Requested context or completion tokens exceed every permitted deployment",
      }),
    );
  }

  if (fitting.some(deploymentIsPlaceholder)) {
    return Effect.fail(
      new CatalogueInvalid({
        message:
          "Catalogue contains unverified REPLACE_ placeholders and cannot be used for inference",
      }),
    );
  }

  return Effect.succeed(fitting);
};
