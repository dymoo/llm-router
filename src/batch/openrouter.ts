/**
 * OpenRouter Batch spill adapter — a thin poll-and-normalize seam behind `BatchSpillPort`
 * (port type owned by src/batch/scheduler.ts). Facts and the translation table are binding from
 * docs/research/openrouter-batch.md.
 *
 * Invariants:
 * - Serialized submit body puts `endpoint`, `model`, optional `provider`, `completion_window`
 *   BEFORE `requests`: OpenRouter stream-parses the body without buffering and 400s when
 *   `requests` appears first. The payload is built as an ordered object in this file.
 * - `provider`: the caller MUST pass the deployment's selected providerRestriction; it is sent
 *   verbatim as top-level `provider.only` and never dropped to gain availability. When no
 *   restriction exists the key is omitted (default cheapest-eligible routing). An unsupported
 *   pin fails clearly: upstream 404/400 → typed BatchSubmitRejected, no silent fallback.
 * - Model ids are normalized to their base form. `:batch` endpoint variants are resolved
 *   server-side: we submit the base id, OpenRouter routes to the model's `:batch` endpoints
 *   (model with no `:batch` endpoint → 400 at submit; a `provider.only` pin matching no
 *   `:batch` endpoint → 404). We never append `:batch` ourselves; an explicit `:batch` suffix is
 *   stripped so grouping treats base and variant ids as one compatibility key. Per-request
 *   bodies never carry `model` or `provider` on the wire: they inherit the batch-level model
 *   (our surface requires body.model and rejects disagreement with the job model — re-checked
 *   here so a straggler fails as one `model_mismatch` row, not a whole-batch 400), and sync
 *   routing-only `provider` (openRouterBody's allow_fallbacks/require_parameters, which batch
 *   rejects) is dropped so a body can never override the deployment's pin — the pin travels
 *   ONLY as batch-level provider.only. tools/reasoning/sampling/max-token caps pass through
 *   untouched.
 * - Idempotency is ours (OpenRouter documents none): `prepare` persists a durable submit intent
 *   BEFORE the POST, `confirm` records the remote batch id, `abandon` clears a definitively
 *   rejected intent. The ONLY batch ever polled is one whose id `confirm` recorded — list
 *   similarity (model/count/time) can never prove ownership, so this adapter never queries the
 *   list and never adopts a lookalike. An ambiguous outcome (timeout, network error, 5xx,
 *   malformed 202) and an unconfirmed prior intent both fail closed with the typed
 *   `BatchSubmitUnknown`: no blind re-POST, intent retained for a policy-level `abandon`. A
 *   definitive 4xx is the only path that auto-abandons and permits a fresh submit on retry.
 * - `completion_window: "24h"` is the provider-side window, measured from THIS adapter's POST.
 *   It is not our job deadline: the surface owns `local_wait_until` (local-first window) and
 *   `deadline_at` (= spillAt + 24h), so a remote attempt is never expired locally at
 *   createdAt+24h while the provider legitimately still runs (local window + provider window,
 *   up to ~48h total). Upstream result retention is 30 days — distinct from both the 24h
 *   upstream window and our own 24h local result TTL after terminal.
 * - Base path is configurable: default `/api/v1/batches` (live quickstart + GA blog); the
 *   beta-era `/api/beta/batches` shape survives as `OPENROUTER_BATCH_BETA_BASE_PATH` until the
 *   live path is confirmed at integration (research Q9).
 * - Polling: GET `/:id` with exponential backoff 30s → 5min cap until a terminal state
 *   (completed | failed | expired | cancelled). Inline `results` are harvested once, at the
 *   first completed observation; terminal failures/expiry/cancel synthesize one error row per
 *   item carrying the terminal code. Result rows parse defensively — response XOR error is
 *   enforced on output, unknown upstream error fields are tolerated, chat bodies may omit
 *   `usage`.
 * - Lifecycle: `spill(items, signal?)` propagates the AbortSignal through every POST/GET, body
 *   read, and backoff sleep. Each request carries a finite deadline (requestTimeoutMs, default
 *   30s — its expiry is an ambiguous submit / transient poll failure, never a clean result),
 *   each body read is bounded to BATCH_RESULT_JOB_BUDGET_BYTES before allocation (oversized →
 *   BatchPollFailed on GET, ambiguous on submit), and the whole poll is capped by pollWindowMs
 *   (default 25h = the 24h provider window + finalize slack) so endless 5xx cannot spin
 *   forever. Abort BEFORE any dispatch → typed BatchSpillAborted with no intent recorded;
 *   abort AFTER POST dispatch → ambiguous (intent kept, typed BatchSubmitUnknown, never a
 *   silent retry); abort during polling/sleep → BatchSpillAborted with the confirmed id
 *   untouched and resumable on the next call — shutdown never fabricates an upstream cancel.
 * - Boot recovery: `pollKnown(remoteBatchId, items, deadlineAt, signal?)` resumes a proven
 *   remote batch against the persisted absolute deadline from its original submission —
 *   never re-grouping, re-classifying, or POSTing (no new intent, no duplicate spend). At the
 *   deadline it returns rows carrying `poll_deadline_exceeded` (terminal unresolved) rather
 *   than a retryable error; resumed facts are absolute, so consumers replace stored
 *   per-group state once and never accumulate per poll.
 * - Protocol: a result row populating `response` AND `error` together, a `custom_id` belonging
 *   to no spilled item, or a duplicated `custom_id` rejects the spill with typed
 *   BatchProtocolError — never a silent success from an invalid XOR row.
 * - Accounting: batch-level `usage` (tokens + provider-reported cost + is_byok) rides the port
 *   result; per-item cost is never derived (unknown ≠ zero). Job-level usage aggregates to
 *   null unless every remote batch reported usage — a partial sum would misrepresent the job.
 * - Pre-submit bans are re-checked here even though the surface validates on submit:
 *   a non-object body, `body.model` disagreeing with the batch model, `stream: true`, max
 *   output token cap < 1, and empty/missing `messages` become failed rows for those items
 *   while valid items still submit; nothing banned ever reaches the wire.
 */
