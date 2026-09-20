import type {
  AdminErrorCode,
  HealthSnapshot,
  KeyDraft,
  KeyListPage,
  KeyPolicy,
  PublicKey,
  RequestPage,
  RevealedSecret,
  RoutingRow,
  UsageAggregates,
  UsageQuery,
  UsageSnapshot,
} from "./types";

const ADMIN_HEADER = "X-Jev-Admin";
const JSON_HEADERS = {
  "Content-Type": "application/json",
  [ADMIN_HEADER]: "1",
} as const;

export class AdminApiError extends Error {
  readonly status: number;
  readonly code: AdminErrorCode;
  readonly retryable: boolean;

  constructor(status: number, code: AdminErrorCode, message: string) {
    super(message);
    this.name = "AdminApiError";
    this.status = status;
    this.code = code;
    this.retryable = status === 429 || status >= 500;
  }

  get unauthorized(): boolean {
    return this.status === 401 || this.code === "unauthorized";
  }

  get stale(): boolean {
    return this.status === 409 || this.code === "stale_version" || this.code === "conflict";
  }
}

export async function listKeys(cursor: string | null, limit = 50): Promise<KeyListPage> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor !== null && cursor.length > 0) {
    params.set("cursor", cursor);
  }
  const response = await send(`/api/admin/keys?${params.toString()}`, { method: "GET" });
  if (!response.ok) {
    throw await errorFrom(response, "Could not load keys.");
  }
  return decodeKeyList(await readJson(response));
}

export async function createKey(draft: KeyDraft): Promise<RevealedSecret> {
  const response = await send("/api/admin/keys", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(writeDraft(draft)),
  });
  if (!response.ok) {
    throw await errorFrom(response, "Could not create the key.");
  }
  const decoded = decodeRevealed(await readJson(response), "created");
  if (!decoded) {
    throw new AdminApiError(
      500,
      "unknown",
      "The server created a key but did not return a secret.",
    );
  }
  return decoded;
}

export async function updateKey(
  id: string,
  expectedVersion: number,
  draft: KeyDraft,
): Promise<PublicKey> {
  const response = await send(`/api/admin/keys/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify({ expectedVersion, ...writeDraft(draft) }),
  });
  if (!response.ok) {
    throw await errorFrom(response, "Could not save the key.");
  }
  return decodeWrappedKey(await readJson(response));
}

export async function revokeKey(id: string): Promise<void> {
  const response = await send(`/api/admin/keys/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: JSON_HEADERS,
  });
  if (response.status === 204 || response.status === 200) {
    return;
  }
  throw await errorFrom(response, "Could not revoke the key.");
}

export async function rotateKey(id: string, expectedVersion: number): Promise<RevealedSecret> {
  const response = await send(`/api/admin/keys/${encodeURIComponent(id)}/rotate`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ expectedVersion }),
  });
  if (!response.ok) {
    throw await errorFrom(response, "Could not rotate the key.");
  }
  const decoded = decodeRevealed(await readJson(response), "rotated");
  if (!decoded) {
    throw new AdminApiError(
      500,
      "unknown",
      "The server rotated a key but did not return a secret.",
    );
  }
  return decoded;
}

export async function loadHealth(): Promise<HealthSnapshot> {
  try {
    const response = await send("/api/health", { method: "GET" });
    if (!response.ok) {
      return unavailableHealth();
    }
    return decodeHealth(await readJson(response));
  } catch {
    return unavailableHealth();
  }
}

export async function loadUsage(query: UsageQuery): Promise<UsageSnapshot> {
  try {
    const params = usageParams(query);
    const path = params.size > 0 ? `/api/admin/usage?${params.toString()}` : "/api/admin/usage";
    const response = await send(path, { method: "GET" });
    if (response.status === 401) {
      throw await errorFrom(response, "Credentials required. Reload after the browser signs in.");
    }
    if (!response.ok) {
      return unavailableUsage();
    }
    return decodeUsage(await readJson(response));
  } catch (error) {
    if (error instanceof AdminApiError && error.unauthorized) {
      throw error;
    }
    return unavailableUsage();
  }
}

