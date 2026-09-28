import { sql, type SQL } from "drizzle-orm";
import {
  ASSESSMENT_QUESTION_SCHEMA_VERSION,
  classifierCostUsd,
  type AnalyticsBucket,
  type AnalyticsSnapshot,
  type ClassificationReuse,
  type ClassifierQualification,
  type ClassifierRates,
  type Priority,
} from "../domain.ts";
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

type ClassifierFactRow = {
  dim: number | string | null;
  backend: string | null;
  modelRevision: string | null;
  reuse: string | null;
  inputKnown: number;
  groupRows: number;
  tokenSum: number | null;
};

/** Priced classifier spend for one dimension; null est means no row in it could be priced. */
type ClassifierSpend = { estimatedUsd: number | null; unknownCount: number };

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

function bucket(
  row: MetricRow | undefined,
  startMs: number,
  endMs: number,
  classifier?: ClassifierSpend,
): AnalyticsBucket {
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
    classifierEstimatedUsd: classifier?.estimatedUsd ?? null,
    classifierCostUnknownCount: classifier?.unknownCount ?? 0,
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

/** Grouped classifier facts for one module-owned dimension; pricing happens in JS. */
function classifierFacts(db: ControlPlaneDb, where: SQL, dimension: SQL): ClassifierFactRow[] {
  return db.all<ClassifierFactRow>(sql`
    WITH selected AS (SELECT *, ${dimension} AS dim FROM requests WHERE ${where})
    SELECT dim,
      classifier_backend AS backend,
      classifier_model_revision AS modelRevision,
      classifier_reuse AS reuse,
      (classifier_input_tokens IS NOT NULL) AS inputKnown,
      count(*) AS groupRows,
      sum(classifier_input_tokens) AS tokenSum
    FROM selected
    GROUP BY dim, classifier_backend, classifier_model_revision, classifier_reuse,
      classifier_input_tokens IS NOT NULL
  `);
}

function ratesFor(
  qualifications: readonly ClassifierQualification[],
  backend: string | null,
  modelRevision: string | null,
): ClassifierRates | undefined {
  if (backend === null || modelRevision === null) return undefined;
  return qualifications.find(
    (record) =>
      record.backend === backend &&
      record.modelRevision === modelRevision &&
      record.questionSchemaVersion === ASSESSMENT_QUESTION_SCHEMA_VERSION,
  )?.rates;
}

/**
 * Prices grouped facts through classifierCostUsd so rates come from qualification
 * records and SQL never carries a price. Group token sums are linear (the rate is
 * constant within a group), reuse groups are real zero, and unpriceable groups are
 * counted unknown instead of dropped. A dimension with no priceable rows reports
 * null, never zero.
 */
function classifierSpend(
  db: ControlPlaneDb,
  where: SQL,
  dimension: SQL,
  qualifications: readonly ClassifierQualification[],
): Map<string, ClassifierSpend> {
  const totals = new Map<string, { usd: number; priced: number; unknownCount: number }>();
  for (const fact of classifierFacts(db, where, dimension)) {
    if (fact.reuse === null) continue;
    const reuse = fact.reuse as ClassificationReuse;
    const cost = classifierCostUsd(
      reuse,
      fact.inputKnown === 1 ? Number(fact.tokenSum) : null,
      reuse === "classified"
        ? ratesFor(qualifications, fact.backend, fact.modelRevision)
        : undefined,
    );
    const key = String(fact.dim);
    const total = totals.get(key) ?? { usd: 0, priced: 0, unknownCount: 0 };
    if (cost._tag === "unknown") {
      total.unknownCount += Number(fact.groupRows);
    } else {
      total.priced += 1;
      total.usd += cost.usd;
    }
    totals.set(key, total);
  }
  return new Map<string, ClassifierSpend>(
    [...totals].map(([dim, total]) => [
      dim,
      { estimatedUsd: total.priced > 0 ? total.usd : null, unknownCount: total.unknownCount },
    ]),
  );
}

function breakdown(
  db: ControlPlaneDb,
  where: SQL,
  column: SQL,
  input: AnalyticsQuery,
  qualifications: readonly ClassifierQualification[],
) {
  const spend = classifierSpend(db, where, column, qualifications);
  return Object.fromEntries(
    groupedRows(db, where, column, DIMENSION_LIMIT)
      .filter((row) => row.dim !== null && row.dim !== undefined && String(row.dim).length > 0)
      .map((row) => [
        String(row.dim),
        bucket(row, input.since, input.until, spend.get(String(row.dim))),
      ]),
  );
}

export function queryAnalyticsSnapshot(
  db: ControlPlaneDb,
  input: AnalyticsQuery,
  qualifications: readonly ClassifierQualification[],
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
  const window = bucket(
    groupedRows(db, where, sql`'window'`, 1)[0],
    input.since,
    input.until,
    classifierSpend(db, where, sql`'window'`, qualifications).get("window"),
  );
  const byPriority = breakdown(db, where, sql`priority`, input, qualifications);
  const span = input.until - input.since;
  const bucketMs = span <= DAY_MS ? 3_600_000 : span <= 7 * DAY_MS ? 21_600_000 : DAY_MS;
  const timeDimension = sql`CAST(started_at / ${bucketMs} AS INTEGER) * ${bucketMs}`;
  const timeRows = groupedRows(db, where, timeDimension, 750);
  const timeSpend = classifierSpend(db, where, timeDimension, qualifications);
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
        timeSpend.get(String(start)),
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
    byKeyId: breakdown(db, where, sql`key_id`, input, qualifications),
    byPriority: {
      high: byPriority.high ?? bucket(undefined, input.since, input.until),
      medium: byPriority.medium ?? bucket(undefined, input.since, input.until),
      low: byPriority.low ?? bucket(undefined, input.since, input.until),
    },
    byDeploymentId: breakdown(db, where, sql`deployment_id`, input, qualifications),
    byTask: breakdown(db, where, sql`task_kind`, input, qualifications),
    byDifficulty: breakdown(db, where, sql`difficulty`, input, qualifications),
    byEffort: breakdown(db, where, sql`requested_effort`, input, qualifications),
    bySelectionCode: breakdown(db, where, sql`selection_reason_code`, input, qualifications),
    exclusions: Object.fromEntries(exclusions.map((row) => [row.code, row.count])),
    errors: Object.fromEntries(errors.map((row) => [row.code, row.count])),
  };
}