import { createHash } from "node:crypto";
import { setTimeout as timerSleep } from "node:timers/promises";
import { Option, Schema } from "effect";
import type { BatchUsage } from "../domain.ts";
import type { FetchImpl } from "../router/adapters/http.ts";
import { BATCH_RESULT_JOB_BUDGET_BYTES, type BatchResultRow } from "./results.ts";
import type {
  BatchSpillGroup,
  BatchSpillItem,
  BatchSpillPort,
  BatchSpillResult,
} from "./scheduler.ts";

/** Current path (live quickstart + GA announcement). Default until confirmed at integration. */
export const OPENROUTER_BATCH_BASE_PATH = "/api/v1/batches";
/** Beta-era path from the Context7-indexed snapshot; configurable fallback, never default. */
export const OPENROUTER_BATCH_BETA_BASE_PATH = "/api/beta/batches";
/** One endpoint shape per batch; we only ever spill chat completions. */
export const OPENROUTER_BATCH_ENDPOINT = "/v1/chat/completions";
/** The only accepted upstream window; starts at upstream submission (our POST), not at spillAt. */
export const OPENROUTER_COMPLETION_WINDOW = "24h";

export const OPENROUTER_BATCH_TERMINALS = ["completed", "failed", "expired", "cancelled"] as const;
export type OpenRouterBatchTerminal = (typeof OPENROUTER_BATCH_TERMINALS)[number];

/** Row-level error codes the scheduler can map onto item statuses and error codes. */
export const SPILL_ROW_ERROR_CODES = {
  streamNotSupported: "stream_not_supported",
  maxTokensBelowOne: "max_tokens_below_one",
  emptyMessages: "empty_messages",
  malformedRequestBody: "malformed_body",
  modelMismatch: "model_mismatch",
  batchFailed: "batch_failed",
  batchExpired: "batch_expired",
  batchCancelled: "batch_cancelled",
  batchNotFound: "batch_not_found",
  pollDeadlineExceeded: "poll_deadline_exceeded",
  missingResultRow: "missing_result_row",
  malformedResponseRow: "malformed_response_row",
  emptyResultRow: "empty_result_row",
} as const;
export type SpillRowErrorCode = (typeof SPILL_ROW_ERROR_CODES)[keyof typeof SPILL_ROW_ERROR_CODES];

const TERMINAL_ROW_CODES: Record<
  Exclude<OpenRouterBatchTerminal, "completed">,
  SpillRowErrorCode
> = {
  failed: SPILL_ROW_ERROR_CODES.batchFailed,
  expired: SPILL_ROW_ERROR_CODES.batchExpired,
  cancelled: SPILL_ROW_ERROR_CODES.batchCancelled,
};

export class BatchSubmitRejected extends Schema.TaggedError<BatchSubmitRejected>()(
  "BatchSubmitRejected",
  {
    message: Schema.String,
    status: Schema.Int,
    detail: Schema.NullOr(Schema.String),
  },
) {}

export class BatchSubmitUnknown extends Schema.TaggedError<BatchSubmitUnknown>()(
  "BatchSubmitUnknown",
  {
    message: Schema.String,
    key: Schema.String,
  },
) {}

export class BatchPollFailed extends Schema.TaggedError<BatchPollFailed>()("BatchPollFailed", {
  message: Schema.String,
  status: Schema.NullOr(Schema.Int),
}) {}

/** Shutdown/abort: polling or backoff stopped promptly; confirmed state stays resumable. */
export class BatchSpillAborted extends Schema.TaggedError<BatchSpillAborted>()(
  "BatchSpillAborted",
  {
    message: Schema.String,
  },
) {}

/** Upstream result rows violated the wire contract; the spill is rejected, never guessed at. */
export class BatchProtocolError extends Schema.TaggedError<BatchProtocolError>()(
  "BatchProtocolError",
  {
    message: Schema.String,
    reason: Schema.String,
  },
) {}

/**
 * Durable submit intent recorded before the POST; `key` derives from the exact item set.
 * One intent per compatibility group with exactly one proven remoteBatchId — a job holds many
 * intents. `itemIds` are the group's exact ledger item ids, persisted at beginRemote before
 * the POST so recovery can join items back to this remote without re-running grouping.
 */
export interface BatchSubmitIntent {
  readonly key: string;
  readonly model: string;
  readonly requestCount: number;
  readonly itemIds: string[];
  readonly at: number;
}