export async function loadRequests(
  query: UsageQuery,
  cursor: string | null,
  limit = 50,
): Promise<RequestPage> {
  try {
    const params = usageParams(query);
    params.set("limit", String(limit));
    if (cursor !== null && cursor.length > 0) {
      params.set("cursor", cursor);
    }
    const response = await send(`/api/admin/requests?${params.toString()}`, { method: "GET" });
    if (response.status === 401) {
      throw await errorFrom(response, "Credentials required. Reload after the browser signs in.");
    }
    if (!response.ok) {
      return { available: false, items: [], nextCursor: null };
    }
    return decodeRequestPage(await readJson(response));
  } catch (error) {
    if (error instanceof AdminApiError && error.unauthorized) {
      throw error;
    }
    return { available: false, items: [], nextCursor: null };
  }
}

export function unavailableHealth(): HealthSnapshot {
  return {
    ready: false,
    classifier: { ready: false, backend: "unknown", local: false },
    deployments: [],
  };
}

export function unavailableUsage(): UsageSnapshot {
  return emptyUsage();
}

function usageParams(query: UsageQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.since !== null) {
    params.set("since", String(query.since));
  }
  if (query.until !== null) {
    params.set("until", String(query.until));
  }
  if (query.keyId !== null && query.keyId.length > 0) {
    params.set("keyId", query.keyId);
  }
  if (query.priority !== null) {
    params.set("priority", query.priority);
  }
  if (query.deploymentId !== null && query.deploymentId.length > 0) {
    params.set("deploymentId", query.deploymentId);
  }
  return params;
}

function emptyAggregates(): UsageAggregates {
  return {
    requestCount: 0,
    successCount: 0,
    errorCount: 0,
    cancelCount: null,
    saturationCount: null,
    classifierCalls: null,
    exactCacheHits: null,
    sessionReuse: null,
    promptTokens: null,
    completionTokens: null,
    reasoningTokens: null,
    cachedTokens: null,
    cachedInputTokens: null,
    estimatedUsd: null,
    actualUsd: null,
    localComputeUsd: null,
    unknownCostCount: null,
    unknownUsageCount: null,
    queueWaitMs: null,
    ttftMs: null,
    decodeTps: null,
    elapsedMs: null,
    localRequests: null,
    cloudRequests: null,
    classifierInputTokens: null,
    classifierEstimatedUsd: null,
    cacheSavingsUsd: null,
    p95QueueWaitMs: null,
    p95TtftMs: null,
    p95ElapsedMs: null,
  };
}

function emptyUsage(): UsageSnapshot {
  return {
    available: false,
    aggregates: emptyAggregates(),
    series: [],
    breakdowns: { byKey: [], byPriority: [], byDeployment: [] },
    decisions: [],
    tasks: [],
    errors: [],
    exclusions: [],
    effort: [],
    complexity: [],
    recent: [],
  };
}

function writeDraft(draft: KeyDraft): {
  name: string;
  expiresAt: number | null;
  policy: KeyPolicy;
} {
  return {
    name: draft.name.trim(),
    expiresAt: draft.expiresAt,
    policy: draft.policy,
  };
}

async function send(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(path, {
      ...init,
      credentials: "include",
      cache: "no-store",
    });
  } catch {
    throw new AdminApiError(0, "unavailable", "The gateway is unreachable.");
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim().length === 0) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AdminApiError(
      response.status,
      "unknown",
      "The server returned a response that is not JSON.",
    );
  }
}

async function errorFrom(response: Response, fallback: string): Promise<AdminApiError> {
  const code = codeFromStatus(response.status);
  let message = fallback;
  try {
    const payload = await readJson(response);
    const extracted = messageFromErrorPayload(payload);
    if (extracted) {
      message = extracted;
    }
  } catch {
    // Keep the fallback message when the error body is unreadable.
  }
  if (response.status === 401) {
    message = "Credentials required. Reload after the browser signs in.";
  } else if (response.status === 429) {
    message = "Too many attempts this minute. Wait, then try again.";
  }
  return new AdminApiError(
    response.status,
    codeFromPayload(response.status, code, message),
    message,
  );
}

function codeFromStatus(status: number): AdminErrorCode {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "stale_version";
  if (status === 429) return "rate_limited";
  if (status === 400 || status === 422) return "invalid";
  if (status >= 500) return "unavailable";
  return "unknown";
}

function codeFromPayload(
  status: number,
  fallback: AdminErrorCode,
  _message: string,
): AdminErrorCode {
  if (status === 409) return "stale_version";
  return fallback;
}

