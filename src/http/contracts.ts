import type { SamplingOptions } from "../sampling.ts";
import type { AnalyticsSnapshot } from "../domain.ts";
import type { AnalyticsQuery } from "../keys/analytics.ts";
import type {
  Admission as RepoAdmission,
  FinalizeOutcome as RepoFinalize,
  RecentRequestList,
  UsageSummary,
} from "../keys/types.ts";
import type { RequestStatusStore } from "./status.ts";

export type Priority = "high" | "medium" | "low";
export type SessionBoundary = "new-task" | "continue" | "checkpoint";

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
  promptTokens: number | null;
  completionTokens: number | null;
};

export type KeyListPage = {
  items: PublicKey[];
  nextCursor: string | null;
};

export type RevealedKey = {
  key: PublicKey;
  secret: string;
};

export type KeyDraft = {
  name: string;
  expiresAt: number | null;
  policy: KeyPolicy;
};

export type KeyPatch = KeyDraft & {
  expectedVersion: number;
};

export type Admission = RepoAdmission;
export type FinalizeOutcome = RepoFinalize;
export type { AnalyticsSnapshot, RecentRequestList, UsageSummary };

export type UsageQuery = {
  since?: number;
  until?: number;
  keyId?: string;
  priority?: Priority;
  deploymentId?: string;
};

export type RequestQuery = {
  cursor?: string;
  limit: number;
  keyId?: string;
  since?: number;
  until?: number;
  priority?: Priority;
  deploymentId?: string;
};

export type ClassifierHealth = {
  ready: boolean;
  backend: string;
  local: boolean;
  evidence?: "runtime-probe" | "configuration-only" | "unavailable";
};

export type DeploymentHealth = {
  id: string;
  ready: boolean;
  location: "local" | "cloud" | "unknown";
  modelRevision?: string;
  maxLen?: number;
  headBudget?: number;
  optional?: boolean;
  evidence?: "runtime-probe" | "configuration-only" | "unavailable";
};

export type HealthSnapshot = {
  checkedAt?: number;
  persistence?: boolean;
  stopping?: boolean;
  ready: boolean;
  classifier: ClassifierHealth;
  deployments: DeploymentHealth[];
};

export type ChatRole = "system" | "developer" | "user" | "assistant" | "tool";

export type TextPart = {
  type: "text";
  text: string;
};

export type ToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type ChatMessage = {
  role: ChatRole;
  content: string | TextPart[] | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  reasoning?: unknown;
  reasoning_content?: unknown;
  reasoning_details?: unknown;
};

export type ToolDefinition = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: unknown;
  };
};

export type RoutingHint = {
  sessionId: string;
  boundary: SessionBoundary;
  taskBrief?: string;
  taskBriefSource?: "caller-brief";
};

export type ChatCompletionRequest = {
  model: "auto";
  stream: boolean;
  sampling?: SamplingOptions;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  tool_choice?: unknown;
  response_format?: unknown;
  maxCompletionTokens?: number;
  routing: RoutingHint;
};

export type RequestCapabilities = {
  tools: boolean;
  json: boolean;
  vision: false;
  pendingToolCalls: number;
  turns: number;
};

export type ClassifierInput = {
  source: "full-input" | "caller-brief";
  state: string;
  advisory: boolean;
  inputTokens: number;
  tools: boolean;
  turns: number;
  pendingToolCalls: number;
};

export type RoutedWork = {
  sampling?: SamplingOptions;
  requestId: string;
  keyId: string;
  policy: KeyPolicy;
  keyPolicyVersion: number;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  toolChoice?: unknown;
  responseFormat?: unknown;
  maxCompletionTokens?: number;
  inputTokens: number;
  routing: RoutingHint;
  capabilities: RequestCapabilities;
  classifierInput: ClassifierInput;
  freshFactsAvailable: false;
  stream: boolean;
};

export type SessionHeaders = {
  requestId: string;
  deploymentId: string;
  sessionId: string;
  appliedEffort: string;
  priority?: Priority;
  queueWaitMs?: number;
};

export type QueueHooks = {
  onQueued: (waitedMs: number) => void;
  onDispatched: (waitedMs: number) => void;
};

export type CompletionSuccess = {
  headers: SessionHeaders;
  body: unknown;
  metadata: () => Omit<FinalizeOutcome, "status">;
};

export type StreamSuccess = {
  headers: SessionHeaders;
  body: ReadableStream<Uint8Array>;
  metadata: () => Omit<FinalizeOutcome, "status">;
};

export type LiveRequestStatus = {
  id: string;
  state: "admitted" | "queued" | "dispatched" | "completed" | "error" | "cancelled";
  priority: Priority;
  waited_ms: number;
};

export type KeyService = {
  listKeys: (query: { cursor?: string; limit: number }) => Promise<KeyListPage>;
  createKey: (input: KeyDraft) => Promise<RevealedKey>;
  updateKey: (id: string, input: KeyPatch) => Promise<PublicKey>;
  revokeKey: (id: string) => Promise<void>;
  rotateKey: (id: string, expectedVersion: number) => Promise<RevealedKey>;
  admit: (rawKey: string) => Promise<Admission>;
  authenticate: (rawKey: string) => Promise<{ keyId: string; policy: KeyPolicy }>;
  recheck: (admission: Admission) => Promise<Admission>;
  finalize: (admission: Admission, outcome: FinalizeOutcome) => Promise<void>;
  usageSummary: (query: UsageQuery) => Promise<UsageSummary>;
  recentRequests: (query: RequestQuery) => Promise<RecentRequestList>;
  analytics: (query: AnalyticsQuery) => Promise<AnalyticsSnapshot>;
};

export type InferenceGateway = {
  complete: (
    work: RoutedWork,
    hooks?: QueueHooks,
    signal?: AbortSignal,
  ) => Promise<CompletionSuccess>;
  stream: (work: RoutedWork, hooks?: QueueHooks, signal?: AbortSignal) => Promise<StreamSuccess>;
};

export type HealthService = {
  snapshot: () => Promise<HealthSnapshot>;
};

export type AdminDeps = {
  appOrigin: string;
  basicAuth?: { username: string; password: string };
  keys: KeyService;
};

export type InferenceDeps = {
  keys: KeyService;
  gateway: InferenceGateway;
  status: RequestStatusStore;
  now?: () => number;
  newId?: () => string;
};

export type HealthDeps = {
  health: HealthService;
};