export type BatchIntentState =
  | { readonly phase: "none" }
  | { readonly phase: "prepared" }
  | { readonly phase: "submitted"; readonly remoteBatchId: string };

export interface OpenRouterBatchSpillOptions {
  readonly apiKey: string;
  /** Default `https://openrouter.ai`. */
  readonly origin?: string;
  /** Default `OPENROUTER_BATCH_BASE_PATH`; pass `OPENROUTER_BATCH_BETA_BASE_PATH` if confirmed. */
  readonly basePath?: string;
  /**
   * The deployment's selected providerRestriction, sent verbatim as top-level `provider.only`.
   * Never drop a configured pin to gain availability; omit the key only when no restriction
   * exists. An unsupported pin fails clearly (upstream 404 → typed BatchSubmitRejected).
   */
  readonly providerOnly?: readonly string[];
  readonly fetchImpl?: FetchImpl;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /** Poll backoff bounds; defaults 30s → 5min. */
  readonly pollInitialDelayMs?: number;
  readonly pollMaxDelayMs?: number;
  /** Finite deadline for each individual POST/GET/body read; default 30s. */
  readonly requestTimeoutMs?: number;
  /** Overall cap for one call's polling; default 25h = 24h provider window + finalize slack. */
  readonly pollWindowMs?: number;
  /**
   * Called before any POST. Must durably record `{phase: "prepared"}` when no intent for
   * `intent.key` exists yet (record-if-absent, durable across restarts; the intent itself
   * carries `at`) and resolve with the state as it was BEFORE this call: `"none"` when this is
   * the first attempt (the adapter then POSTs), `"prepared"` after a prior unconfirmed attempt
   * (the adapter fails closed with BatchSubmitUnknown — no re-POST, no lookalike adoption),
   * `"submitted"` once confirmed (the adapter polls that proven id, never a second POST).
   */
  readonly prepare: (intent: BatchSubmitIntent) => BatchIntentState | Promise<BatchIntentState>;
  /** Persist the remote batch id once known — the only id the adapter will ever poll. */
  readonly confirm: (key: string, remoteBatchId: string) => void | Promise<void>;
  /** Clear a definitively rejected intent so the next attempt may submit fresh. */
  readonly abandon: (key: string, reason: string) => void | Promise<void>;
}

const POLL_INITIAL_DELAY_MS = 30_000;
const POLL_MAX_DELAY_MS = 300_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_WINDOW_MS = 25 * 60 * 60 * 1000;
/** Consecutive 404/410 observations tolerated before the batch is treated as gone upstream. */
const POLL_MISSING_LIMIT = 3;
const MAX_DETAIL_CHARS = 500;
const DEFAULT_ORIGIN = "https://openrouter.ai";

/**
 * Backoff sleep that stops promptly on shutdown AND clears its timer: the default path uses
 * timers/promises with the signal (abort cancels the pending timer); an injected test sleep
 * is raced against the signal with listener cleanup on both wake paths.
 */
