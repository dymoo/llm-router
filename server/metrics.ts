import "server-only";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { Effect, Metric } from "effect";
import { PrometheusMetrics } from "effect/unstable/observability";
import packageJson from "../package.json" with { type: "json" };
import type { HealthSnapshot } from "../src/http/contracts.ts";
import type { FinalizeOutcome } from "../src/keys/types.ts";
import { ROUTE_DECISION_REASONS } from "../src/router/decision.ts";
import { processState } from "./state.ts";

const registry = () => processState.metricRegistry;
const run = (effect: Effect.Effect<void>) =>
  Effect.runSync(Effect.provideService(effect, Metric.MetricRegistry, registry()));
const counter = (name: string, value = 1, labels?: Record<string, string>, includeZero = false) => {
  if (Number.isFinite(value) && (value > 0 || (includeZero && value === 0)))
    run(
      Metric.update(
        Metric.counter(`llm_router_${name}_total`, {
          incremental: true,
          attributes: labels,
          description: `Router ${name.replaceAll("_", " ")} total`,
        }),
        value,
      ),
    );
};
const gauge = (name: string, value: number, labels?: Record<string, string>) => {
  if (Number.isFinite(value))
    run(
      Metric.update(
        Metric.gauge(`llm_router_${name}`, {
          attributes: labels,
          description: `Router ${name.replaceAll("_", " ")}`,
        }),
        value,
      ),
    );
};
const buckets = {
  request_duration_seconds: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 660],
  queue_wait_seconds: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
  ttft_seconds: [0.05, 0.1, 0.25, 0.5, 1, 2, 4, 8, 15, 30, 60],
  generation_duration_seconds: [0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 660],
  decode_tokens_per_second: [1, 2, 5, 10, 15, 20, 30, 40, 60, 80, 120, 200],
  classifier_duration_seconds: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
} as const;
const histogram = (
  name: keyof typeof buckets,
  value: number | null | undefined,
  labels?: Record<string, string>,
  scale = 1,
) => {
  if (value !== null && value !== undefined && Number.isFinite(value) && value >= 0)
    run(
      Metric.update(
        Metric.histogram(`llm_router_${name}`, {
          boundaries: buckets[name],
          attributes: labels,
          description: `Router ${name.replaceAll("_", " ")}`,
        }),
        value * scale,
      ),
    );
};
const bounded = (value: unknown, values: ReadonlySet<string> | readonly string[]): string =>
  typeof value === "string" &&
  (values instanceof Set ? values.has(value) : (values as readonly string[]).includes(value))
    ? value
    : "other";
const uuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : "other";
const deployment = (value: unknown) =>
  value === null || value === undefined || value === "none"
    ? "none"
    : bounded(value, processState.metricDeployments);
const priority = (value: unknown) => bounded(value, ["high", "medium", "low"]);
const location = (value: unknown) => bounded(value, ["local", "cloud"]);
const backend = (value: unknown) => bounded(value, ["laya", "jev"]);
const errorTags = [
  "AuthFailed",
  "KeyRevoked",
  "KeyExpired",
  "RateLimited",
  "ConcurrentLimit",
  "InvalidInput",
  "ImpossibleLimits",
  "ClassifierUnavailable",
  "ClassifierUnqualified",
  "LocalOverloaded",
  "QueueFull",
  "CapacityBusy",
  "ProviderFailure",
  "NoEligibleModel",
  "EmptyAllowlist",
  "Cancelled",
  "DatabaseError",
  "RetrievalRequired",
  "UnsupportedCapabilities",
  "MissingSession",
  "BoundaryRequired",
  "LockTimeout",
  "batch_interrupted",
];
const errorTag = (value: unknown) =>
  value === null || value === undefined
    ? "none"
    : bounded(value, errorTags) === "other"
      ? "other"
      : String(value)
          .replace(/([a-z])([A-Z])/g, "$1_$2")
          .toLowerCase();
const eventLoop = monitorEventLoopDelay({ resolution: 20 });
eventLoop.enable();