function messageFromErrorPayload(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }
  const error = payload.error;
  if (isRecord(error) && typeof error.message === "string" && error.message.trim().length > 0) {
    return error.message;
  }
  if (typeof payload.message === "string" && payload.message.trim().length > 0) {
    return payload.message;
  }
  return null;
}

export function decodeKeyList(payload: unknown): KeyListPage {
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    throw new AdminApiError(500, "unknown", "Key list was missing items.");
  }
  const nextCursor =
    payload.nextCursor === null || payload.nextCursor === undefined
      ? null
      : typeof payload.nextCursor === "string"
        ? payload.nextCursor
        : null;
  return {
    items: payload.items.map((item, index) => decodePublicKey(item, `items[${index}]`)),
    nextCursor,
  };
}

function decodeWrappedKey(payload: unknown): PublicKey {
  if (isRecord(payload) && "key" in payload) {
    return decodePublicKey(payload.key, "key");
  }
  return decodePublicKey(payload, "key");
}

function decodeRevealed(payload: unknown, reason: RevealedSecret["reason"]): RevealedSecret | null {
  if (!isRecord(payload) || typeof payload.secret !== "string" || payload.secret.length === 0) {
    return null;
  }
  return {
    key: decodePublicKey(payload.key, "key"),
    secret: payload.secret,
    reason,
  };
}

export function decodePublicKey(payload: unknown, path = "key"): PublicKey {
  if (!isRecord(payload)) {
    throw new AdminApiError(500, "unknown", `Invalid key record at ${path}.`);
  }
  const id = requiredString(payload.id, `${path}.id`);
  const prefix = requiredString(payload.prefix, `${path}.prefix`);
  const name = requiredString(payload.name, `${path}.name`);
  return {
    id,
    prefix,
    name,
    policy: decodePolicy(payload.policy, `${path}.policy`),
    createdAt: requiredEpoch(payload.createdAt, `${path}.createdAt`),
    expiresAt: optionalEpoch(payload.expiresAt, `${path}.expiresAt`),
    revokedAt: optionalEpoch(payload.revokedAt, `${path}.revokedAt`),
    lastUsedAt: optionalEpoch(payload.lastUsedAt, `${path}.lastUsedAt`),
    version: requiredInt(payload.version, `${path}.version`),
    requestCount: optionalCount(payload.requestCount),
    runningCount: optionalCount(payload.runningCount),
    successCount: optionalCount(payload.successCount),
    errorCount: optionalCount(payload.errorCount),
  };
}

function decodePolicy(payload: unknown, path: string): KeyPolicy {
  if (!isRecord(payload)) {
    throw new AdminApiError(500, "unknown", `Invalid policy at ${path}.`);
  }
  const priority = payload.priority;
  if (priority !== "high" && priority !== "medium" && priority !== "low") {
    throw new AdminApiError(500, "unknown", `Invalid priority at ${path}.`);
  }
  const localityBias = decodeLocalityBias(payload);
  const allowedModels = decodeAllowedModels(payload.allowedModels, `${path}.allowedModels`);
  const bias = payload.bias;
  if (!isRecord(bias)) {
    throw new AdminApiError(500, "unknown", `Invalid bias at ${path}.`);
  }
  return {
    priority,
    localityBias,
    contextLimitTokens: requiredInt(payload.contextLimitTokens, `${path}.contextLimitTokens`),
    maxCompletionTokens: requiredInt(payload.maxCompletionTokens, `${path}.maxCompletionTokens`),
    allowedModels,
    requestsPerMinute: requiredInt(payload.requestsPerMinute, `${path}.requestsPerMinute`),
    maxConcurrent: requiredInt(payload.maxConcurrent, `${path}.maxConcurrent`),
    maxWaitMs: requiredInt(payload.maxWaitMs, `${path}.maxWaitMs`),
    maxEstimatedUsd: optionalFinite(payload.maxEstimatedUsd, `${path}.maxEstimatedUsd`),
    bias: {
      cost: requiredFinite(bias.cost, `${path}.bias.cost`),
      quality: requiredFinite(bias.quality, `${path}.bias.quality`),
      latency: requiredFinite(bias.latency, `${path}.bias.latency`),
    },
  };
}

