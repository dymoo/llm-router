export type Priority = "high" | "medium" | "low";

export type KeyPolicy = {
  priority: Priority;
  localityBias: number;
  contextLimitTokens: number;
  maxCompletionTokens: number;
  allowedModels: readonly string[] | null;
  requestsPerMinute: number;
  maxConcurrent: number;
  maxWaitMs: number;
  maxEstimatedUsd: number | null;
  bias: {
    cost: number;
    quality: number;
    latency: number;
  };
};

export type PublicKey = {
  id: string;
  prefix: string;
  name: string;
  policy: KeyPolicy;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  lastUsedAt: number | null;
  version: number;
  requestCount: number;
  runningCount: number;
  successCount: number;
  errorCount: number;
};

export type KeyDraft = {
  name: string;
  expiresAt: number | null;
  policy: KeyPolicy;
};

export type KeyListPage = {
  items: PublicKey[];
  nextCursor: string | null;
};

export type RevealedSecret = {
  key: PublicKey;
  secret: string;
  reason: "created" | "rotated";
};

export type ClassifierHealth = {
  ready: boolean;
  backend: string;
  local: boolean;
  evidence?: "runtime-probe" | "configuration-only" | "unavailable" | "unqualified";
};

export type DeploymentHealth = {
  id: string;
  ready: boolean;
  location: "local" | "cloud" | "unknown";
  modelRevision: string | null;
  maxLen: number | null;
  headBudget: number | null;
};

export type HealthSnapshot = {
  ready: boolean;
  classifier: ClassifierHealth;
  deployments: DeploymentHealth[];
};

export type UsageAggregates = {
  requestCount: number;
  successCount: number;
  errorCount: number;
  cancelCount: number | null;
  saturationCount: number | null;
  classifierCalls: number | null;
  exactCacheHits: number | null;
  sessionReuse: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
  cachedTokens: number | null;
  cachedInputTokens: number | null;
  estimatedUsd: number | null;
  actualUsd: number | null;
  localComputeUsd: number | null;
  unknownCostCount: number | null;
  unknownUsageCount: number | null;
  queueWaitMs: number | null;
  ttftMs: number | null;
  decodeTps: number | null;
  elapsedMs: number | null;
  localRequests: number | null;
  cloudRequests: number | null;
  classifierInputTokens: number | null;
  classifierEstimatedUsd: number | null;
  cacheSavingsUsd: number | null;
  p95QueueWaitMs: number | null;
  p95TtftMs: number | null;
  p95ElapsedMs: number | null;
};

export type TrendPoint = {
  t: number;
  requests: number;
  local: number | null;
  cloud: number | null;
  estimatedUsd: number | null;
  actualUsd: number | null;
  localComputeUsd: number | null;
  unknownCost: number | null;
  queueWaitMs: number | null;
  ttftMs: number | null;
  decodeTps: number | null;
  cachedInputTokens: number | null;
  classifierExactCache: number | null;
  sessionReuse: number | null;
};

export type BreakdownRow = {
  id: string;
  label: string;
  requests: number;
  local: number | null;
  cloud: number | null;
  estimatedUsd: number | null;
  actualUsd: number | null;
  localComputeUsd: number | null;
  errors: number | null;
  cancels: number | null;
  saturation: number | null;
};

export type CountRow = {
  id: string;
  label: string;
  count: number;
};

export type RoutingRow = {
  id: string;
  createdAt: number;
  keyName: string | null;
  keyPrefix: string | null;
  deploymentId: string | null;
  task: string | null;
  appliedEffort: string | null;
  outcome: string;
  classificationSource: string | null;
  classificationBackend: string | null;
  cacheHit: boolean | null;
  promptTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
  cachedTokens: number | null;
  estimatedUsd: number | null;
  actualUsd: number | null;
  localComputeUsd: number | null;
  elapsedMs: number | null;
  ttftMs: number | null;
  decodeTps: number | null;
  queueWaitMs: number | null;
  location: "local" | "cloud" | null;
  priority: Priority | null;
  decisionReason: string | null;
  exclusionReasons: readonly string[];
  policyVersion: number | null;
  assessmentDifficulty: string | null;
  catalogueVersion: string | null;
};

export type UsageSnapshot = {
  available: boolean;
  aggregates: UsageAggregates;
  series: TrendPoint[];
  breakdowns: {
    byKey: BreakdownRow[];
    byPriority: BreakdownRow[];
    byDeployment: BreakdownRow[];
  };
  decisions: CountRow[];
  exclusions: CountRow[];
  effort: CountRow[];
  complexity: CountRow[];
  tasks: CountRow[];
  errors: CountRow[];
  recent: RoutingRow[];
};

export type RequestPage = {
  available: boolean;
  items: RoutingRow[];
  nextCursor: string | null;
};

export type UsageQuery = {
  since: number | null;
  until: number | null;
  keyId: string | null;
  priority: Priority | null;
  deploymentId: string | null;
};

export type AdminErrorCode =
  | "unauthorized"
  | "forbidden"
  | "invalid"
  | "not_found"
  | "conflict"
  | "stale_version"
  | "rate_limited"
  | "unavailable"
  | "unknown";

export type PolicyPresetId = "balanced" | "dylan" | "free-vibecode";

export const MAX_WAIT_MS = 30_000;