/** Only catalogue IDs can become deployment labels; dynamic IDs collapse to other. */
export function registerDeployments(ids: readonly string[]): void {
  for (const id of ids)
    if (/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(id)) processState.metricDeployments.add(id);
}
/** The generation metadata lookup yields only a bounded result label. */
export function observeOpenRouterCompleted(
  deploymentId: string,
  result: "match" | "mismatch" | "unknown",
): void {
  counter("provider_pin", 1, {
    deployment: deployment(deploymentId),
    result: bounded(result, ["match", "mismatch", "unknown"]),
  });
}
export function observeAdmission(result: unknown): void {
  counter("admissions", 1, {
    result: bounded(result, [
      "admitted",
      "unauthorized",
      "revoked",
      "expired",
      "rate_limited",
      "concurrent_limit",
      "invalid",
    ]),
  });
}
const admissionFailures: Record<string, string> = {
  AuthFailed: "unauthorized",
  KeyRevoked: "revoked",
  KeyExpired: "expired",
  RateLimited: "rate_limited",
  ConcurrentLimit: "concurrent_limit",
  InvalidInput: "invalid",
};
export function observeAdmissionFailure(error: unknown): void {
  const tag =
    error !== null && typeof error === "object" && "_tag" in error ? error._tag : undefined;
  observeAdmission(admissionFailures[String(tag)] ?? "other");
}

/** Called only after SQLite commits a running→terminal transition (never by an HTTP finally). */
export function observeFinalized(input: {
  keyId: string;
  startedAt: number;
  priority: string | null;
  outcome: FinalizeOutcome;
}): void {
  const { outcome } = input;
  const dep = deployment(outcome.deploymentId);
  // An unrouted request has no location; `other` is reserved for unexpected values.
  const loc = dep === "none" ? "none" : location(outcome.location);
  const status =
    outcome.status === "abandoned" && outcome.errorCode === "Cancelled"
      ? "cancelled"
      : bounded(outcome.status, ["success", "error", "abandoned", "cancelled"]);
  const key_id = uuid(input.keyId);
  counter("requests", 1, {
    status,
    deployment: dep,
    location: loc,
    priority: priority(input.priority),
    error: errorTag(outcome.errorCode),
    key_id,
  });
  histogram("request_duration_seconds", (Date.now() - input.startedAt) / 1000, {
    status,
    location: loc,
  });
  histogram(
    "queue_wait_seconds",
    outcome.queueWaitMs,
    { priority: priority(input.priority) },
    0.001,
  );
  histogram("ttft_seconds", outcome.ttftMs, { deployment: dep }, 0.001);
  histogram("generation_duration_seconds", outcome.generationElapsedMs, { deployment: dep }, 0.001);
  histogram("decode_tokens_per_second", outcome.decodeTps, { deployment: dep });
  for (const [kind, count] of Object.entries({
    prompt: outcome.promptTokens,
    completion: outcome.completionTokens,
    reasoning: outcome.reasoningTokens,
    cached: outcome.cachedInputTokens,
  })) {
    // Usage is only "unknown" for work a provider received; unrouted requests have none.
    if (count === null || count === undefined) {
      if (dep !== "none") counter("usage_unknown", 1, { field: kind, deployment: dep });
    } else counter("tokens", count, { kind, deployment: dep, key_id }, kind === "cached");
  }
  if (
    dep !== "none" &&
    outcome.promptTokens !== null &&
    outcome.promptTokens !== undefined &&
    outcome.cachedInputTokens !== null &&
    outcome.cachedInputTokens !== undefined
  )
    counter("cache_eligible_prompt_tokens", outcome.promptTokens, { deployment: dep }, true);
  for (const [kind, amount] of Object.entries({
    provider_reported: outcome.providerReportedUsd,
    estimated: outcome.estimatedCostUsd,
    local_compute: outcome.localComputeEstimatedUsd,
  })) {
    if (amount !== null && amount !== undefined)
      counter("cost_usd", amount, { kind, deployment: dep, key_id });
  }
  // A cache observation only exists for work a provider received.
  if (dep !== "none")
    counter("cache_observations", 1, {
      result:
        outcome.cacheObservation === "observed-hit"
          ? "hit"
          : outcome.cacheObservation === "observed-miss"
            ? "miss"
            : "unknown",
      deployment: dep,
    });
  if (outcome.classifierBackend !== undefined && outcome.classifierBackend !== null) {
    const b = backend(outcome.classifierBackend);
    counter("classifications", 1, {
      backend: b,
      source: bounded(outcome.source, ["full-input", "caller-brief"]),
      reuse: bounded(outcome.reuse, ["classified", "exact-cache", "session"]),
      task: bounded(outcome.taskKind, [
        "chat",
        "coding",
        "math",
        "analysis",
        "writing",
        "extraction",
      ]),
      difficulty: bounded(outcome.difficulty, ["easy", "moderate", "hard"]),
    });
    histogram("classifier_duration_seconds", outcome.classifierElapsedMs, { backend: b }, 0.001);
    counter("classifier_input_tokens", outcome.classifierInputTokens ?? 0, { backend: b });
  }
  if (outcome.decisionReason !== undefined && outcome.decisionReason !== null) {
    counter("route_decisions", 1, {
      reason: bounded(outcome.decisionReason, ROUTE_DECISION_REASONS),
      location: loc,
    });
    if (
      outcome.decisionReason === "local-overloaded" ||
      outcome.decisionReason === "local-overload-failover"
    )
      counter("local_overload", 1, {
        action: outcome.decisionReason === "local-overloaded" ? "report" : "failover",
        outcome: outcome.decisionReason === "local-overloaded" ? "reported" : "failed_over",
      });
  }
  if (outcome.exclusionJson) {
    try {
      const parsed: unknown = JSON.parse(outcome.exclusionJson);
      if (Array.isArray(parsed))
        for (const item of parsed)
          counter("route_exclusions", 1, {
            code: bounded(item?.code, [
              "allowlist",
              "capability",
              "context",
              "cost",
              "health",
              "placeholder",
              "quality",
            ]),
          });
    } catch {
      /* Malformed diagnostic details are never exported. */
    }
  }
}
export function observeInFlight(workload: unknown, delta: number): void {
  const workloadLabel = bounded(workload, ["interactive", "batch"]);
  processState.metricInflightWorkloads.add(workloadLabel);
  run(
    Metric.modify(
      Metric.gauge("llm_router_requests_in_flight", {
        attributes: { workload: workloadLabel },
        description: "Router requests in flight",
      }),
      delta,
    ),
  );
}
export function observeQueueEvent(event: unknown, value: unknown): void {
  counter("capacity_queue_events", 1, {
    event: bounded(event, ["queued", "dispatched", "timeout", "full"]),
    priority: priority(value),
  });
}
export function observeBatchDispatch(lane: unknown, outcome: unknown): void {
  counter("batch_dispatch", 1, {
    lane: bounded(lane, ["local", "remote"]),
    outcome: bounded(outcome, ["completed", "failed", "cancelled", "deferred"]),
  });
}
export function observeBatchSchedulerError(): void {
  counter("batch_scheduler_errors");
}