function decodeLocalityBias(payload: Record<string, unknown>): number {
  if (
    typeof payload.localityBias === "number" &&
    payload.localityBias >= 0 &&
    payload.localityBias <= 1
  ) {
    return payload.localityBias;
  }
  throw new AdminApiError(500, "unknown", "Invalid localityBias.");
}

function decodeAllowedModels(payload: unknown, path: string): readonly string[] | null {
  if (payload === null || payload === undefined) {
    return null;
  }
  if (!Array.isArray(payload) || payload.some((item) => typeof item !== "string")) {
    throw new AdminApiError(500, "unknown", `Invalid allowlist at ${path}.`);
  }
  return payload;
}

export function decodeHealth(payload: unknown): HealthSnapshot {
  if (!isRecord(payload)) {
    return unavailableHealth();
  }
  const classifierRaw = isRecord(payload.classifier) ? payload.classifier : {};
  const deploymentsRaw = Array.isArray(payload.deployments) ? payload.deployments : [];
  return {
    ready: payload.ready === true,
    classifier: {
      ready: classifierRaw.ready === true,
      backend: typeof classifierRaw.backend === "string" ? classifierRaw.backend : "unknown",
      local: classifierRaw.local === true,
      evidence:
        classifierRaw.evidence === "runtime-probe" ||
        classifierRaw.evidence === "configuration-only" ||
        classifierRaw.evidence === "unavailable"
          ? classifierRaw.evidence
          : undefined,
    },
    deployments: deploymentsRaw.flatMap((item) => {
      if (!isRecord(item) || typeof item.id !== "string") {
        return [];
      }
      const location =
        item.location === "local" || item.location === "cloud" ? item.location : "unknown";
      return [
        {
          id: item.id,
          ready: item.ready === true,
          location,
          modelRevision: typeof item.modelRevision === "string" ? item.modelRevision : null,
          maxLen: nullableNumber(item.maxLen),
          headBudget: nullableNumber(item.headBudget),
        },
      ];
    }),
  };
}

export function decodeUsage(payload: unknown): UsageSnapshot {
  if (!isRecord(payload) || !isRecord(payload.window)) {
    throw new AdminApiError(502, "unavailable", "The analytics response is invalid.");
  }
  const totals = payload.window;
  return {
    available: true,
    aggregates: {
      requestCount: requiredInt(totals.requests, "window.requests"),
      successCount: requiredInt(totals.httpSuccess, "window.httpSuccess"),
      errorCount: requiredInt(totals.errors, "window.errors"),
      cancelCount: nullableCount(totals.cancelled),
      saturationCount: nullableCount(totals.saturation),
      classifierCalls: nullableCount(totals.classifiedFresh),
      exactCacheHits: nullableCount(totals.classifierExactCacheHits),
      sessionReuse: nullableCount(totals.sessionReuse),
      promptTokens: nullableCount(totals.promptTokens),
      completionTokens: nullableCount(totals.completionTokens),
      reasoningTokens: nullableCount(totals.reasoningTokens),
      cachedTokens: nullableCount(totals.cachedInputTokens),
      cachedInputTokens: nullableCount(totals.cachedInputTokens),
      estimatedUsd: nullableNumber(totals.estimatedCostUsd),
      actualUsd: nullableNumber(totals.providerReportedUsd),
      localComputeUsd: nullableNumber(totals.localComputeEstimatedUsd),
      unknownCostCount: nullableCount(totals.unknownCostCount),
      unknownUsageCount: nullableCount(totals.unknownUsageCount),
      queueWaitMs: nullableNumber(totals.p50QueueWaitMs),
      ttftMs: nullableNumber(totals.p50TtftMs),
      decodeTps: nullableNumber(totals.p50DecodeTokensPerSecond),
      elapsedMs: nullableNumber(totals.p50GenerationElapsedMs),
      localRequests: nullableCount(totals.localRequests),
      cloudRequests: nullableCount(totals.cloudRequests),
      classifierInputTokens: nullableCount(totals.classifierInputTokens),
      classifierEstimatedUsd: nullableNumber(totals.classifierEstimatedUsd),
      cacheSavingsUsd: nullableNumber(totals.estimatedCacheSavingsUsd),
      p95QueueWaitMs: nullableNumber(totals.p95QueueWaitMs),
      p95TtftMs: nullableNumber(totals.p95TtftMs),
      p95ElapsedMs: nullableNumber(totals.p95GenerationElapsedMs),
    },
    series: decodeSeries(payload.series),
    breakdowns: {
      byKey: decodeBreakdowns(payload.byKeyId),
      byPriority: decodeBreakdowns(payload.byPriority),
      byDeployment: decodeBreakdowns(payload.byDeploymentId),
    },
    decisions: decodeCountRows(payload.bySelectionCode),
    exclusions: decodeCountRows(payload.exclusions),
    effort: decodeCountRows(payload.byEffort),
    complexity: decodeCountRows(payload.byDifficulty),
    tasks: decodeCountRows(payload.byTask),
    errors: decodeCountRows(payload.errors),
    recent: [],
  };
}

