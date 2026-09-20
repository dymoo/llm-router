import { sql, type SQL } from "drizzle-orm";
import type { AnalyticsBucket, AnalyticsSnapshot, Priority } from "../domain.ts";
import type { ControlPlaneDb } from "../db/sqlite.ts";
import { InvalidInput } from "../errors.ts";

export interface AnalyticsQuery {
  since: number;
  until: number;
  keyId?: string;
  priority?: Priority;
  deploymentId?: string;
}

type MetricRow = Record<string, number | string | null>;
const DAY_MS = 86_400_000;
const DIMENSION_LIMIT = 100;
const METRICS = sql.raw(`
  count(*) AS requests,
  sum(status = 'success') AS httpSuccess,
  sum(status = 'error') AS errors,
  sum(status = 'abandoned') AS cancelled,
  sum(saturation = 1) AS saturation,
  sum(location = 'local') AS localRequests,
  sum(location = 'cloud') AS cloudRequests,
  sum(classifier_reuse = 'exact-cache') AS classifierExactCacheHits,
  sum(classifier_reuse = 'session') AS sessionReuse,
  sum(classifier_reuse = 'classified') AS classifiedFresh,
  sum(CASE WHEN classifier_reuse = 'classified' THEN classifier_input_tokens END) AS classifierInputTokens,
  sum(CASE WHEN classifier_backend = 'jev' AND classifier_reuse = 'classified'
    AND classifier_model_revision = 'jev-1.13.0' THEN classifier_input_tokens * 0.042 / 1000000.0 END) AS classifierEstimatedUsd,
  sum(prompt_tokens) AS promptTokens,
  sum(completion_tokens) AS completionTokens,
  sum(reasoning_tokens) AS reasoningTokens,
  sum(cached_input_tokens) AS cachedInputTokens,
  sum(cached_input_tokens IS NOT NULL) AS cacheObservedRequests,
  sum(cached_input_tokens > 0) AS cacheHitRequests,
  sum(provider_reported_usd) AS providerReportedUsd,
  sum(estimated_cost_usd) AS estimatedCostUsd,
  sum(local_compute_estimated_usd) AS localComputeEstimatedUsd,
  sum(estimated_cache_savings_usd) AS estimatedCacheSavingsUsd,
  sum(status != 'running' AND provider_reported_usd IS NULL
    AND local_compute_estimated_usd IS NULL) AS unknownCostCount,
  sum(status != 'running' AND (prompt_tokens IS NULL OR completion_tokens IS NULL)) AS unknownUsageCount
`);

const count = (row: MetricRow | undefined, key: string): number => Number(row?.[key] ?? 0);
const measured = (row: MetricRow | undefined, key: string): number | null =>
  row?.[key] === null || row?.[key] === undefined ? null : Number(row[key]);

function bucket(row: MetricRow | undefined, startMs: number, endMs: number): AnalyticsBucket {
  return {
    startMs,
    endMs,
    requests: count(row, "requests"),
    httpSuccess: count(row, "httpSuccess"),
    errors: count(row, "errors"),
    cancelled: count(row, "cancelled"),
    saturation: count(row, "saturation"),
    localRequests: count(row, "localRequests"),
    cloudRequests: count(row, "cloudRequests"),
    classifierExactCacheHits: count(row, "classifierExactCacheHits"),
    sessionReuse: count(row, "sessionReuse"),
    classifiedFresh: count(row, "classifiedFresh"),
    classifierInputTokens: measured(row, "classifierInputTokens"),
    classifierEstimatedUsd: measured(row, "classifierEstimatedUsd"),
    promptTokens: measured(row, "promptTokens"),
    completionTokens: measured(row, "completionTokens"),
    reasoningTokens: measured(row, "reasoningTokens"),
    cachedInputTokens: measured(row, "cachedInputTokens"),
    cacheObservedRequests: count(row, "cacheObservedRequests"),
    cacheHitRequests: count(row, "cacheHitRequests"),
    providerReportedUsd: measured(row, "providerReportedUsd"),
    estimatedCostUsd: measured(row, "estimatedCostUsd"),
    localComputeEstimatedUsd: measured(row, "localComputeEstimatedUsd"),
    estimatedCacheSavingsUsd: measured(row, "estimatedCacheSavingsUsd"),
    unknownCostCount: count(row, "unknownCostCount"),
    unknownUsageCount: count(row, "unknownUsageCount"),
    p50QueueWaitMs: measured(row, "p50_queue"),
    p95QueueWaitMs: measured(row, "p95_queue"),
    p50TtftMs: measured(row, "p50_ttft"),
    p95TtftMs: measured(row, "p95_ttft"),
    p50GenerationElapsedMs: measured(row, "p50_elapsed"),
    p95GenerationElapsedMs: measured(row, "p95_elapsed"),
    p50DecodeTokensPerSecond: measured(row, "p50_tps"),
    p95DecodeTokensPerSecond: measured(row, "p95_tps"),
  };
}

