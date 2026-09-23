import { SPILL_WINDOW_MS, spillAtFor } from "../batch/spill.ts";
import type { BatchResultRow } from "../batch/results.ts";
import { BatchResultStoreCorrupt } from "../batch/results.ts";
import type { BatchJob, BatchItemDraft } from "../domain.ts";
import {
  BATCH_MAX_CUSTOM_ID_CHARS,
  BATCH_MAX_INFLIGHT_JOBS_PER_KEY,
  BATCH_MAX_ITEM_BODY_BYTES,
  BATCH_MAX_ITEMS_PER_JOB,
  BATCH_MAX_JOB_BODY_BYTES,
  batchStatusIsTerminal,
} from "../domain.ts";
import { readJsonObject } from "./body.ts";
import type { BatchDeps, BatchWireList, BatchWireObject } from "./contracts.ts";
import { failureResponse, HttpFailure, InvalidInput, jsonResponse } from "./errors.ts";
import { BODY_READ_TIMEOUT_MS } from "./limits.ts";
import { bearerToken } from "./security.ts";

export const CHAT_ENDPOINT = "/v1/chat/completions" as const;
const LIST_LIMIT_DEFAULT = 20;
const LIST_LIMIT_MAX = 100;

/** One submitted entry after job-level and per-item validation. Entries keep request order;
 * a failure becomes a pre-failed ledger item plus an inline error result row. */
type DecodedEntry = {
  customId: string;
  body?: Record<string, unknown>;
  failure?: { code: string; message: string };
};

type DecodedSubmit = {
  model: string;
  entries: DecodedEntry[];
};

const TOP_LEVEL_KEYS: Record<string, true> = {
  endpoint: true,
  model: true,
  requests: true,
  completion_window: true,
};

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decodeBatchSubmit(value: Record<string, unknown>): DecodedSubmit {
  for (const key of Object.keys(value)) {
    if (TOP_LEVEL_KEYS[key] !== true) {
      throw new InvalidInput(`submit has unsupported field ${key}`);
    }
  }
  if (value.endpoint !== CHAT_ENDPOINT) {
    throw new InvalidInput(`endpoint must be ${CHAT_ENDPOINT}`);
  }
  if (typeof value.model !== "string" || value.model.length === 0) {
    throw new InvalidInput("model is required and must be a nonempty string");
  }
  if (value.completion_window !== undefined && value.completion_window !== "24h") {
    throw new InvalidInput("completion_window must be 24h");
  }
  if (!Array.isArray(value.requests) || value.requests.length === 0) {
    throw new InvalidInput("requests must be a nonempty array");
  }
  if (value.requests.length > BATCH_MAX_ITEMS_PER_JOB) {
    throw new InvalidInput("batch exceeds the 1000 item limit");
  }
  const model = value.model;
  const seen = new Set<string>();
  const entries: DecodedEntry[] = [];
  let firstFailure = "";
  const reject = (index: number, customId: string, code: string, message: string): void => {
    entries.push({ customId, failure: { code, message } });
    if (firstFailure.length === 0) {
      firstFailure = `requests[${index}] ${message}`;
    }
  };
  value.requests.forEach((raw: unknown, index: number) => {
    // Identity is job-level: every row of an accepted job — including pre-failed ones —
    // must carry a unique, unambiguous custom_id the durable UNIQUE(job_id, custom_id)
    // constraint can hold. Only body-level failures become per-item failed rows.
    if (!isObject(raw)) {
      throw new InvalidInput(`requests[${index}] must be an object with custom_id and body`);
    }
    const customId = raw.custom_id;
    if (typeof customId !== "string" || customId.length === 0) {
      throw new InvalidInput(`requests[${index}].custom_id must be a nonempty string`);
    }
    if (customId.length > BATCH_MAX_CUSTOM_ID_CHARS) {
      throw new InvalidInput(`requests[${index}].custom_id exceeds 128 characters`);
    }
    if (seen.has(customId)) {
      throw new InvalidInput(`requests[${index}].custom_id must be unique within the batch`);
    }
    seen.add(customId);
    const body = raw.body;
    if (!isObject(body)) {
      reject(index, customId, "invalid_body", "body must be a JSON object");
      return;
    }
    if (Buffer.byteLength(JSON.stringify(body), "utf8") > BATCH_MAX_ITEM_BODY_BYTES) {
      reject(index, customId, "body_too_large", "body exceeds 512KiB");
      return;
    }
    // Body model inherits the batch-level model when omitted (correct OpenRouter shape);
    // present-but-different is rejected per item.
    if (body.model !== undefined && body.model !== model) {
      reject(index, customId, "model_mismatch", "body.model must equal the batch model");
      return;
    }
    if (body.stream === true) {
      reject(index, customId, "stream_unsupported", "streaming is not supported for batch");
      return;
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      reject(index, customId, "messages_invalid", "messages must be a nonempty array");
      return;
    }
    for (const cap of [body.max_tokens, body.max_completion_tokens]) {
      if (cap !== undefined && (typeof cap !== "number" || !Number.isInteger(cap) || cap < 1)) {
        reject(
          index,
          customId,
          "max_tokens_invalid",
          "max_tokens must be an integer of at least 1",
        );
        return;
      }
    }
    entries.push({ customId, body });
  });
  if (!entries.some((entry) => entry.body !== undefined)) {
    throw new InvalidInput(firstFailure);
  }
  return { model, entries };
}