const abortableSleep = async (
  ms: number,
  signal: AbortSignal | undefined,
  sleep?: (ms: number) => Promise<void>,
): Promise<void> => {
  if (signal?.aborted) {
    throw new BatchSpillAborted({ message: "spill aborted before backoff sleep" });
  }
  if (sleep !== undefined) {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const onAbort = (): void => {
      reject(new BatchSpillAborted({ message: "spill aborted during backoff sleep" }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    sleep(ms).then(
      () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      },
      (error: unknown) => {
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
    return promise;
  }
  try {
    await timerSleep(ms, undefined, { signal });
  } catch {
    throw new BatchSpillAborted({ message: "spill aborted during backoff sleep" });
  }
};

/** Wire schemas: OpenRouter's documented batch shapes. Excess keys are ignored on decode. */
const decodeSubmitResponse = Schema.decodeUnknownOption(
  Schema.Union([
    Schema.Struct({ id: Schema.NonEmptyString }),
    Schema.Struct({ data: Schema.Struct({ id: Schema.NonEmptyString }) }),
  ]),
);

const RemoteBatchStruct = Schema.Struct({
  status: Schema.String,
  id: Schema.optional(Schema.String),
  usage: Schema.optional(Schema.Unknown),
  results: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Unknown),
});

const decodeRemoteBatch = Schema.decodeUnknownOption(
  Schema.Union([RemoteBatchStruct, Schema.Struct({ data: RemoteBatchStruct })]),
);

/** Cost/byok may be absent (list rows) — counts must all be present or the usage is unknown. */
const decodeUsageFields = Schema.decodeUnknownOption(
  Schema.Struct({
    prompt_tokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    completion_tokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    total_tokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    cost: Schema.optional(Schema.NullOr(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)))),
    is_byok: Schema.optional(Schema.NullOr(Schema.Boolean)),
  }),
);

const decodeResultRow = Schema.decodeUnknownOption(
  Schema.Struct({
    custom_id: Schema.String,
    response: Schema.optional(Schema.Unknown),
    error: Schema.optional(Schema.Unknown),
  }),
);

const decodeRowResponse = Schema.decodeUnknownOption(
  Schema.Struct({
    status_code: Schema.Finite,
    request_id: Schema.optional(Schema.NullOr(Schema.String)),
    body: Schema.optional(Schema.Unknown),
  }),
);

function decodeUsage(value: unknown): BatchUsage | null {
  if (value === undefined || value === null) {
    return null;
  }
  const usage = Option.getOrNull(decodeUsageFields(value));
  if (usage === null) {
    return null;
  }
  return {
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
    cost: usage.cost ?? null,
    is_byok: usage.is_byok ?? null,
  };
}

/** Base ids pass through; an explicit `:batch` suffix is stripped (resolution is server-side). */
export function openRouterBatchModelId(model: string): string {
  const trimmed = model.trim();
  return trimmed.endsWith(":batch") ? trimmed.slice(0, -":batch".length) : trimmed;
}

/** Stable stringify so key-order differences never split a compatibility group. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * One upstream batch per compatibility key: model + deploymentId + response_format +
 * reasoning config. Canonicalized, and this also satisfies Google's rule that every request
 * in a batch share one response_format/schema — upstream fails validation naming the first
 * conflicting request. deploymentId splits mixed-deployment items so a group is always one
 * deployment (one provider pin) even when model/shape coincide.
 */
function compatibilityKey(
  model: string,
  deploymentId: string,
  body: Readonly<Record<string, unknown>>,
): string {
  const reasoning = {
    reasoning: body.reasoning ?? null,
    reasoning_effort: body.reasoning_effort ?? null,
  };
  return [
    model,
    deploymentId,
    canonicalJson(body.response_format ?? null),
    canonicalJson(reasoning),
  ].join("\0");
}

function intentKey(key: string, itemIds: readonly string[]): string {
  const ids = itemIds.slice().sort();
  return createHash("sha256")
    .update(`${key}\0${ids.join("\0")}`)
    .digest("hex");
}

type InvalidCode =
  | typeof SPILL_ROW_ERROR_CODES.streamNotSupported
  | typeof SPILL_ROW_ERROR_CODES.maxTokensBelowOne
  | typeof SPILL_ROW_ERROR_CODES.emptyMessages
  | typeof SPILL_ROW_ERROR_CODES.malformedRequestBody
  | typeof SPILL_ROW_ERROR_CODES.modelMismatch;

/** The port types `body: unknown`; this is the single boundary that proves it a plain object. */
function prevalidate(
  body: unknown,
  model: string,
): { readonly code: InvalidCode; readonly message: string } | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return {
      code: SPILL_ROW_ERROR_CODES.malformedRequestBody,
      message: "request body must be an object",
    };
  }
  const record = body as Readonly<Record<string, unknown>>;
  // Our wire requires body.model per item and the surface rejects disagreement with the job
  // model; re-checked here so a straggler fails as one row instead of a whole-batch upstream
  // 400. An absent body.model is fine — upstream bodies inherit the batch-level model.
  if (
    record.model !== undefined &&
    (typeof record.model !== "string" || openRouterBatchModelId(record.model) !== model)
  ) {
    return {
      code: SPILL_ROW_ERROR_CODES.modelMismatch,
      message: "body.model disagrees with the batch model",
    };
  }
  if (record.stream === true) {
    return {
      code: SPILL_ROW_ERROR_CODES.streamNotSupported,
      message: "stream: true is rejected for batch requests",
    };
  }
  const cap = typeof record.max_tokens === "number" ? record.max_tokens : undefined;
  const compatCap =
    typeof record.max_completion_tokens === "number" ? record.max_completion_tokens : undefined;
  if ((cap !== undefined && cap < 1) || (compatCap !== undefined && compatCap < 1)) {
    return {
      code: SPILL_ROW_ERROR_CODES.maxTokensBelowOne,
      message: "max output token cap below 1 is rejected for batch requests",
    };
  }
  if (!Array.isArray(record.messages) || record.messages.length === 0) {
    return {
      code: SPILL_ROW_ERROR_CODES.emptyMessages,
      message: "empty messages are rejected for batch requests",
    };
  }
  return null;
}

function extractBatchError(value: unknown): { code?: string; message?: string } {
  if (typeof value === "string") {
    return { message: value };
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return {
      ...(typeof record.code === "string" ? { code: record.code } : {}),
      ...(typeof record.message === "string" ? { message: record.message } : {}),
    };
  }
  return {};
}

interface RemoteBatch {
  readonly id: string;
  readonly status: string;
  readonly usage: BatchUsage | null;
  readonly results: unknown;
  readonly error: unknown;
}

function parseBatch(input: unknown): RemoteBatch | null {
  const envelope = Option.getOrNull(decodeRemoteBatch(input));
  if (envelope === null) {
    return null;
  }
  const batch = "data" in envelope ? envelope.data : envelope;
  return {
    id: batch.id ?? "",
    status: batch.status,
    usage: decodeUsage(batch.usage),
    results: batch.results ?? null,
    error: batch.error ?? null,
  };
}

/**
 * Batch-level usage over every remote batch. A missing usage anywhere makes the whole
 * aggregate null: a partial sum would present unknown spend as known (unknown ≠ zero). Cost
 * aggregates only when every batch reported it; is_byok only when uniformly reported.
 */