function filter(input: AnalyticsQuery): SQL {
  const conditions = [sql`started_at >= ${input.since}`, sql`started_at <= ${input.until}`];
  if (input.keyId !== undefined) conditions.push(sql`key_id = ${input.keyId}`);
  if (input.priority !== undefined) conditions.push(sql`priority = ${input.priority}`);
  if (input.deploymentId !== undefined) conditions.push(sql`deployment_id = ${input.deploymentId}`);
  return sql.join(conditions, sql` AND `);
}

/** The grouping expression is constructed only from module-owned SQL, never request text. */
function groupedRows(db: ControlPlaneDb, where: SQL, dimension: SQL, limit: number): MetricRow[] {
  return db.all<MetricRow>(sql`
    WITH selected AS (SELECT *, ${dimension} AS dim FROM requests WHERE ${where}),
    metrics AS (SELECT dim, ${METRICS} FROM selected GROUP BY dim),
    samples AS (
      SELECT dim, 'queue' AS metric, queue_wait_ms AS value FROM selected WHERE queue_wait_ms IS NOT NULL
      UNION ALL SELECT dim, 'ttft', ttft_ms FROM selected WHERE ttft_ms IS NOT NULL
      UNION ALL SELECT dim, 'elapsed', generation_elapsed_ms FROM selected WHERE generation_elapsed_ms IS NOT NULL
      UNION ALL SELECT dim, 'tps', decode_tps FROM selected WHERE decode_tps IS NOT NULL
    ),
    ranked AS (
      SELECT dim, metric, value,
        row_number() OVER (PARTITION BY dim, metric ORDER BY value) AS rank,
        count(*) OVER (PARTITION BY dim, metric) AS n FROM samples
    ),
    percentiles AS (
      SELECT dim,
        max(CASE WHEN metric = 'queue' AND rank = (n + 1) / 2 THEN value END) AS p50_queue,
        max(CASE WHEN metric = 'queue' AND rank = (n * 95 + 99) / 100 THEN value END) AS p95_queue,
        max(CASE WHEN metric = 'ttft' AND rank = (n + 1) / 2 THEN value END) AS p50_ttft,
        max(CASE WHEN metric = 'ttft' AND rank = (n * 95 + 99) / 100 THEN value END) AS p95_ttft,
        max(CASE WHEN metric = 'elapsed' AND rank = (n + 1) / 2 THEN value END) AS p50_elapsed,
        max(CASE WHEN metric = 'elapsed' AND rank = (n * 95 + 99) / 100 THEN value END) AS p95_elapsed,
        max(CASE WHEN metric = 'tps' AND rank = (n + 1) / 2 THEN value END) AS p50_tps,
        max(CASE WHEN metric = 'tps' AND rank = (n * 95 + 99) / 100 THEN value END) AS p95_tps
      FROM ranked GROUP BY dim
    )
    SELECT metrics.*, percentiles.p50_queue, percentiles.p95_queue,
      percentiles.p50_ttft, percentiles.p95_ttft, percentiles.p50_elapsed,
      percentiles.p95_elapsed, percentiles.p50_tps, percentiles.p95_tps
    FROM metrics LEFT JOIN percentiles USING (dim)
    ORDER BY metrics.requests DESC LIMIT ${limit}
  `);
}