export function decodeRequestPage(payload: unknown): RequestPage {
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    return { available: false, items: [], nextCursor: null };
  }
  const nextCursor =
    payload.nextCursor === null || payload.nextCursor === undefined
      ? null
      : typeof payload.nextCursor === "string"
        ? payload.nextCursor
        : null;
  return {
    available: true,
    items: payload.items.flatMap((item) => {
      const row = decodeRoutingRow(item);
      return row ? [row] : [];
    }),
    nextCursor,
  };
}

export function decodeRoutingRow(payload: unknown): RoutingRow | null {
  if (
    !isRecord(payload) ||
    typeof payload.id !== "string" ||
    typeof payload.startedAt !== "number" ||
    !Number.isFinite(payload.startedAt)
  )
    return null;
  const trace = isRecord(payload.decisionTrace) ? payload.decisionTrace : {};
  const assessment = isRecord(trace.assessment) ? trace.assessment : {};
  return {
    id: payload.id,
    createdAt: payload.startedAt,
    keyName: nullableString(payload.keyId),
    keyPrefix: null,
    deploymentId: nullableString(payload.deploymentId),
    task: nullableString(payload.taskKind),
    appliedEffort: nullableString(assessment.appliedEffort),
    outcome: nullableString(payload.status) ?? "unknown",
    classificationSource: nullableString(payload.reuse),
    classificationBackend: nullableString(payload.classifierBackend),
    cacheHit:
      payload.cacheObservation === "unknown" || payload.cacheObservation === null
        ? null
        : payload.cacheObservation === "observed-hit",
    promptTokens: nullableCount(payload.promptTokens),
    completionTokens: nullableCount(payload.completionTokens),
    reasoningTokens: nullableCount(payload.reasoningTokens),
    cachedTokens: nullableCount(payload.cachedInputTokens),
    estimatedUsd: nullableNumber(payload.estimatedCostUsd),
    actualUsd: nullableNumber(payload.providerReportedUsd),
    localComputeUsd: nullableNumber(payload.localComputeEstimatedUsd),
    elapsedMs: nullableNumber(payload.generationElapsedMs),
    ttftMs: nullableNumber(payload.ttftMs),
    decodeTps: nullableNumber(payload.decodeTps),
    queueWaitMs: nullableNumber(payload.queueWaitMs),
    location:
      payload.location === "local" || payload.location === "cloud" ? payload.location : null,
    priority:
      payload.priority === "high" || payload.priority === "medium" || payload.priority === "low"
        ? payload.priority
        : null,
    decisionReason: nullableString(payload.decisionReason),
    exclusionReasons: Array.isArray(payload.exclusions)
      ? payload.exclusions.flatMap((item) =>
          isRecord(item) && typeof item.code === "string"
            ? [`${item.deploymentId}: ${item.code}`]
            : [],
        )
      : [],
    policyVersion: nullableCount(trace.keyPolicyVersion),
    assessmentDifficulty: nullableString(payload.difficulty),
    catalogueVersion: nullableString(trace.catalogueVersion),
  };
}

export function cachedInputRatio(aggregates: UsageAggregates): number | null {
  if (
    aggregates.cachedInputTokens === null ||
    aggregates.promptTokens === null ||
    aggregates.promptTokens <= 0
  ) {
    return null;
  }
  return aggregates.cachedInputTokens / aggregates.promptTokens;
}

