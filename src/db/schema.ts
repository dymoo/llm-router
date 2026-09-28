import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    prefix: text("prefix").notNull(),
    digest: text("digest").notNull(),
    name: text("name").notNull(),
    policyJson: text("policy_json").notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at"),
    revokedAt: integer("revoked_at"),
    lastUsedAt: integer("last_used_at"),
    version: integer("version").notNull(),
  },
  (table) => [
    uniqueIndex("api_keys_prefix_uq").on(table.prefix),
    uniqueIndex("api_keys_digest_uq").on(table.digest),
    index("api_keys_created_id_idx").on(table.createdAt, table.id),
    check("api_keys_version_positive", sql`${table.version} >= 1`),
    check(
      "api_keys_expires_at_positive",
      sql`${table.expiresAt} IS NULL OR ${table.expiresAt} >= 0`,
    ),
    check(
      "api_keys_revoked_at_positive",
      sql`${table.revokedAt} IS NULL OR ${table.revokedAt} >= 0`,
    ),
  ],
);

export const requests = sqliteTable(
  "requests",
  {
    id: text("id").primaryKey(),
    keyId: text("key_id")
      .notNull()
      .references(() => apiKeys.id),
    startedAt: integer("started_at").notNull(),
    leaseExpiresAt: integer("lease_expires_at").notNull(),
    finishedAt: integer("finished_at"),
    status: text("status").notNull(),
    deploymentId: text("deployment_id"),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    classifierBackend: text("classifier_backend"),
    classifierModelRevision: text("classifier_model_revision"),
    classifierSource: text("classifier_source"),
    classifierInputTokens: integer("classifier_input_tokens"),
    classifierElapsedMs: integer("classifier_elapsed_ms"),
    classifierReuse: text("classifier_reuse"),
    reasoningTokens: integer("reasoning_tokens"),
    cachedInputTokens: integer("cached_input_tokens"),
    ttftMs: integer("ttft_ms"),
    generationElapsedMs: integer("generation_elapsed_ms"),
    providerReportedUsd: real("provider_reported_usd"),
    estimatedCostUsd: real("estimated_cost_usd"),
    estimatedCacheSavingsUsd: real("estimated_cache_savings_usd"),
    localComputeEstimatedUsd: real("local_compute_estimated_usd"),
    priceVersion: text("price_version"),
    trajectoryHash: text("trajectory_hash"),
    errorCode: text("error_code"),
    priority: text("priority"),
    localityBias: real("locality_bias"),
    location: text("location"),
    transport: text("transport"),
    boundary: text("boundary"),
    saturation: integer("saturation"),
    queueWaitMs: integer("queue_wait_ms"),
    decisionReason: text("decision_reason"),
    selectionReasonCode: text("selection_reason_code"),
    selectionReasonDetail: text("selection_reason_detail"),
    exclusionJson: text("exclusion_json"),
    taskKind: text("task_kind"),
    difficulty: text("difficulty"),
    requestedEffort: text("requested_effort"),
    decodeTps: real("decode_tps"),
    cacheObservation: text("cache_observation"),
    costSource: text("cost_source"),
    decisionTraceJson: text("decision_trace_json"),
    /** 1 while a remote batch owns this authorized request (no ordinary HTTP lease held);
     * 0 for every request that is not remote-deferred. */
    deferred: integer("deferred").notNull().default(0),
    /** Client-declared app attribution (advisory, unverified). */
    appUrl: text("app_url"),
    appTitle: text("app_title"),
  },
  (table) => [
    index("requests_key_status_idx").on(table.keyId, table.status),
    index("requests_status_lease_idx").on(table.status, table.leaseExpiresAt),
    index("requests_started_idx").on(table.startedAt),
    index("requests_key_started_idx").on(table.keyId, table.startedAt),
    index("requests_deployment_started_idx").on(table.deploymentId, table.startedAt),
    index("requests_priority_started_idx").on(table.priority, table.startedAt),
    index("requests_location_started_idx").on(table.location, table.startedAt),
    check(
      "requests_status_known",
      sql`${table.status} IN ('running', 'success', 'error', 'abandoned')`,
    ),
    check(
      "requests_classifier_source_known",
      sql`${table.classifierSource} IS NULL OR ${table.classifierSource} IN ('full-input', 'caller-brief')`,
    ),
    check(
      "requests_classifier_reuse_known",
      sql`${table.classifierReuse} IS NULL OR ${table.classifierReuse} IN ('classified', 'exact-cache', 'session')`,
    ),
    check(
      "requests_location_known",
      sql`${table.location} IS NULL OR ${table.location} IN ('local', 'cloud')`,
    ),
    check(
      "requests_cache_observation_known",
      sql`${table.cacheObservation} IS NULL OR ${table.cacheObservation} IN ('observed-hit', 'observed-miss', 'unknown')`,
    ),
    check(
      "requests_cost_source_known",
      sql`${table.costSource} IS NULL OR ${table.costSource} IN ('provider-reported', 'local-rate-card', 'estimated')`,
    ),
    check("requests_deferred_bool", sql`${table.deferred} IN (0, 1)`),
  ],
);

export const rateLimits = sqliteTable(
  "rate_limits",
  {
    keyId: text("key_id")
      .notNull()
      .references(() => apiKeys.id),
    minute: integer("minute").notNull(),
    count: integer("count").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.keyId, table.minute] }),
    check("rate_limits_count_nonneg", sql`${table.count} >= 0`),
  ],
);

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    at: integer("at").notNull(),
    action: text("action").notNull(),
    keyId: text("key_id").references(() => apiKeys.id),
  },
  (table) => [index("audit_log_at_idx").on(table.at), index("audit_log_key_idx").on(table.keyId)],
);