export function aggregateBatchUsage(usages: readonly (BatchUsage | null)[]): BatchUsage | null {
  if (usages.length === 0) return null;
  let prompt = 0;
  let completion = 0;
  let total = 0;
  let cost: number | null = 0;
  let byok: boolean | null = usages[0]?.is_byok ?? null;
  for (const usage of usages) {
    if (usage === null) return null;
    prompt += usage.prompt_tokens;
    completion += usage.completion_tokens;
    total += usage.total_tokens;
    cost = cost === null || usage.cost === null ? null : cost + usage.cost;
    if (usage.is_byok !== byok) byok = null;
  }
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
    cost,
    is_byok: byok,
  };
}

/** A prevalidated item paired with its narrowed plain-object body (see prevalidate). */
type PreparedItem = {
  readonly item: BatchSpillItem;
  readonly body: Readonly<Record<string, unknown>>;
};

function groupSubmitBody(
  model: string,
  items: readonly PreparedItem[],
  providerOnly: readonly string[] | undefined,
): Record<string, unknown> {
  // Insertion order IS the wire-order invariant: endpoint/model/[provider]/completion_window
  // must serialize before `requests` or OpenRouter's stream parser 400s the submit.
  const payload: Record<string, unknown> = {};
  payload.endpoint = OPENROUTER_BATCH_ENDPOINT;
  payload.model = model;
  if (providerOnly !== undefined && providerOnly.length > 0) {
    payload.provider = { only: [...providerOnly] };
  }
  payload.completion_window = OPENROUTER_COMPLETION_WINDOW;
  payload.requests = items.map((prepared) => {
    // Our wire requires body.model (the surface rejects disagreement with the job model);
    // OpenRouter's batch shape instead inherits the batch-level model, so it is dropped here
    // and can never disagree with the top-level `model` on the wire. Sync routing-only
    // `provider` (allow_fallbacks/require_parameters/only from the sync encoder) is rejected
    // upstream and could smuggle a pin: dropped too — the selected deployment's pin travels
    // ONLY as batch-level provider.only. tools/reasoning/sampling/max-token caps pass through.
    const body: Record<string, unknown> = { ...prepared.body };
    delete body.model;
    delete body.provider;
    return { custom_id: prepared.item.id, body };
  });
  return payload;
}

type PostOutcome =
  | { readonly kind: "accepted"; readonly remoteBatchId: string }
  | { readonly kind: "rejected"; readonly status: number; readonly detail: string | null }
  | { readonly kind: "ambiguous"; readonly why: string };

const terminalStates: ReadonlySet<string> = new Set<string>(OPENROUTER_BATCH_TERMINALS);

/**
 * The adapter's port: BatchSpillPort plus boot-safe resume of proven remote batches.
 * Scheduler wiring should accept this type (it remains assignable to plain BatchSpillPort).
 */
export interface OpenRouterBatchSpillPort extends BatchSpillPort {
  spill(items: readonly BatchSpillItem[], signal?: AbortSignal): Promise<BatchSpillResult>;
  /**
   * Boot/shutdown-safe resume of an ALREADY-CONFIRMED remote batch: polls to terminal and
   * returns this group's absolute facts WITHOUT prepare/POST/grouping/classification — a
   * resumed run must never mint a new intent (config or policy drift could duplicate spend).
   *
   * `deadlineAt` is the persisted absolute deadline derived from the ORIGINAL submission
   * (not now+N on each retry/restart). Reaching it returns rows carrying
   * `poll_deadline_exceeded` with usage null — an explicit terminal unresolved outcome the
   * scheduler terminalizes from, instead of a thrown error it would retry forever.
   *
   * Repeated resumes of a terminal batch return identical rows/usage/groups: consumers
   * persist per-group state once and REPLACE it, never accumulate per poll.
   */
  pollKnown(
    remoteBatchId: string,
    items: readonly BatchSpillItem[],
    deadlineAt: number,
    signal?: AbortSignal,
  ): Promise<BatchSpillResult>;
}