export function observeStream(outcome: unknown): void {
  counter("streams", 1, {
    outcome: bounded(outcome, ["completed", "terminal_error", "aborted", "cancelled"]),
  });
}

export function observeHealth(snapshot: HealthSnapshot): void {
  gauge("ready", Number(snapshot.ready));
  gauge("persistence_ready", Number(snapshot.persistence === true));
  gauge(
    "health_snapshot_age_seconds",
    Math.max(0, (Date.now() - (snapshot.checkedAt ?? Date.now())) / 1000),
  );
  const b = backend(snapshot.classifier.backend);
  gauge("classifier_ready", Number(snapshot.classifier.ready), { backend: b });
  gauge(
    "classifier_qualified",
    Number(
      snapshot.classifier.evidence !== "unqualified" && snapshot.classifier.evidence !== undefined,
    ),
    { backend: b },
  );
  for (const item of snapshot.deployments)
    gauge("deployment_ready", Number(item.ready), {
      deployment: deployment(item.id),
      location: location(item.location),
      transport: bounded(processState.metricTransports.get(item.id), [
        "llamacpp",
        "openai-compatible",
        "openrouter",
        "halogen",
        "gufo",
      ]),
    });
}
export function observeCapacity(
  rows: readonly {
    deploymentId: string;
    runningHigh: number;
    runningMedium: number;
    runningLow: number;
    maxParallel: number;
    reservedInteractiveSlots: number;
    waiting: number;
  }[],
  queueDepth = rows[0]?.waiting ?? 0,
): void {
  gauge("capacity_queue_depth", queueDepth);
  for (const row of rows) {
    const labels = { deployment: deployment(row.deploymentId) };
    gauge("capacity_permits_max", row.maxParallel, labels);
    gauge("capacity_reserved_interactive", row.reservedInteractiveSlots, labels);
    for (const [priority, count] of Object.entries({
      high: row.runningHigh,
      medium: row.runningMedium,
      low: row.runningLow,
    }))
      gauge("capacity_permits_in_use", count, { ...labels, priority });
  }
}