/** Metadata-only batch jobs. Never stores prompts or completions; usage is provider-reported
 * batch-level JSON; input bodies and result rows live in the dedicated store outside this DB. */
export const batchJobs = sqliteTable(
  "batch_jobs",
  {
    id: text("id").primaryKey(),
    keyId: text("key_id")
      .notNull()
      .references(() => apiKeys.id),
    model: text("model").notNull(),
    status: text("status").notNull(),
    completionWindowMs: integer("completion_window_ms").notNull(),
    createdAt: integer("created_at").notNull(),
    finalizedAt: integer("finalized_at"),
    spillAt: integer("spill_at").notNull(),
    /** 1 when the submitting key allowed cloud: only then may undispatched items spill. */
    cloud: integer("cloud").notNull().default(1),
    usageJson: text("usage_json"),
    requestCountsTotal: integer("request_counts_total").notNull(),
    requestCountsCompleted: integer("request_counts_completed").notNull(),
    requestCountsFailed: integer("request_counts_failed").notNull(),
    errorCode: text("error_code"),
  },
  (table) => [
    index("batch_jobs_key_created_idx").on(table.keyId, table.createdAt),
    index("batch_jobs_status_created_idx").on(table.status, table.createdAt),
    check(
      "batch_jobs_status_known",
      sql`${table.status} IN ('validating', 'queued', 'in_progress', 'finalizing', 'completed', 'failed', 'expired', 'cancelling', 'cancelled')`,
    ),
    check("batch_jobs_completion_window_positive", sql`${table.completionWindowMs} >= 1`),
    check("batch_jobs_created_at_nonneg", sql`${table.createdAt} >= 0`),
    check("batch_jobs_spill_at_nonneg", sql`${table.spillAt} >= 0`),
    check(
      "batch_jobs_finalized_at_nonneg",
      sql`${table.finalizedAt} IS NULL OR ${table.finalizedAt} >= 0`,
    ),
    check(
      "batch_jobs_counts_nonneg",
      sql`${table.requestCountsTotal} >= 0 AND ${table.requestCountsCompleted} >= 0 AND ${table.requestCountsFailed} >= 0`,
    ),
    check(
      "batch_jobs_counts_bounded",
      sql`${table.requestCountsCompleted} + ${table.requestCountsFailed} <= ${table.requestCountsTotal}`,
    ),
  ],
);

/** Durable remote spill intent: ONE row per compatibility group with ONE proven remote id;
 * a job holds many groups. Terminal usage/harvest facts persist once per group. */
export const batchRemotes = sqliteTable(
  "batch_remotes",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => batchJobs.id),
    groupKey: text("group_key").notNull(),
    intent: text("intent").notNull(),
    submitToken: text("submit_token").notNull(),
    remoteBatchId: text("remote_batch_id"),
    usageJson: text("usage_json"),
    harvestedAt: integer("harvested_at"),
    createdAt: integer("created_at").notNull(),
    confirmedAt: integer("confirmed_at"),
  },
  (table) => [
    uniqueIndex("batch_remotes_token_uq").on(table.submitToken),
    uniqueIndex("batch_remotes_remote_id_uq").on(table.remoteBatchId),
    index("batch_remotes_job_idx").on(table.jobId),
    check(
      "batch_remotes_intent_known",
      sql`${table.intent} IN ('intended', 'confirmed', 'unknown', 'abandoned')`,
    ),
    check("batch_remotes_created_at_nonneg", sql`${table.createdAt} >= 0`),
    check(
      "batch_remotes_confirmed_at_nonneg",
      sql`${table.confirmedAt} IS NULL OR ${table.confirmedAt} >= 0`,
    ),
    check(
      "batch_remotes_confirmed_needs_id",
      sql`${table.intent} <> 'confirmed' OR ${table.remoteBatchId} IS NOT NULL`,
    ),
    check(
      "batch_remotes_unconfirmed_has_no_id",
      sql`${table.intent} = 'confirmed' OR ${table.remoteBatchId} IS NULL`,
    ),
    check(
      "batch_remotes_harvested_at_nonneg",
      sql`${table.harvestedAt} IS NULL OR ${table.harvestedAt} >= 0`,
    ),
  ],
);

export const batchItems = sqliteTable(
  "batch_items",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => batchJobs.id),
    customId: text("custom_id").notNull(),
    status: text("status").notNull(),
    requestId: text("request_id"),
    deploymentId: text("deployment_id"),
    errorCode: text("error_code"),
    createdAt: integer("created_at").notNull(),
    dispatchedAt: integer("dispatched_at"),
    finishedAt: integer("finished_at"),
    remoteId: text("remote_id").references(() => batchRemotes.id),
  },
  (table) => [
    uniqueIndex("batch_items_job_custom_uq").on(table.jobId, table.customId),
    index("batch_items_job_status_idx").on(table.jobId, table.status),
    index("batch_items_status_created_idx").on(table.status, table.createdAt),
    check(
      "batch_items_status_known",
      sql`${table.status} IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'expired', 'interrupted')`,
    ),
    check("batch_items_created_at_nonneg", sql`${table.createdAt} >= 0`),
    check(
      "batch_items_dispatched_at_nonneg",
      sql`${table.dispatchedAt} IS NULL OR ${table.dispatchedAt} >= 0`,
    ),
    check(
      "batch_items_finished_at_nonneg",
      sql`${table.finishedAt} IS NULL OR ${table.finishedAt} >= 0`,
    ),
  ],
);

export const controlPlaneTables = [
  settings,
  apiKeys,
  requests,
  rateLimits,
  auditLog,
  batchJobs,
  batchRemotes,
  batchItems,
] as const;