/** Non-terminal jobs already held by this key. Pages newest-first and stops once the cap
 * is reached, so a quiet key pays one page and a busy key stops at the fifth in-flight. */
function inflightBatchJobs(deps: BatchDeps, keyId: string): number {
  let inflight = 0;
  let after: string | undefined;
  for (;;) {
    const page = deps.ledger.list(
      keyId,
      after === undefined ? { limit: 100 } : { limit: 100, after },
    );
    inflight += page.filter((job) => !batchStatusIsTerminal(job.status)).length;
    if (inflight >= BATCH_MAX_INFLIGHT_JOBS_PER_KEY || page.length < 100) {
      return inflight;
    }
    after = page[page.length - 1]!.id;
  }
}

function requireOwnedJob(deps: BatchDeps, keyId: string, id: string): BatchJob {
  const job = deps.ledger.job(id);
  if (job === undefined || job.keyId !== keyId) {
    throw new HttpFailure(404, "not_found", "batch not found");
  }
  return job;
}

function wireBatch(job: BatchJob, results: readonly BatchResultRow[] | null): BatchWireObject {
  return {
    id: job.id,
    object: "batch",
    endpoint: CHAT_ENDPOINT,
    model: job.model,
    completion_window: "24h",
    status: job.status,
    created_at: Math.floor(job.createdAt / 1000),
    finalized_at: job.finalizedAt === null ? null : Math.floor(job.finalizedAt / 1000),
    local_wait_until: Math.floor(job.spillAt / 1000),
    deadline_at: Math.floor((job.spillAt + job.completionWindowMs) / 1000),
    request_counts: job.requestCounts,
    usage: job.usage,
    results,
    error: job.errorCode === null ? null : { code: job.errorCode, message: job.errorCode },
  };
}

/** Once `create` returns the job is durable, so downstream persistence failures must never
 * surface as an ambiguous 500 that invites a duplicate resubmit. Terminalize to failed and
 * purge partial store artifacts best-effort, then hand back the accepted outcome. */
function acceptedJobFailure(deps: BatchDeps, job: BatchJob, errorCode: string): Response {
  try {
    deps.ledger.setJobStatus(job.id, "failed", undefined, errorCode);
  } catch {
    // The durable id still reaches the caller; a later sweep or DELETE finishes the job.
  }
  try {
    deps.results.drop(job.id);
  } catch {
    // TTL covers a stranded artifact file.
  }
  let durable = job;
  try {
    durable = deps.ledger.job(job.id) ?? job;
  } catch {
    // Fall back to the create-time snapshot rather than 500 an accepted job.
  }
  return jsonResponse(202, wireBatch(durable, null));
}

/** POST /v1/batches — validate, persist, wake the scheduler. 202 with the batch object. */
export async function handleCreateBatch(request: Request, deps: BatchDeps): Promise<Response> {
  try {
    const rawKey = bearerToken(request);
    // Authenticate before touching the payload: a rejected key must never stream up to
    // 32MiB into the process.
    const auth = await deps.keys.authenticate(rawKey);
    // Drain guard 1: reject before pulling up to 32MiB from a stopping gateway.
    deps.assertAccepting();
    const body = await readJsonObject(request, {
      maxBytes: BATCH_MAX_JOB_BODY_BYTES,
      timeoutMs: BODY_READ_TIMEOUT_MS,
    });
    const decoded = decodeBatchSubmit(body);
    if (inflightBatchJobs(deps, auth.keyId) >= BATCH_MAX_INFLIGHT_JOBS_PER_KEY) {
      throw new HttpFailure(409, "conflict", "key already has 4 in-flight batch jobs");
    }
    // Drain guard 2: readJsonObject is the last await, so nothing can interleave between
    // this check and the synchronous create — a drain mid-body-read cannot slip through.
    deps.assertAccepting();
    const createdAt = Date.now();
    // spillDelayMs can be fractional for common biases (24h × 0.65); the ledger demands
    // integer ms, and flooring never spills earlier than the rule allows.
    const spillAt = Math.floor(spillAtFor(createdAt, auth.policy.localityBias));
    const drafts: BatchItemDraft[] = decoded.entries.map((entry) =>
      entry.body === undefined
        ? { customId: entry.customId, status: "failed", errorCode: entry.failure!.code }
        : { customId: entry.customId },
    );
    const { job, items } = deps.ledger.create({
      job: {
        keyId: auth.keyId,
        model: decoded.model,
        completionWindowMs: SPILL_WINDOW_MS,
        spillAt,
        createdAt,
      },
      items: drafts,
    });
    const inputs = decoded.entries.flatMap((entry, index) =>
      entry.body === undefined ? [] : [{ itemId: items[index]!.id, body: entry.body }],
    );
    try {
      deps.results.saveInputs(job.id, auth.keyId, inputs);
    } catch {
      return acceptedJobFailure(deps, job, "input_store_rejected");
    }
    // Pre-failed entries never dispatch, so their error rows are written here, at submit.
    // Running sync (no await between create and here) guarantees no dispatch has started.
    try {
      decoded.entries.forEach((entry, index) => {
        if (entry.failure === undefined) {
          return;
        }
        const item = items[index]!;
        deps.results.append(job.id, {
          id: item.id,
          custom_id: item.customId,
          response: null,
          error: { code: entry.failure.code, message: entry.failure.message },
        });
      });
    } catch {
      return acceptedJobFailure(deps, job, "result_rows_rejected");
    }
    try {
      deps.kick();
    } catch {
      // A lost nudge never un-accepts a durable job: the periodic tick picks it up.
    }
    return jsonResponse(202, wireBatch(job, null));
  } catch (error) {
    return failureResponse(error);
  }
}