function decodeSeries(payload: unknown): UsageSnapshot["series"] {
  if (!Array.isArray(payload)) {
    return [];
  }
  return payload.flatMap((item) => {
    if (!isRecord(item) || typeof item.startMs !== "number" || !Number.isFinite(item.startMs)) {
      return [];
    }
    return [
      {
        t: item.startMs,
        requests: requiredInt(item.requests, "series.requests"),
        local: nullableCount(item.localRequests),
        cloud: nullableCount(item.cloudRequests),
        estimatedUsd: nullableNumber(item.estimatedCostUsd),
        actualUsd: nullableNumber(item.providerReportedUsd),
        localComputeUsd: nullableNumber(item.localComputeEstimatedUsd),
        unknownCost: nullableCount(item.unknownCostCount),
        queueWaitMs: nullableNumber(item.p50QueueWaitMs),
        ttftMs: nullableNumber(item.p50TtftMs),
        decodeTps: nullableNumber(item.p50DecodeTokensPerSecond),
        cachedInputTokens: nullableCount(item.cachedInputTokens),
        classifierExactCache: nullableCount(item.classifierExactCacheHits),
        sessionReuse: nullableCount(item.sessionReuse),
      },
    ];
  });
}

function decodeBreakdowns(payload: unknown): UsageSnapshot["breakdowns"]["byKey"] {
  if (Array.isArray(payload)) {
    return payload.flatMap((item) => {
      if (!isRecord(item) || typeof item.id !== "string") {
        return [];
      }
      return [
        {
          id: item.id,
          label: typeof item.label === "string" ? item.label : item.id,
          requests: optionalCount(item.requests),
          local: nullableCount(item.local ?? item.localRequests),
          cloud: nullableCount(item.cloud ?? item.cloudRequests),
          estimatedUsd: nullableNumber(item.estimatedUsd ?? item.estimatedCostUsd),
          actualUsd: nullableNumber(item.actualUsd ?? item.providerReportedUsd),
          localComputeUsd: nullableNumber(item.localComputeUsd ?? item.localComputeEstimatedUsd),
          errors: nullableCount(item.errors),
          cancels: nullableCount(item.cancels ?? item.cancelled),
          saturation: nullableCount(item.saturation),
        },
      ];
    });
  }
  if (!isRecord(payload)) {
    return [];
  }
  return Object.entries(payload).flatMap(([id, value]) => {
    if (!isRecord(value)) {
      return [];
    }
    return [
      {
        id,
        label: id,
        requests: optionalCount(value.requests),
        local: nullableCount(value.localRequests),
        cloud: nullableCount(value.cloudRequests),
        estimatedUsd: nullableNumber(value.estimatedCostUsd ?? value.estimatedUsd),
        actualUsd: nullableNumber(value.providerReportedUsd ?? value.actualUsd),
        localComputeUsd: nullableNumber(value.localComputeEstimatedUsd ?? value.localComputeUsd),
        errors: nullableCount(value.errors),
        cancels: nullableCount(value.cancelled),
        saturation: nullableCount(value.saturation),
      },
    ];
  });
}

function decodeCountRows(payload: unknown): UsageSnapshot["decisions"] {
  if (Array.isArray(payload)) {
    return payload.flatMap((item) => {
      if (!isRecord(item)) {
        return [];
      }
      const id =
        typeof item.id === "string" ? item.id : typeof item.label === "string" ? item.label : null;
      if (!id) {
        return [];
      }
      return [
        {
          id,
          label: typeof item.label === "string" ? item.label : id,
          count: optionalCount(item.count ?? item.requests),
        },
      ];
    });
  }
  if (!isRecord(payload)) {
    return [];
  }
  return Object.entries(payload).flatMap(([id, value]) => {
    if (typeof value === "number") {
      return [{ id, label: id, count: optionalCount(value) }];
    }
    if (!isRecord(value)) {
      return [];
    }
    return [{ id, label: id, count: optionalCount(value.requests ?? value.count) }];
  });
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AdminApiError(500, "unknown", `Missing ${path}.`);
  }
  return value;
}

function requiredInt(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new AdminApiError(500, "unknown", `Missing integer ${path}.`);
  }
  return value;
}

function requiredFinite(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AdminApiError(500, "unknown", `Missing number ${path}.`);
  }
  return value;
}

function requiredEpoch(value: unknown, path: string): number {
  return requiredInt(value, path);
}

function optionalEpoch(value: unknown, path: string): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  return requiredInt(value, path);
}

function optionalFinite(value: unknown, path: string): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  return requiredFinite(value, path);
}

function optionalCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableCount(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return value;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

function nullableString(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  return value;
}