export function openRouterBatchSpill(
  options: OpenRouterBatchSpillOptions,
): OpenRouterBatchSpillPort {
  const fetchImpl: FetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const origin = (options.origin ?? DEFAULT_ORIGIN).replace(/\/+$/, "");
  const rawBasePath = options.basePath ?? OPENROUTER_BATCH_BASE_PATH;
  const basePath = `/${rawBasePath.replace(/^\/+/, "").replace(/\/+$/, "")}`;
  const batchesUrl = `${origin}${basePath}`;
  const pollInitial = options.pollInitialDelayMs ?? POLL_INITIAL_DELAY_MS;
  const pollMax = options.pollMaxDelayMs ?? POLL_MAX_DELAY_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const pollWindow = options.pollWindowMs ?? DEFAULT_POLL_WINDOW_MS;
  const authHeaders = { authorization: `Bearer ${options.apiKey}` };

  const callSignal = (signal: AbortSignal | undefined): AbortSignal =>
    AbortSignal.any(
      signal === undefined
        ? [AbortSignal.timeout(requestTimeoutMs)]
        : [signal, AbortSignal.timeout(requestTimeoutMs)],
    );

  const parseText = (text: string): unknown => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  };

  /** Reads at most BATCH_RESULT_JOB_BUDGET_BYTES, cancelling the rest before it is allocated. */
  const readBounded = async (
    response: Response,
    signal: AbortSignal | undefined,
  ): Promise<{ text: string; exceeded: boolean } | null> => {
    if (response.body === null) {
      return { text: "", exceeded: false };
    }
    const reader = response.body.getReader();
    // The composed per-request signal bounds BOTH the fetch and a stalled body read: aborting
    // cancels the reader, which settles any pending read — even when a custom fetch's body
    // ignores signals entirely.
    const deadline = callSignal(signal);
    const cancelReader = (): void => {
      void reader.cancel().catch(() => undefined);
    };
    deadline.addEventListener("abort", cancelReader, { once: true });
    const chunks: Uint8Array[] = [];
    let total = 0;
    let exceeded = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        total += value.byteLength;
        if (total > BATCH_RESULT_JOB_BUDGET_BYTES) {
          exceeded = true;
          break;
        }
        chunks.push(value);
      }
    } catch {
      return null;
    } finally {
      deadline.removeEventListener("abort", cancelReader);
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    if (deadline.aborted) {
      return null;
    }
    return { text: exceeded ? "" : Buffer.concat(chunks).toString("utf8"), exceeded };
  };

  const postBatch = async (
    model: string,
    items: readonly PreparedItem[],
    signal: AbortSignal | undefined,
  ): Promise<PostOutcome> => {
    const payload = groupSubmitBody(model, items, options.providerOnly);
    let response: Response;
    try {
      response = await fetchImpl(batchesUrl, {
        method: "POST",
        redirect: "error",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: callSignal(signal),
      });
    } catch (error) {
      // Transport failure or per-request deadline: dispatch may or may not have happened —
      // contact is uncertain either way, so the intent stays `prepared` and never re-POSTs.
      return {
        kind: "ambiguous",
        why: error instanceof Error ? error.message : "submit transport failure",
      };
    }
    const body = await readBounded(response, signal);
    if (response.status >= 400 && response.status < 500) {
      // The status line alone proves upstream refused: nothing was accepted.
      return {
        kind: "rejected",
        status: response.status,
        detail: body === null ? null : body.text.slice(0, MAX_DETAIL_CHARS),
      };
    }
    if (response.status >= 200 && response.status < 300 && body !== null && !body.exceeded) {
      const accepted = Option.getOrNull(decodeSubmitResponse(parseText(body.text)));
      if (accepted !== null) {
        return {
          kind: "accepted",
          remoteBatchId: "data" in accepted ? accepted.data.id : accepted.id,
        };
      }
    }
    return {
      kind: "ambiguous",
      why:
        body === null
          ? "submit response read aborted"
          : body.exceeded
            ? "submit response exceeds the byte bound"
            : `submit returned ${response.status} without a batch id`,
    };
  };

  const fetchBatch = async (
    id: string,
    signal: AbortSignal | undefined,
  ): Promise<RemoteBatch | null | "missing"> => {
    let response: Response;
    try {
      response = await fetchImpl(`${batchesUrl}/${encodeURIComponent(id)}`, {
        method: "GET",
        redirect: "error",
        headers: authHeaders,
        signal: callSignal(signal),
      });
    } catch {
      if (signal?.aborted) {
        throw new BatchSpillAborted({ message: "spill aborted during batch GET" });
      }
      return null; // per-request deadline or transient transport failure
    }
    if (response.status === 404 || response.status === 410) {
      await response.body?.cancel().catch(() => undefined);
      return "missing";
    }
    if (response.status >= 500 || response.status === 429) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    const body = await readBounded(response, signal);
    if (body === null) {
      if (signal?.aborted) {
        throw new BatchSpillAborted({ message: "spill aborted while reading batch GET" });
      }
      return null;
    }
    if (!response.ok) {
      throw new BatchPollFailed({
        message: `batch GET rejected: ${body.text.slice(0, MAX_DETAIL_CHARS)}`,
        status: response.status,
      });
    }
    if (body.exceeded) {
      throw new BatchPollFailed({
        message: `upstream response exceeds the ${BATCH_RESULT_JOB_BUDGET_BYTES} byte bound`,
        status: response.status,
      });
    }
    const batch = parseBatch(parseText(body.text));
    if (batch === null) {
      return null; // malformed/unusable body: transient, the poll window bounds this
    }
    if (batch.id.length === 0) {
      return null; // absent id is a parse-quality miss, not yet a contract violation
    }
    if (batch.id !== id) {
      // Never accept usage/results from a batch other than the proven one.
      throw new BatchProtocolError({
        message: `polled response id ${batch.id} does not equal requested proven id ${id}`,
        reason: "id_mismatch",
      });
    }
    return batch;
  };

  const submitGroup = async (
    groupKey: string,
    model: string,
    items: readonly PreparedItem[],
    signal: AbortSignal | undefined,
  ): Promise<string> => {
    const itemIds = items.map((prepared) => prepared.item.id);
    const intent: BatchSubmitIntent = {
      key: intentKey(groupKey, itemIds),
      model,
      requestCount: items.length,
      itemIds,
      at: now(),
    };
    const state = await options.prepare(intent);
    if (state.phase === "submitted") {
      // The only proven-ours id: recorded by confirm on an earlier attempt.
      return state.remoteBatchId;
    }
    if (state.phase === "prepared") {
      // Prior contact with the provider was never confirmed. Without a confirmed id, no
      // candidate batch can be proven ours — fail closed indefinitely; the intent is kept
      // until an operator/policy decision calls abandon. Never re-POST, never adopt.
      throw new BatchSubmitUnknown({
        message: "prior submit for this intent was never confirmed",
        key: intent.key,
      });
    }
    const outcome = await postBatch(model, items, signal);
    if (outcome.kind === "accepted") {
      await options.confirm(intent.key, outcome.remoteBatchId);
      return outcome.remoteBatchId;
    }
    if (outcome.kind === "rejected") {
      // Definitive typed rejection: nothing exists upstream, safe to terminalize the intent.
      await options.abandon(intent.key, `http_${outcome.status}`);
      throw new BatchSubmitRejected({
        message: "batch submit rejected upstream",
        status: outcome.status,
        detail: outcome.detail,
      });
    }
    // Transport error / 5xx / body parsing after POST: contact was uncertain. Keep the
    // prepared intent indefinitely and fail closed — no automatic abandon or resubmit.
    throw new BatchSubmitUnknown({
      message: `submit outcome ambiguous: ${outcome.why}`,
      key: intent.key,
    });
  };

  const pollToTerminal = async (
    remoteBatchId: string,
    deadlineAt: number,
    signal: AbortSignal | undefined,
  ): Promise<RemoteBatch | "deadline"> => {
    let delay = pollInitial;
    let missing = 0;
    for (;;) {
      if (signal?.aborted) {
        throw new BatchSpillAborted({ message: "spill aborted while polling" });
      }
      if (now() >= deadlineAt) {
        return "deadline";
      }
      const batch = await fetchBatch(remoteBatchId, signal);
      if (batch === "missing") {
        missing += 1;
        if (missing >= POLL_MISSING_LIMIT) {
          return {
            id: remoteBatchId,
            status: "failed",
            usage: null,
            results: null,
            error: { code: SPILL_ROW_ERROR_CODES.batchNotFound },
          };
        }
      } else if (batch !== null) {
        missing = 0;
        if (terminalStates.has(batch.status)) {
          return batch;
        }
      }
      await abortableSleep(delay, signal, options.sleep);
      delay = Math.min(delay * 2, pollMax);
    }
  };

  /** One row per group item; contract violations reject the whole spill as protocol errors. */
  const harvest = (
    batch: RemoteBatch,
    items: readonly BatchSpillItem[],
    into: Map<string, BatchResultRow>,
  ): void => {
    const byUpstreamId = new Map(items.map((item) => [item.id, item]));
    const seen = new Set<string>();
    if (batch.status === "completed" && Array.isArray(batch.results)) {
      for (const rawResult of batch.results) {
        const row = Option.getOrNull(decodeResultRow(rawResult));
        if (row === null) {
          continue; // unattributable garbage: its item falls back to missing_result_row below
        }
        if (
          row.response !== undefined &&
          row.response !== null &&
          row.error !== undefined &&
          row.error !== null
        ) {
          throw new BatchProtocolError({
            message: `row ${row.custom_id} populates response and error together`,
            reason: "conflicting_row",
          });
        }
        const item = byUpstreamId.get(row.custom_id);
        if (item === undefined) {
          throw new BatchProtocolError({
            message: `row custom_id ${row.custom_id} belongs to no spilled item`,
            reason: "foreign_custom_id",
          });
        }
        if (seen.has(item.id)) {
          throw new BatchProtocolError({
            message: `row custom_id ${row.custom_id} appears more than once`,
            reason: "duplicate_custom_id",
          });
        }
        seen.add(item.id);
        if (row.response !== undefined && row.response !== null) {
          const response = Option.getOrNull(decodeRowResponse(row.response));
          if (response !== null) {
            into.set(item.id, {
              id: item.id,
              custom_id: item.customId,
              response: {
                status_code: response.status_code,
                request_id: response.request_id ?? null,
                body: response.body ?? null,
              },
              error: null,
            });
            continue;
          }
          into.set(item.id, {
            id: item.id,
            custom_id: item.customId,
            response: null,
            error: { code: SPILL_ROW_ERROR_CODES.malformedResponseRow, batch_id: batch.id },
          });
          continue;
        }
        if (row.error !== undefined && row.error !== null) {
          into.set(item.id, {
            id: item.id,
            custom_id: item.customId,
            response: null,
            error: row.error,
          });
          continue;
        }
        into.set(item.id, {
          id: item.id,
          custom_id: item.customId,
          response: null,
          error: { code: SPILL_ROW_ERROR_CODES.emptyResultRow, batch_id: batch.id },
        });
      }
    }
    for (const item of items) {
      if (seen.has(item.id)) {
        continue;
      }
      if (batch.status === "completed") {
        into.set(item.id, {
          id: item.id,
          custom_id: item.customId,
          response: null,
          error: { code: SPILL_ROW_ERROR_CODES.missingResultRow, batch_id: batch.id },
        });
        continue;
      }
      const extracted = extractBatchError(batch.error);
      const terminalCode =
        batch.status === "failed" || batch.status === "expired" || batch.status === "cancelled"
          ? TERMINAL_ROW_CODES[batch.status]
          : SPILL_ROW_ERROR_CODES.batchFailed;
      into.set(item.id, {
        id: item.id,
        custom_id: item.customId,
        response: null,
        error: {
          code: extracted.code ?? terminalCode,
          ...(extracted.message === undefined ? {} : { message: extracted.message }),
          batch_id: batch.id,
        },
      });
    }
  };

  return {
    spill: async (
      items: readonly BatchSpillItem[],
      signal?: AbortSignal,
    ): Promise<BatchSpillResult> => {
      if (signal?.aborted) {
        // Nothing dispatched yet: a clean shutdown records no intent and touches no upstream.
        throw new BatchSpillAborted({ message: "spill aborted before any dispatch" });
      }
      // Rejection is a settled durable-state boundary: one combined controller gates every
      // group task, the first failure aborts its siblings, and the call throws only after ALL
      // groups settle — no sibling can POST/confirm/mutate an intent after the rejection the
      // scheduler observes, and shutdown never loses a task mid-flight.
      const controller = new AbortController();
      const relayCallerAbort = (): void => {
        controller.abort();
      };
      signal?.addEventListener("abort", relayCallerAbort, { once: true });
      try {
        const rowsById = new Map<string, BatchResultRow>();
        const groups = new Map<
          string,
          { readonly model: string; readonly items: PreparedItem[] }
        >();
        for (const item of items) {
          const model = openRouterBatchModelId(item.model);
          const invalid = prevalidate(item.body, model);
          if (invalid !== null) {
            rowsById.set(item.id, {
              id: item.id,
              custom_id: item.customId,
              response: null,
              error: { code: invalid.code, message: invalid.message },
            });
            continue;
          }
          const body = item.body as Readonly<Record<string, unknown>>; // prevalidate proved shape
          const key = compatibilityKey(model, item.deploymentId, body);
          const group = groups.get(key);
          if (group === undefined) {
            groups.set(key, { model, items: [{ item, body }] });
          } else {
            group.items.push({ item, body });
          }
        }
        const groupFacts: BatchSpillGroup[] = [];
        let firstFailure: { error: unknown } | undefined;
        // Confirmed groups keep their durable intent, so a later retry (or boot pollKnown)
        // reuses the confirmed id, re-polls, and re-reads the inline results — rows redeliver
        // on the next resolved call, and no group ever re-POSTs.
        const tasks = [...groups.entries()].map(async ([groupKey, group]) => {
          try {
            const itemIds = group.items.map((prepared) => prepared.item.id);
            const remoteBatchId = await submitGroup(
              groupKey,
              group.model,
              group.items,
              controller.signal,
            );
            // Fresh submissions get a fresh window from now; resumed confirmed groups go
            // through pollKnown with their original absolute deadline instead.
            const batch = await pollToTerminal(
              remoteBatchId,
              now() + pollWindow,
              controller.signal,
            );
            if (batch === "deadline") {
              throw new BatchPollFailed({
                message: `poll window of ${pollWindow}ms elapsed without a terminal state`,
                status: null,
              });
            }
            harvest(
              batch,
              group.items.map((prepared) => prepared.item),
              rowsById,
            );
            groupFacts.push({ remoteBatchId, itemIds, usage: batch.usage });
          } catch (error) {
            // Temporal first failure is the original: sibling aborts can only fire after this
            // assignment, so their BatchSpillAborted can never replace it.
            firstFailure ??= { error };
            controller.abort();
            throw error;
          }
        });
        await Promise.allSettled(tasks);
        if (firstFailure !== undefined) {
          throw firstFailure.error;
        }
        return {
          rows: items.map((item) => rowsById.get(item.id)).filter((row) => row !== undefined),
          usage: aggregateBatchUsage(groupFacts.map((fact) => fact.usage)),
          groups: groupFacts,
        };
      } finally {
        signal?.removeEventListener("abort", relayCallerAbort);
      }
    },

    pollKnown: async (
      remoteBatchId: string,
      items: readonly BatchSpillItem[],
      deadlineAt: number,
      signal?: AbortSignal,
    ): Promise<BatchSpillResult> => {
      if (signal?.aborted) {
        throw new BatchSpillAborted({ message: "pollKnown aborted before polling" });
      }
      const rowsById = new Map<string, BatchResultRow>();
      // No prepare, no POST, no grouping/classification: resume only touches the proven id
      // with the persisted absolute deadline from the original submission.
      const batch = await pollToTerminal(remoteBatchId, deadlineAt, signal);
      const group: BatchSpillGroup = {
        remoteBatchId,
        itemIds: items.map((item) => item.id),
        usage: batch === "deadline" ? null : batch.usage,
      };
      const assemble = (): BatchSpillResult => ({
        rows: items.map((item) => rowsById.get(item.id)).filter((row) => row !== undefined),
        usage: group.usage,
        groups: [group],
      });
      if (batch === "deadline") {
        // Terminal unresolved outcome (a return, not a throw): the scheduler terminalizes
        // from the row code instead of retrying an endlessly failing poll.
        for (const item of items) {
          rowsById.set(item.id, {
            id: item.id,
            custom_id: item.customId,
            response: null,
            error: { code: SPILL_ROW_ERROR_CODES.pollDeadlineExceeded, batch_id: remoteBatchId },
          });
        }
        return assemble();
      }
      harvest(batch, items, rowsById);
      return assemble();
    },
  };
}