/** GET /v1/batches — key-scoped list, newest first. Rows are metadata only. */
export async function handleListBatches(request: Request, deps: BatchDeps): Promise<Response> {
  try {
    const auth = await deps.keys.authenticate(bearerToken(request));
    const url = new URL(request.url);
    const rawLimit = url.searchParams.get("limit");
    let limit = LIST_LIMIT_DEFAULT;
    if (rawLimit !== null) {
      limit = Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > LIST_LIMIT_MAX) {
        throw new HttpFailure(400, "invalid", "limit must be between 1 and 100");
      }
    }
    const rawAfter = url.searchParams.get("after");
    const after = rawAfter === null || rawAfter === "" ? undefined : rawAfter;
    const rows = deps.ledger.list(auth.keyId, after === undefined ? { limit } : { limit, after });
    let hasMore = false;
    if (rows.length === limit) {
      hasMore =
        deps.ledger.list(auth.keyId, { limit: 1, after: rows[rows.length - 1]!.id }).length > 0;
    }
    const data: BatchWireObject[] = rows.map((job) => wireBatch(job, null));
    const envelope: BatchWireList = {
      object: "list",
      data,
      first_id: data[0]?.id ?? null,
      last_id: data[data.length - 1]?.id ?? null,
      has_more: hasMore,
    };
    return jsonResponse(200, envelope);
  } catch (error) {
    return failureResponse(error);
  }
}

/** GET /v1/batches/:id — retry-safe status read. Completed batches serve their stored rows
 * on every call; retention ends only at terminal DELETE or the 24h-after-terminal TTL. */
export async function handleGetBatch(
  request: Request,
  deps: BatchDeps,
  id: string,
): Promise<Response> {
  try {
    const auth = await deps.keys.authenticate(bearerToken(request));
    const job = requireOwnedJob(deps, auth.keyId, id);
    let results: readonly BatchResultRow[] | null = null;
    if (job.status === "completed") {
      const rows = deps.results.rows(job.id);
      results = rows.length > 0 ? rows : null;
    }
    return jsonResponse(200, wireBatch(job, results));
  } catch (error) {
    if (error instanceof BatchResultStoreCorrupt) {
      // Chosen corruption policy: PROPAGATE. Atomic writes make corruption an operator
      // event, never client-self-inflicted; a generic 500 cannot masquerade as success,
      // rows persist (retry-safe), and ids are logged for ops but never leaked on the wire.
      console.error("Batch result store corrupt", error.jobId, error.rowId);
    }
    return failureResponse(error);
  }
}

/** DELETE /v1/batches/:id — terminal: purge stored results (acknowledged retrieval).
 * Non-terminal: cancel undispatched items and let in-flight work finish (our documented
 * divergence from OpenRouter's terminal-only DELETE; ours never returns 409). */
export async function handleDeleteBatch(
  request: Request,
  deps: BatchDeps,
  id: string,
): Promise<Response> {
  try {
    const auth = await deps.keys.authenticate(bearerToken(request));
    const job = requireOwnedJob(deps, auth.keyId, id);
    if (batchStatusIsTerminal(job.status)) {
      deps.results.drop(job.id);
      return jsonResponse(200, wireBatch(job, null));
    }
    deps.ledger.setJobStatus(job.id, "cancelling");
    try {
      deps.kick();
    } catch {
      // The cancel is durable; the periodic tick notices without the nudge.
    }
    const fresh = deps.ledger.job(job.id) ?? job;
    return jsonResponse(200, wireBatch(fresh, null));
  } catch (error) {
    return failureResponse(error);
  }
}