function breakdown(db: ControlPlaneDb, where: SQL, column: SQL, input: AnalyticsQuery) {
  return Object.fromEntries(
    groupedRows(db, where, column, DIMENSION_LIMIT)
      .filter((row) => row.dim !== null && row.dim !== undefined && String(row.dim).length > 0)
      .map((row) => [String(row.dim), bucket(row, input.since, input.until)]),
  );
}

export function queryAnalyticsSnapshot(
  db: ControlPlaneDb,
  input: AnalyticsQuery,
): AnalyticsSnapshot {
  if (
    !Number.isSafeInteger(input.since) ||
    !Number.isSafeInteger(input.until) ||
    input.since < 0 ||
    input.until < input.since ||
    input.until - input.since > 31 * DAY_MS
  ) {
    throw new InvalidInput({ message: "Analytics range must be ordered and at most 31 days" });
  }
  const where = filter(input);
  const window = bucket(groupedRows(db, where, sql`'window'`, 1)[0], input.since, input.until);
  const byPriority = breakdown(db, where, sql`priority`, input);
  const span = input.until - input.since;
  const bucketMs = span <= DAY_MS ? 3_600_000 : span <= 7 * DAY_MS ? 21_600_000 : DAY_MS;
  const timeRows = groupedRows(
    db,
    where,
    sql`CAST(started_at / ${bucketMs} AS INTEGER) * ${bucketMs}`,
    750,
  );
  const timeMap = new Map(timeRows.map((row) => [Number(row.dim), row]));
  const series: AnalyticsBucket[] = [];
  for (
    let start = Math.floor(input.since / bucketMs) * bucketMs;
    start <= input.until;
    start += bucketMs
  ) {
    series.push(
      bucket(
        timeMap.get(start),
        Math.max(start, input.since),
        Math.min(start + bucketMs - 1, input.until),
      ),
    );
  }
  const exclusions = db.all<{ code: string; count: number }>(sql`
    SELECT json_extract(item.value, '$.code') AS code, count(*) AS count
    FROM requests, json_each(CASE WHEN json_valid(exclusion_json) THEN exclusion_json ELSE '[]' END) AS item
    WHERE ${where} AND json_type(item.value, '$.code') = 'text'
    GROUP BY json_extract(item.value, '$.code') ORDER BY count DESC LIMIT ${DIMENSION_LIMIT}
  `);
  const errors = db.all<{ code: string; count: number }>(sql`
    SELECT error_code AS code, count(*) AS count FROM requests
    WHERE ${where} AND error_code IS NOT NULL GROUP BY error_code ORDER BY count DESC LIMIT ${DIMENSION_LIMIT}
  `);
  return {
    window,
    series,
    bucketMs,
    byKeyId: breakdown(db, where, sql`key_id`, input),
    byPriority: {
      high: byPriority.high ?? bucket(undefined, input.since, input.until),
      medium: byPriority.medium ?? bucket(undefined, input.since, input.until),
      low: byPriority.low ?? bucket(undefined, input.since, input.until),
    },
    byDeploymentId: breakdown(db, where, sql`deployment_id`, input),
    byTask: breakdown(db, where, sql`task_kind`, input),
    byDifficulty: breakdown(db, where, sql`difficulty`, input),
    byEffort: breakdown(db, where, sql`requested_effort`, input),
    bySelectionCode: breakdown(db, where, sql`selection_reason_code`, input),
    exclusions: Object.fromEntries(exclusions.map((row) => [row.code, row.count])),
    errors: Object.fromEntries(errors.map((row) => [row.code, row.count])),
  };
}