export interface SqlMetrics {
  keys: readonly { state: string; count: number }[];
  keyInfo: readonly { id: string; name: string; policyJson: string }[];
  jobs: readonly { status: string; count: number }[];
  items: readonly { status: string; count: number }[];
  remotes: readonly { state: string; count: number }[];
}
export function clearSqlMetrics(): void {
  for (const name of [
    "keys",
    "key_info",
    "key_requests_per_minute_limit",
    "key_max_concurrent",
    "batch_jobs",
    "batch_items",
    "batch_remote_intents",
  ])
    for (const [key, meta] of registry())
      if (meta.id === `llm_router_${name}`) registry().delete(key);
}
export function observeSqlMetrics(rows: SqlMetrics): void {
  clearSqlMetrics();
  for (const state of ["active", "revoked", "expired"])
    gauge("keys", rows.keys.find((row) => row.state === state)?.count ?? 0, { state });
  for (const item of rows.keyInfo) {
    const key_id = uuid(item.id);
    if (key_id === "other") continue;
    try {
      const policy = JSON.parse(item.policyJson) as {
        priority?: string;
        overloadAction?: string;
        requestsPerMinute?: number;
        maxConcurrent?: number;
      };
      gauge("key_info", 1, {
        key_id,
        name: item.name.slice(0, 64),
        priority: priority(policy.priority),
        overload_action: bounded(policy.overloadAction, ["report", "failover"]),
      });
      gauge("key_requests_per_minute_limit", policy.requestsPerMinute ?? 0, { key_id });
      gauge("key_max_concurrent", policy.maxConcurrent ?? 0, { key_id });
    } catch {
      /* Invalid stored policy cannot create a dynamic series. */
    }
  }
  for (const status of [
    "validating",
    "queued",
    "in_progress",
    "finalizing",
    "completed",
    "failed",
    "expired",
    "cancelling",
    "cancelled",
  ])
    gauge("batch_jobs", rows.jobs.find((row) => row.status === status)?.count ?? 0, { status });
  for (const status of [
    "queued",
    "running",
    "completed",
    "failed",
    "cancelled",
    "expired",
    "interrupted",
  ])
    gauge("batch_items", rows.items.find((row) => row.status === status)?.count ?? 0, { status });
  for (const state of ["intended", "confirmed", "unknown", "abandoned"])
    gauge("batch_remote_intents", rows.remotes.find((row) => row.state === state)?.count ?? 0, {
      state,
    });
}

/** A render never triggers inference or admission; live sources are sampled by the listener. */
export function renderMetrics(): string {
  const memory = process.memoryUsage();
  for (const workload of ["interactive", "batch"])
    if (!processState.metricInflightWorkloads.has(workload)) observeInFlight(workload, 0);
  gauge("build_info", 1, {
    version: packageJson.version,
    commit: /^[0-9a-f]{7,64}$/i.test(process.env.SOURCE_COMMIT ?? "")
      ? process.env.SOURCE_COMMIT!
      : "unknown",
  });
  gauge("process_start_time_seconds", Math.floor(Date.now() / 1000 - process.uptime()));
  gauge("process_resident_memory_bytes", memory.rss);
  gauge("process_heap_used_bytes", memory.heapUsed);
  const p99 = eventLoop.percentile(99);
  gauge("event_loop_delay_p99_seconds", Number.isFinite(p99) ? p99 / 1e9 : 0);
  gauge("metrics_scrape_duration_seconds", processState.previousMetricsScrapeSeconds);
  return Effect.runSync(
    Effect.provideService(PrometheusMetrics.format(), Metric.MetricRegistry, registry()),
  );
}
export function recordScrapeDuration(seconds: number): void {
  processState.previousMetricsScrapeSeconds = seconds;
}
