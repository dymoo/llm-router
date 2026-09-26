import { randomUUID } from "node:crypto";
import {
  batchItemStatusIsTerminal,
  batchStatusIsTerminal,
  type BatchItem,
  type BatchJob,
  type BatchRemote,
  type BatchUsage,
  type Deployment,
} from "../domain.ts";
import { createDeadline } from "../deadline.ts";
import type { RoutedWork } from "../http/contracts.ts";
import { classifierInputFor, decodeChatCompletion, requestCapabilities } from "../http/decode.ts";
import { GATEWAY_EFFECT_TIMEOUT_MS } from "../http/limits.ts";
import { estimateInputTokens } from "../http/tokens.ts";
import type { Admission, FinalizeOutcome } from "../keys/types.ts";
import type { BatchLedger } from "./ledger.ts";
import {
  BatchProtocolError,
  BatchSpillAborted,
  BatchSubmitRejected,
  BatchSubmitUnknown,
} from "./openrouter.ts";
import type { BatchResultRow, BatchResultStore } from "./results.ts";
import { hasSpilled } from "./spill.ts";

/**
 * The work shape shared by the deferred scheduler and the real router bridge.  `requestedModel`
 * is deliberately separate from the decoder's public `model: "auto"` field: batch callers may
 * select `auto` or an operator deployment id, but they may never smuggle an upstream provider
 * slug into the router.
 */
export interface BatchRoutedWork extends RoutedWork {
  readonly requestedModel: string;
}

/** Assessment/planning output for a remote item.  Planning is provider-free; the scheduler
 * persists this metadata before the OpenRouter POST and the key service retains it through
 * deferred finalization. */
export interface BatchPreparedSpill {
  readonly deployment: Deployment;
  readonly body: Record<string, unknown>;
  readonly metadata: Omit<FinalizeOutcome, "status">;
}

/** One intake item for one remote compatibility group. Bodies live in the private result store,
 * never in control.sqlite or analytics. `deploymentId` is persisted on the batch item by the
 * key defer transaction so confirmed recovery can resolve the same endpoint without rerouting. */
export interface BatchSpillItem {
  readonly id: string;
  readonly customId: string;
  readonly deploymentId: string;
  readonly model: string;
  readonly body: unknown;
  readonly jobId: string;
}

export interface BatchSpillGroup {
  readonly remoteBatchId: string;
  readonly itemIds: readonly string[];
  readonly usage: BatchUsage | null;
}

export interface BatchSpillResult {
  readonly rows: readonly BatchResultRow[];
  /** Aggregate convenience value; scheduler accounting uses `groups` facts, never this field. */
  readonly usage: BatchUsage | null;
  readonly groups: readonly BatchSpillGroup[];
}

/** The injected batch-spill port: one call per deployment/compatibility intake. */
export interface BatchSpillPort {
  spill(items: readonly BatchSpillItem[], signal?: AbortSignal): Promise<BatchSpillResult>;
}

/** Boot/shutdown-safe resume of an ALREADY-CONFIRMED remote batch. */
export interface BatchSpillResume {
  pollKnown(
    remoteBatchId: string,
    items: readonly BatchSpillItem[],
    deadlineAt: number,
    signal?: AbortSignal,
  ): Promise<BatchSpillResult>;
}

export interface BatchDispatchResult {
  readonly body: unknown;
  readonly deploymentId: string | null;
  readonly metadata: () => Omit<FinalizeOutcome, "status">;
}

/** The runtime bridge is intentionally split: complete is local-only, while prepareSpill does
 * real assessment/filtering/effort planning and MUST NOT call a provider. */
export interface BatchInferencePort {
  interactiveIdle(): boolean;
  complete(work: BatchRoutedWork, signal?: AbortSignal): Promise<BatchDispatchResult>;
  prepareSpill(
    work: BatchRoutedWork,
    catalogue: readonly Deployment[],
    signal?: AbortSignal,
  ): Promise<BatchPreparedSpill>;
}

/** Internal key lifecycle used by the scheduler. Deferred operations never expose an HTTP auth
 * bypass: the key id comes from the durable batch job and all policy/version checks happen here. */
export interface BatchKeysPort {
  admitByKeyId(keyId: string): Promise<Admission>;
  attach(admission: Admission, itemId: string): Promise<void>;
  recheck(admission: Admission): Promise<Admission>;
  /** Recheck a request after defer, immediately before new remote contact. */
  recheckDeferred(admission: Admission): Promise<void>;
  finalize(admission: Admission, outcome: FinalizeOutcome): Promise<void>;
  defer(
    admission: Admission,
    itemId: string,
    metadata: Omit<FinalizeOutcome, "status">,
    deadlineAt: number,
  ): Promise<void>;
  finalizeDeferred(keyId: string, requestId: string, outcome: FinalizeOutcome): Promise<void>;
  finalizeInterrupted(keyId: string, itemId: string): Promise<void>;
}

export interface BatchSchedulerDeps {
  readonly ledger: BatchLedger;
  readonly results: BatchResultStore;
  readonly inference: BatchInferencePort;
  readonly keys: BatchKeysPort;
  readonly now: () => number;
  readonly intervalMs: number;
  /** Dedicated BATCH_CATALOG; never merged with the synchronous catalogue. */
  readonly batchCatalogue: readonly Deployment[];
  /** Called after a failed scheduler tick; errors are also logged regardless of this hook. */
  readonly onTickError?: () => void;
  readonly spill?: BatchSpillPort & Partial<BatchSpillResume>;
}

export interface BatchScheduler {
  start(): void;
  kick(): void;
  /** Stops new work, lets in-flight local calls finish, and aborts remote contact/polls. */
  drain(): Promise<void>;
}

const BATCH_DISPATCH_PER_TICK = 8;
/** OpenRouter polls for 25h from submission: 24h execution plus one hour to observe finalization. */
const REMOTE_POLL_GRACE_MS = 60 * 60 * 1_000;

const LOCAL_SPILL_CODES = new Set([
  "NoEligibleModel",
  "RetrievalRequired",
  "UnsupportedCapabilities",
  "EmptyAllowlist",
  "CatalogueInvalid",
]);

const RETRY_CODES = new Set([
  "CapacityBusy",
  "QueueFull",
  "LockTimeout",
  "RateLimited",
  "ConcurrentLimit",
]);

type PollRetry = {
  readonly jobId: string;
  readonly remoteId: string;
};

type PreparedRemote = {
  readonly job: BatchJob;
  readonly item: BatchItem;
  readonly admission: Admission;
  readonly work: BatchRoutedWork;
  readonly prepared: BatchPreparedSpill;
};

type PendingLocalResult = {
  readonly job: BatchJob;
  readonly item: BatchItem;
  readonly admission: Admission;
  readonly result: BatchDispatchResult;
  readonly outcome: FinalizeOutcome;
  accounted: boolean;
};

type PendingSettlement = {
  readonly job: BatchJob;
  readonly item: BatchItem;
  readonly code: string;
  readonly action: "failed" | "cancelled" | "requeue";
  readonly finalize?: () => Promise<void>;
  finalized: boolean;
};

function errorCodeOf(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const tagged = (error as { _tag?: unknown })._tag;
    if (typeof tagged === "string" && tagged.length > 0) return tagged;
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
    const name = (error as { name?: unknown }).name;
    if (typeof name === "string" && name.length > 0 && name !== "Error") return name;
  }
  return "Error";
}

function rowErrorCode(error: unknown, status?: number): string {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  if (status !== undefined && Number.isFinite(status)) return `http_${status}`;
  return "batch_error";
}

function rowUsageTokens(body: unknown): { prompt: number | null; completion: number | null } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { prompt: null, completion: null };
  }
  const usage = (body as Record<string, unknown>).usage;
  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) {
    return { prompt: null, completion: null };
  }
  const prompt = (usage as Record<string, unknown>).prompt_tokens;
  const completion = (usage as Record<string, unknown>).completion_tokens;
  return {
    prompt: typeof prompt === "number" && Number.isFinite(prompt) ? prompt : null,
    completion: typeof completion === "number" && Number.isFinite(completion) ? completion : null,
  };
}

function responseSucceeded(row: BatchResultRow): boolean {
  if (row.response === null) return false;
  const status = row.response.status_code;
  // A non-2xx provider response is an item error even though OpenRouter places it in `response`.
  // A body must be an object so malformed success payloads cannot be claimed as completions.
  return (
    Number.isFinite(status) &&
    status >= 200 &&
    status < 300 &&
    typeof row.response.body === "object" &&
    row.response.body !== null &&
    !Array.isArray(row.response.body)
  );
}

function setEquals(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const a = new Set(left);
  const b = new Set(right);
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

function dispatchable(status: BatchJob["status"]): boolean {
  return status === "validating" || status === "queued" || status === "in_progress";
}

export function createBatchScheduler(deps: BatchSchedulerDeps): BatchScheduler {
  const pollRetries = new Map<string, PollRetry>();
  const pollInFlight = new Set<string>();
  const pendingLocalResults = new Map<string, PendingLocalResult>();
  const pendingSettlements = new Map<string, PendingSettlement>();
  const remoteInFlight = new Set<Promise<void>>();
  const trackRemote = (run: () => Promise<void>): void => {
    let tracked: Promise<void>;
    tracked = Promise.resolve()
      .then(run)
      .catch(() => undefined)
      .finally(() => {
        remoteInFlight.delete(tracked);
      });
    remoteInFlight.add(tracked);
  };
  const shutdown = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let tickInFlight: Promise<void> | undefined;
  let tickAgain = false;
  let started = false;
  let stopping = false;

  const appendFailure = (job: BatchJob, item: BatchItem, code: string): void => {
    const current = deps.ledger.items(job.id).find((entry) => entry.id === item.id) ?? item;
    if (!deps.results.hasRow(job.id, item.id)) {
      deps.results.append(job.id, {
        id: item.id,
        custom_id: item.customId,
        response: null,
        error: { code, message: code },
      });
    }
    if (batchItemStatusIsTerminal(current.status)) return;
    try {
      deps.ledger.completeItem(item.id, {
        status: "failed",
        errorCode: code,
        requestId: null,
        deploymentId: null,
      });
    } catch {
      const latest = deps.ledger.items(job.id).find((entry) => entry.id === item.id);
      if (latest === undefined || !batchItemStatusIsTerminal(latest.status))
        throw new Error("batch failure terminalization did not persist");
    }
  };

  const appendCancelled = (job: BatchJob, item: BatchItem, code = "batch_cancelled"): void => {
    const current = deps.ledger.items(job.id).find((entry) => entry.id === item.id) ?? item;
    if (!deps.results.hasRow(job.id, item.id)) {
      deps.results.append(job.id, {
        id: item.id,
        custom_id: item.customId,
        response: null,
        error: { code, message: code },
      });
    }
    if (batchItemStatusIsTerminal(current.status)) return;
    try {
      deps.ledger.completeItem(item.id, {
        status: "cancelled",
        errorCode: code,
        requestId: null,
        deploymentId: null,
      });
    } catch {
      const latest = deps.ledger.items(job.id).find((entry) => entry.id === item.id);
      if (latest === undefined || !batchItemStatusIsTerminal(latest.status))
        throw new Error("batch cancellation terminalization did not persist");
    }
  };

  const safeFinalizeDeferred = async (
    job: BatchJob,
    item: BatchItem,
    outcome: FinalizeOutcome,
  ): Promise<boolean> => {
    const requestId = item.requestId;
    if (requestId === null) return true;
    try {
      await deps.keys.finalizeDeferred(job.keyId, requestId, outcome);
      return true;
    } catch {
      // Do not complete/harvest an item whose request accounting did not land. The next tick
      // retries the same request id; no new admission is ever created for remote completion.
      return false;
    }
  };
  const finalizeRemoteAccounting = async (
    job: BatchJob,
    item: BatchItem,
    outcome: FinalizeOutcome,
  ): Promise<boolean> => {
    if (item.status === "interrupted") {
      try {
        await deps.keys.finalizeInterrupted(job.keyId, item.id);
        return true;
      } catch {
        return false;
      }
    }
    return safeFinalizeDeferred(job, item, outcome);
  };

  const retrySettlement = async (pending: PendingSettlement): Promise<void> => {
    if (!pending.finalized && pending.finalize !== undefined) {
      try {
        await pending.finalize();
        pending.finalized = true;
      } catch {
        return;
      }
    }
    const current =
      deps.ledger.items(pending.job.id).find((entry) => entry.id === pending.item.id) ??
      pending.item;
    try {
      if (pending.action === "requeue") {
        const latest = deps.ledger.job(pending.job.id);
        if (latest !== undefined && dispatchable(latest.status)) {
          try {
            deps.ledger.requeue(current.id);
            pendingSettlements.delete(current.id);
            return;
          } catch {
            // If cancellation or expiry won after accounting, persist an item result below.
          }
        }
        if (latest?.status === "cancelling") appendCancelled(latest, current);
        else appendFailure(latest ?? pending.job, current, pending.code);
      } else if (pending.action === "cancelled") {
        appendCancelled(pending.job, current, pending.code);
      } else {
        appendFailure(pending.job, current, pending.code);
      }
      pendingSettlements.delete(current.id);
    } catch {
      // Keep both the response/accounting action and item identity for the next tick.
    }
  };

  const settleAfterFinalize = async (
    job: BatchJob,
    item: BatchItem,
    code: string,
    action: PendingSettlement["action"],
    finalize?: () => Promise<void>,
  ): Promise<void> => {
    const pending: PendingSettlement = {
      job,
      item,
      code,
      action,
      ...(finalize === undefined ? {} : { finalize }),
      finalized: finalize === undefined,
    };
    pendingSettlements.set(item.id, pending);
    await retrySettlement(pending);
  };

  const retryPendingSettlements = async (): Promise<void> => {
    for (const pending of pendingSettlements.values()) await retrySettlement(pending);
  };

  const finalizeInterrupted = async (
    job: BatchJob,
    item: BatchItem,
    resultCode = "batch_interrupted",
  ): Promise<boolean> => {
    try {
      await deps.keys.finalizeInterrupted(job.keyId, item.id);
      const current = deps.ledger.items(job.id).find((entry) => entry.id === item.id) ?? item;
      appendFailure(job, current, resultCode);
      return true;
    } catch {
      return false;
    }
  };

  const persistLocalResult = async (pending: PendingLocalResult): Promise<boolean> => {
    if (!pending.accounted) {
      try {
        await deps.keys.finalize(pending.admission, pending.outcome);
        pending.accounted = true;
      } catch {
        return false;
      }
    }
    try {
      deps.results.append(pending.job.id, {
        id: pending.item.id,
        custom_id: pending.item.customId,
        response: {
          status_code: 200,
          request_id: pending.admission.requestId,
          body: pending.result.body,
        },
        error: null,
      });
    } catch {
      return false;
    }
    try {
      deps.ledger.completeItem(pending.item.id, {
        status: "completed",
        requestId: pending.admission.requestId,
        deploymentId: pending.result.deploymentId,
      });
    } catch {
      const current = deps.ledger.items(pending.job.id).find((item) => item.id === pending.item.id);
      if (current?.status !== "completed") return false;
    }
    pendingLocalResults.delete(pending.item.id);
    return true;
  };

  const finalizeJob = (jobId: string): void => {
    const job = deps.ledger.job(jobId);
    if (job === undefined || batchStatusIsTerminal(job.status)) return;
    const items = deps.ledger.items(jobId);
    const active = items.some((item) => !batchItemStatusIsTerminal(item.status));
    if (active) {
      if (job.status === "validating") deps.ledger.setJobStatus(jobId, "queued");
      else if (job.status === "queued") deps.ledger.setJobStatus(jobId, "in_progress");
      return;
    }
    // Unknown submissions are terminally inspectable: their intent remains durable, but no
    // provider id exists to recover. Confirmed groups must still be harvested before closure.
    const remotes = deps.ledger.remotes(jobId);
    const remoteSafe = remotes.every(
      (remote) =>
        remote.intent === "abandoned" ||
        remote.intent === "unknown" ||
        (remote.intent === "confirmed" && remote.harvestedAt !== null),
    );
    if (!remoteSafe) return;
    try {
      const total = deps.ledger.remoteUsageTotal(jobId);
      deps.ledger.recordJobUsage(jobId, total ?? null);
    } catch {
      return;
    }
    const now = deps.now();
    if (job.status === "cancelling") {
      try {
        deps.ledger.setJobStatus(jobId, "cancelled", now);
      } catch {
        // A concurrent result application will kick the scheduler again.
      }
      return;
    }
    try {
      deps.ledger.setJobStatus(jobId, "finalizing");
      const counts = deps.ledger.counts(jobId);
      if (counts.completed > 0) deps.ledger.setJobStatus(jobId, "completed", now);
      else deps.ledger.setJobStatus(jobId, "failed", now, "all_items_failed");
    } catch {
      // Keep the durable non-terminal job for the next reconciliation sweep.
    }
  };

  const persistGroupFacts = (job: BatchJob, facts: readonly BatchSpillGroup[]): void => {
    let unknown = false;
    const seen = new Set<string>();
    for (const fact of facts) {
      if (seen.has(fact.remoteBatchId))
        throw new BatchProtocolError({
          message: "duplicate remote group fact",
          reason: "duplicate_remote_id",
        });
      seen.add(fact.remoteBatchId);
      const remote = deps.ledger
        .remotes(job.id)
        .find(
          (candidate) =>
            candidate.intent === "confirmed" && candidate.remoteBatchId === fact.remoteBatchId,
        );
      if (remote === undefined) {
        throw new BatchProtocolError({
          message: "result fact has no proven remote id",
          reason: "unknown_remote_id",
        });
      }
      const assigned = deps.ledger.itemsForRemote(remote.id).map((item) => item.id);
      if (!setEquals(assigned, fact.itemIds)) {
        throw new BatchProtocolError({
          message: "result fact item assignment differs from durable group",
          reason: "group_assignment_mismatch",
        });
      }
      if (fact.usage === null) unknown = true;
      else deps.ledger.recordRemoteUsage(remote.id, fact.usage);
    }
    const total = deps.ledger.remoteUsageTotal(job.id);
    if (unknown || total === undefined) deps.ledger.recordJobUsage(job.id, null);
    else deps.ledger.recordJobUsage(job.id, total);
  };

  const itemResultRow = (
    item: BatchItem,
    row: BatchResultRow | undefined,
  ): { row: BatchResultRow; success: boolean; outcome: FinalizeOutcome } => {
    const actual = row ?? {
      id: item.id,
      custom_id: item.customId,
      response: null,
      error: { code: "missing_result_row", message: "provider omitted this item" },
    };
    const success = responseSucceeded(actual);
    const status = actual.response?.status_code;
    const tokens = success
      ? rowUsageTokens(actual.response?.body)
      : { prompt: null, completion: null };
    return {
      row: actual,
      success,
      outcome: {
        status: success ? "success" : "error",
        errorCode: success ? null : rowErrorCode(actual.error, status),
        promptTokens: tokens.prompt,
        completionTokens: tokens.completion,
        estimatedCostUsd: null,
        providerReportedUsd: null,
        deploymentId: null,
      },
    };
  };

  const applyGroupResult = async (
    job: BatchJob,
    assignedItems: readonly BatchItem[],
    result: BatchSpillResult,
    remote: BatchRemote,
  ): Promise<void> => {
    const rows = new Map<string, BatchResultRow>();
    for (const row of result.rows) {
      if (rows.has(row.id)) {
        throw new BatchProtocolError({
          message: "duplicate result row",
          reason: "duplicate_custom_id",
        });
      }
      rows.set(row.id, row);
    }
    const assigned = new Map(assignedItems.map((item) => [item.id, item]));
    for (const row of result.rows) {
      if (!assigned.has(row.id)) {
        throw new BatchProtocolError({
          message: "result row belongs to no assigned item",
          reason: "foreign_custom_id",
        });
      }
    }
    for (const original of assignedItems) {
      const current = deps.ledger.items(job.id).find((item) => item.id === original.id) ?? original;
      if (batchItemStatusIsTerminal(current.status)) continue;
      const outcome = itemResultRow(current, rows.get(current.id));
      if (current.requestId === null && current.status !== "interrupted") {
        throw new Error("remote item has no attached request");
      }
      if (!(await finalizeRemoteAccounting(job, current, outcome.outcome))) {
        throw new Error("deferred request accounting unavailable");
      }
      deps.results.append(job.id, outcome.row);
      try {
        deps.ledger.completeItem(current.id, {
          status: outcome.success ? "completed" : "failed",
          errorCode: outcome.success ? null : (outcome.outcome.errorCode ?? "batch_error"),
          requestId: current.requestId,
          deploymentId: current.deploymentId,
        });
      } catch {
        const latest = deps.ledger.items(job.id).find((item) => item.id === current.id);
        if (latest === undefined || !batchItemStatusIsTerminal(latest.status))
          throw new Error("batch result terminalization did not persist");
      }
    }
    const fact = result.groups.find((entry) => entry.remoteBatchId === remote.remoteBatchId);
    if (fact === undefined)
      throw new BatchProtocolError({
        message: "missing result group fact",
        reason: "missing_group_fact",
      });
    persistGroupFacts(job, [fact]);
    deps.ledger.markRemoteHarvested(remote.id);
  };

  const remotesForItems = (
    jobId: string,
    items: readonly BatchItem[],
    remotes = deps.ledger.remotes(jobId),
  ): Map<string, BatchRemote> => {
    const wanted = new Set(items.map((item) => item.id));
    const out = new Map<string, BatchRemote>();
    for (const remote of remotes) {
      for (const item of deps.ledger.itemsForRemote(remote.id)) {
        if (wanted.has(item.id)) out.set(item.id, remote);
      }
    }
    return out;
  };

  const finishUnassigned = async (
    job: BatchJob,
    items: readonly BatchItem[],
    code: string,
    retry: boolean,
  ): Promise<void> => {
    for (const item of items) {
      const current = deps.ledger.items(job.id).find((entry) => entry.id === item.id) ?? item;
      if (batchItemStatusIsTerminal(current.status)) continue;
      const refreshed = deps.ledger.job(job.id);
      const shouldRetry = retry && refreshed !== undefined && dispatchable(refreshed.status);
      const cancelling = refreshed?.status === "cancelling";
      const settlementCode = cancelling ? "batch_cancelled" : code;
      const action: PendingSettlement["action"] = shouldRetry
        ? "requeue"
        : cancelling
          ? "cancelled"
          : "failed";
      const outcome: FinalizeOutcome = {
        status: shouldRetry || cancelling ? "abandoned" : "error",
        errorCode: settlementCode,
        deploymentId: null,
      };
      const finalize =
        current.requestId === null
          ? undefined
          : () => deps.keys.finalizeDeferred(job.keyId, current.requestId!, outcome);
      await settleAfterFinalize(job, current, settlementCode, action, finalize);
    }
    finalizeJob(job.id);
  };

  const terminalizeProtocolGroup = async (
    job: BatchJob,
    items: readonly BatchItem[],
    remote: BatchRemote,
    error: BatchProtocolError,
  ): Promise<boolean> => {
    const code = `protocol_${error.reason}`;
    for (const item of items) {
      const current = deps.ledger.items(job.id).find((entry) => entry.id === item.id) ?? item;
      if (batchItemStatusIsTerminal(current.status)) continue;
      const outcome: FinalizeOutcome = { status: "error", errorCode: code, deploymentId: null };
      const finalize =
        current.status === "interrupted"
          ? () => deps.keys.finalizeInterrupted(job.keyId, current.id)
          : current.requestId === null
            ? undefined
            : () => deps.keys.finalizeDeferred(job.keyId, current.requestId!, outcome);
      await settleAfterFinalize(job, current, code, "failed", finalize);
    }
    const settled = items.every((item) => {
      const current = deps.ledger.items(job.id).find((entry) => entry.id === item.id);
      return current !== undefined && batchItemStatusIsTerminal(current.status);
    });
    if (settled) {
      deps.ledger.recordJobUsage(job.id, null);
      if (remote.intent === "confirmed" && remote.harvestedAt === null) {
        deps.ledger.markRemoteHarvested(remote.id);
      }
    }
    return settled;
  };

  const settleSpillFailure = async (
    job: BatchJob,
    items: readonly BatchItem[],
    error: unknown,
    phase: "submit" | "poll",
    remote?: BatchRemote,
  ): Promise<void> => {
    const assigned = remotesForItems(job.id, items);
    if (phase === "poll" && error instanceof BatchProtocolError && remote !== undefined) {
      if (await terminalizeProtocolGroup(job, items, remote, error)) pollRetries.delete(remote.id);
      else pollRetries.set(remote.id, { jobId: job.id, remoteId: remote.id });
      finalizeJob(job.id);
      return;
    }
    if (phase === "poll" && error instanceof BatchSpillAborted) return;

    const code =
      error instanceof BatchSubmitRejected
        ? `http_${error.status}`
        : error instanceof BatchSubmitUnknown
          ? "batch_submit_unknown"
          : error instanceof BatchSpillAborted
            ? "batch_spill_aborted"
            : errorCodeOf(error);
    for (const item of items) {
      const current = deps.ledger.items(job.id).find((entry) => entry.id === item.id) ?? item;
      const itemRemote = assigned.get(current.id);
      if (itemRemote?.intent === "confirmed") {
        if (itemRemote.harvestedAt === null) {
          pollRetries.set(itemRemote.id, { jobId: job.id, remoteId: itemRemote.id });
        }
        continue;
      }
      if (itemRemote?.intent === "intended") {
        try {
          deps.ledger.markRemoteUnknown(itemRemote.id);
        } catch {
          // A confirm/harvest won the race; the confirmed poll is authoritative.
        }
        continue;
      }
      if (itemRemote?.intent === "unknown") continue;

      const retrySafe =
        error instanceof BatchSubmitRejected
          ? error.status === 429
          : error instanceof BatchSpillAborted || itemRemote?.intent === "abandoned";
      await finishUnassigned(job, [current], code, retrySafe);
    }
    await reconcileInterrupted();

    // A confirmed sibling may not be discoverable through the submitted items after another
    // group was abandoned. Keep every pending durable confirmation scheduled independently.
    const scheduled = new Set<string>();
    for (const candidate of assigned.values()) {
      if (
        candidate.intent !== "confirmed" ||
        candidate.harvestedAt !== null ||
        scheduled.has(candidate.id)
      )
        continue;
      scheduled.add(candidate.id);
      pollRetries.set(candidate.id, { jobId: job.id, remoteId: candidate.id });
    }
    finalizeJob(job.id);
  };

  const buildWork = (
    job: BatchJob,
    item: BatchItem,
    admission: Admission,
    raw: Readonly<Record<string, unknown>>,
  ): BatchRoutedWork => {
    if (raw.stream === true)
      throw Object.assign(new Error("streaming is not supported for batch"), {
        _tag: "stream_not_supported",
      });
    // The public batch body may carry the batch deployment id; the chat decoder intentionally
    // accepts only auto, so normalize only this private boundary and carry the requested model
    // explicitly on BatchRoutedWork.
    const record: Record<string, unknown> = { ...raw, model: "auto", stream: false };
    const decoded = decodeChatCompletion(record, { newId: randomUUID });
    const capabilities = requestCapabilities(decoded);
    const inputTokens = estimateInputTokens(decoded);
    if (admission.policy.allowedModels !== null && admission.policy.allowedModels.length === 0) {
      throw Object.assign(new Error("no deployments are allowed"), { _tag: "EmptyAllowlist" });
    }
    if (
      inputTokens > admission.policy.contextLimitTokens ||
      (decoded.maxCompletionTokens !== undefined &&
        decoded.maxCompletionTokens > admission.policy.maxCompletionTokens)
    ) {
      throw Object.assign(new Error("request exceeds configured limits"), {
        _tag: "ImpossibleLimits",
      });
    }
    return {
      requestId: admission.requestId,
      keyId: admission.keyId,
      policy: admission.policy,
      keyPolicyVersion: admission.version,
      messages: decoded.messages,
      tools: decoded.tools,
      parallelToolCalls: decoded.parallelToolCalls,
      toolChoice: decoded.tool_choice,
      responseFormat: decoded.response_format,
      sampling: decoded.sampling,
      maxCompletionTokens: decoded.maxCompletionTokens,
      inputTokens,
      // Every batch item is an isolated new task. A caller's session id cannot pin unrelated
      // batch rows together, and private ids never collide with an interactive session.
      routing: { sessionId: `batch:${job.id}:${item.id}`, boundary: "new-task" },
      capabilities,
      classifierInput: classifierInputFor(decoded, capabilities, inputTokens),
      freshFactsAvailable: false,
      stream: false,
      requestedModel: job.model,
    };
  };

  const readInput = (
    job: BatchJob,
    item: BatchItem,
  ): Readonly<Record<string, unknown>> | undefined => {
    const body = deps.results.readInput(job.id, job.keyId, item.id);
    if (body === undefined || typeof body !== "object" || body === null || Array.isArray(body))
      return undefined;
    return body;
  };

  const runLocalItem = async (job: BatchJob, item: BatchItem): Promise<void> => {
    let raw: Readonly<Record<string, unknown>> | undefined;
    try {
      raw = readInput(job, item);
    } catch {
      raw = undefined;
    }
    if (raw === undefined) {
      await settleAfterFinalize(job, item, "batch_payload_unavailable", "failed");
      return;
    }
    let admission: Admission | undefined;
    try {
      admission = await deps.keys.admitByKeyId(job.keyId);
      await deps.keys.attach(admission, item.id);
    } catch (error) {
      const code = errorCodeOf(error);
      const latest = deps.ledger.job(job.id);
      const retryable =
        RETRY_CODES.has(code) && latest !== undefined && dispatchable(latest.status);
      const outcome: FinalizeOutcome = {
        status: retryable ? "abandoned" : "error",
        errorCode: code,
      };
      await settleAfterFinalize(
        job,
        item,
        code,
        retryable ? "requeue" : latest?.status === "cancelling" ? "cancelled" : "failed",
        admission === undefined ? undefined : () => deps.keys.finalize(admission!, outcome),
      );
      return;
    }
    const activeAdmission = admission;
    if (activeAdmission === undefined) return;
    let work: BatchRoutedWork;
    try {
      work = buildWork(job, item, activeAdmission, raw);
    } catch (error) {
      const code = errorCodeOf(error);
      const outcome: FinalizeOutcome = { status: "error", errorCode: code };
      await settleAfterFinalize(job, item, code, "failed", () =>
        deps.keys.finalize(activeAdmission, outcome),
      );
      return;
    }
    const deadline = createDeadline(GATEWAY_EFFECT_TIMEOUT_MS);
    const signal = deadline.signal;
    try {
      const result = await deps.inference.complete(work, signal);
      const metadata = result.metadata();
      const outcome: FinalizeOutcome = {
        ...metadata,
        deploymentId: result.deploymentId ?? metadata.deploymentId ?? null,
        status: "success",
      };
      const pending: PendingLocalResult = {
        job,
        item,
        admission: activeAdmission,
        result,
        outcome,
        accounted: false,
      };
      pendingLocalResults.set(item.id, pending);
      await persistLocalResult(pending);
    } catch (error) {
      const code = errorCodeOf(error);
      const latest = deps.ledger.job(job.id);
      const retryable =
        !signal.aborted &&
        RETRY_CODES.has(code) &&
        latest !== undefined &&
        dispatchable(latest.status);
      const spillable = LOCAL_SPILL_CODES.has(code) && deps.spill !== undefined;
      if (spillable) {
        trackRemote(() => runRemoteGroup(job, [item], new Map([[item.id, activeAdmission]])));
        return;
      }
      const outcome: FinalizeOutcome = {
        status: signal.aborted || retryable || LOCAL_SPILL_CODES.has(code) ? "abandoned" : "error",
        errorCode: code,
      };
      const settlementCode = LOCAL_SPILL_CODES.has(code) ? "no_eligible_model" : code;
      await settleAfterFinalize(
        job,
        item,
        settlementCode,
        retryable ? "requeue" : latest?.status === "cancelling" ? "cancelled" : "failed",
        () => deps.keys.finalize(activeAdmission, outcome),
      );
    } finally {
      deadline.clear();
    }
  };

  const toRecoveryItems = (
    job: BatchJob,
    items: readonly BatchItem[],
  ): BatchSpillItem[] | undefined => {
    const out: BatchSpillItem[] = [];
    try {
      for (const item of items) {
        const body = readInput(job, item);
        if (body === undefined || item.deploymentId === null) return undefined;
        const deployment = deps.batchCatalogue.find(
          (candidate) => candidate.id === item.deploymentId,
        );
        if (deployment === undefined) return undefined;
        out.push({
          id: item.id,
          customId: item.customId,
          deploymentId: deployment.id,
          model: deployment.modelId,
          body,
          jobId: job.id,
        });
      }
    } catch {
      return undefined;
    }
    return out;
  };

  const failUnavailableRecovery = async (
    job: BatchJob,
    items: readonly BatchItem[],
    remote: BatchRemote,
  ): Promise<void> => {
    const code = "batch_recovery_unavailable";
    for (const item of items) {
      const current = deps.ledger.items(job.id).find((entry) => entry.id === item.id) ?? item;
      if (batchItemStatusIsTerminal(current.status)) continue;
      const outcome: FinalizeOutcome = { status: "error", errorCode: code, deploymentId: null };
      const finalize =
        current.status === "interrupted"
          ? () => deps.keys.finalizeInterrupted(job.keyId, current.id)
          : current.requestId === null
            ? undefined
            : () => deps.keys.finalizeDeferred(job.keyId, current.requestId!, outcome);
      await settleAfterFinalize(job, current, code, "failed", finalize);
    }
    const settled = items.every((item) => {
      const current = deps.ledger.items(job.id).find((entry) => entry.id === item.id);
      return current !== undefined && batchItemStatusIsTerminal(current.status);
    });
    if (!settled) return;
    deps.ledger.recordJobUsage(job.id, null);
    if (remote.intent === "confirmed" && remote.harvestedAt === null) {
      deps.ledger.markRemoteHarvested(remote.id);
    }
    pollRetries.delete(remote.id);
    finalizeJob(job.id);
  };

  const runPollRetry = async (retry: PollRetry): Promise<void> => {
    const spill = deps.spill;
    if (spill?.pollKnown === undefined || pollInFlight.has(retry.remoteId)) return;
    const job = deps.ledger.job(retry.jobId);
    const remote =
      job === undefined
        ? undefined
        : deps.ledger.remotes(job.id).find((entry) => entry.id === retry.remoteId);
    if (
      job === undefined ||
      remote === undefined ||
      remote.remoteBatchId === null ||
      remote.harvestedAt !== null
    ) {
      pollRetries.delete(retry.remoteId);
      return;
    }
    const allItems = deps.ledger.itemsForRemote(remote.id);
    if (allItems.length === 0) {
      deps.ledger.recordJobUsage(job.id, null);
      deps.ledger.markRemoteHarvested(remote.id);
      pollRetries.delete(remote.id);
      finalizeJob(job.id);
      return;
    }
    // A confirmed id remains authoritative when the batch catalogue is temporarily absent.
    // Keep it pending rather than fabricating a failed result and a harvested remote.
    if (allItems.some((item) => !deps.batchCatalogue.some((d) => d.id === item.deploymentId))) {
      return;
    }
    pollInFlight.add(remote.id);
    try {
      const spillItems = toRecoveryItems(job, allItems);
      if (spillItems === undefined || spillItems.length !== allItems.length) {
        await failUnavailableRecovery(job, allItems, remote);
        return;
      }
      const result = await spill.pollKnown(
        remote.remoteBatchId,
        spillItems,
        Math.max(
          job.spillAt + job.completionWindowMs,
          (remote.confirmedAt ?? remote.createdAt) + job.completionWindowMs + REMOTE_POLL_GRACE_MS,
        ),
        shutdown.signal,
      );
      await applyGroupResult(job, allItems, result, remote);
      pollRetries.delete(remote.id);
      deps.ledger.expire(deps.now());
      finalizeJob(job.id);
    } catch (error) {
      await settleSpillFailure(job, allItems, error, "poll", remote);
      deps.ledger.expire(deps.now());
      finalizeJob(job.id);
    } finally {
      pollInFlight.delete(remote.id);
    }
  };

  const runRemoteGroup = async (
    job: BatchJob,
    items: readonly BatchItem[],
    priorAdmissions?: ReadonlyMap<string, Admission>,
  ): Promise<void> => {
    try {
      if (stopping) {
        for (const item of items) {
          const admission = priorAdmissions?.get(item.id);
          if (admission !== undefined) {
            const outcome: FinalizeOutcome = {
              status: "abandoned",
              errorCode: "batch_spill_aborted",
            };
            await settleAfterFinalize(job, item, "batch_spill_aborted", "requeue", () =>
              deps.keys.finalize(admission, outcome),
            );
          } else {
            try {
              deps.ledger.requeue(item.id);
            } catch {
              appendFailure(job, item, "batch_spill_aborted");
            }
          }
        }
        return;
      }
      const port = deps.spill;
      if (port === undefined) {
        await finishUnassigned(job, items, "no_eligible_model", false);
        return;
      }
      const prepared: PreparedRemote[] = [];
      for (const item of items) {
        let raw: Readonly<Record<string, unknown>> | undefined;
        try {
          raw = readInput(job, item);
        } catch {
          raw = undefined;
        }
        const priorAdmission = priorAdmissions?.get(item.id);
        if (raw === undefined) {
          const outcome: FinalizeOutcome = {
            status: "error",
            errorCode: "batch_payload_unavailable",
          };
          await settleAfterFinalize(
            job,
            item,
            "batch_payload_unavailable",
            "failed",
            priorAdmission === undefined
              ? undefined
              : () => deps.keys.finalize(priorAdmission, outcome),
          );
          continue;
        }
        let admission = priorAdmission;
        let deferSucceeded = false;
        try {
          if (admission === undefined) {
            admission = await deps.keys.admitByKeyId(job.keyId);
            await deps.keys.attach(admission, item.id);
          }
          const work = buildWork(job, item, admission, raw);
          const planned = await deps.inference.prepareSpill(
            work,
            deps.batchCatalogue,
            shutdown.signal,
          );
          if (
            planned.deployment.id.length === 0 ||
            !deps.batchCatalogue.some((d) => d.id === planned.deployment.id)
          ) {
            throw Object.assign(new Error("batch deployment is not in the batch catalogue"), {
              _tag: "NoEligibleModel",
            });
          }
          const metadata = { ...planned.metadata, deploymentId: planned.deployment.id };
          await deps.keys.defer(admission, item.id, metadata, job.spillAt + job.completionWindowMs);
          deferSucceeded = true;
          prepared.push({ job, item, admission, work, prepared: { ...planned, metadata } });
        } catch (error) {
          const code = errorCodeOf(error);
          const resultCode = code === "NoEligibleModel" ? "no_eligible_model" : code;
          // Nothing has reached the provider yet. Temporary admission/capacity denials
          // give up the claim so a later tick can try after the key becomes available.
          const latest = deps.ledger.job(job.id);
          const retryable =
            RETRY_CODES.has(code) && latest !== undefined && dispatchable(latest.status);
          if (admission === undefined) {
            await settleAfterFinalize(job, item, resultCode, retryable ? "requeue" : "failed");
            continue;
          }
          const outcome: FinalizeOutcome = {
            status: retryable ? "abandoned" : "error",
            errorCode: code,
            deploymentId: null,
          };
          const finalize = deferSucceeded
            ? () => deps.keys.finalizeDeferred(job.keyId, admission!.requestId, outcome)
            : () => deps.keys.finalize(admission!, outcome);
          await settleAfterFinalize(
            job,
            item,
            resultCode,
            retryable ? "requeue" : "failed",
            finalize,
          );
        }
      }
      if (prepared.length === 0) return;

      const byDeployment = new Map<string, PreparedRemote[]>();
      for (const entry of prepared) {
        const existing = byDeployment.get(entry.prepared.deployment.id);
        if (existing === undefined) byDeployment.set(entry.prepared.deployment.id, [entry]);
        else existing.push(entry);
      }
      for (const group of byDeployment.values()) {
        if (stopping) {
          await finishUnassigned(
            job,
            group.map((entry) => entry.item),
            "batch_spill_aborted",
            true,
          );
          continue;
        }
        const latest = deps.ledger.job(job.id);
        if (latest === undefined || !dispatchable(latest.status)) {
          await finishUnassigned(
            job,
            group.map((entry) => entry.item),
            "batch_cancelled",
            false,
          );
          continue;
        }
        const eligible: PreparedRemote[] = [];
        for (const entry of group) {
          try {
            await deps.keys.recheckDeferred(entry.admission);
            eligible.push(entry);
          } catch (error) {
            const current =
              deps.ledger.items(job.id).find((item) => item.id === entry.item.id) ?? entry.item;
            const code = errorCodeOf(error);
            const outcome: FinalizeOutcome = {
              status: "error",
              errorCode: code,
              deploymentId: null,
            };
            await settleAfterFinalize(job, current, code, "failed", () =>
              deps.keys.finalizeDeferred(job.keyId, entry.admission.requestId, outcome),
            );
          }
        }
        if (eligible.length === 0) continue;

        const spillItems: BatchSpillItem[] = eligible.map((entry) => ({
          id: entry.item.id,
          customId: entry.item.customId,
          deploymentId: entry.prepared.deployment.id,
          model: entry.prepared.deployment.modelId,
          body: entry.prepared.body,
          jobId: job.id,
        }));
        try {
          const result = await port.spill(spillItems, shutdown.signal);
          const submittedIds = new Set(spillItems.map((item) => item.id));
          const factItems = new Set<string>();
          const resultRows = new Map<string, BatchResultRow>();
          const remotes = deps.ledger.remotes(job.id);
          const remoteByItem = remotesForItems(
            job.id,
            eligible.map((entry) => entry.item),
            remotes,
          );
          const facts: {
            fact: BatchSpillGroup;
            remote: BatchRemote;
            items: readonly BatchItem[];
          }[] = [];
          for (const row of result.rows) {
            if (!submittedIds.has(row.id) || resultRows.has(row.id)) {
              throw new BatchProtocolError({
                message: "spill returned a duplicate or foreign result row",
                reason: "foreign_custom_id",
              });
            }
            resultRows.set(row.id, row);
          }
          const seenRemoteIds = new Set<string>();
          for (const fact of result.groups) {
            if (seenRemoteIds.has(fact.remoteBatchId)) {
              throw new BatchProtocolError({
                message: "duplicate remote group fact",
                reason: "duplicate_remote_id",
              });
            }
            seenRemoteIds.add(fact.remoteBatchId);
            const remote = remotes.find(
              (candidate) =>
                candidate.intent === "confirmed" && candidate.remoteBatchId === fact.remoteBatchId,
            );
            if (remote === undefined) {
              throw new BatchProtocolError({
                message: "spill returned an unproven remote id",
                reason: "unknown_remote_id",
              });
            }
            const assigned = deps.ledger.itemsForRemote(remote.id);
            const assignedIds = assigned.map((item) => item.id);
            if (
              !setEquals(assignedIds, fact.itemIds) ||
              fact.itemIds.some((id) => !submittedIds.has(id) || factItems.has(id))
            ) {
              throw new BatchProtocolError({
                message: "spill returned a mismatched remote assignment",
                reason: "group_assignment_mismatch",
              });
            }
            for (const id of fact.itemIds) factItems.add(id);
            facts.push({ fact, remote, items: assigned });
          }
          for (const row of result.rows) {
            if (factItems.has(row.id)) continue;
            if (row.response !== null) {
              throw new BatchProtocolError({
                message: "successful result has no confirmed group fact",
                reason: "missing_group_fact",
              });
            }
          }
          for (const entry of facts) {
            const ids = new Set(entry.fact.itemIds);
            await applyGroupResult(
              job,
              entry.items,
              {
                rows: result.rows.filter((row) => ids.has(row.id)),
                usage: entry.fact.usage,
                groups: [entry.fact],
              },
              entry.remote,
            );
          }
          for (const entry of eligible) {
            if (factItems.has(entry.item.id)) continue;
            const current =
              deps.ledger.items(job.id).find((item) => item.id === entry.item.id) ?? entry.item;
            const remote = remoteByItem.get(current.id);
            if (remote?.intent === "confirmed" && remote.harvestedAt === null) {
              pollRetries.set(remote.id, { jobId: job.id, remoteId: remote.id });
              continue;
            }
            if (remote?.intent === "intended" || remote?.intent === "unknown") {
              await settleSpillFailure(
                job,
                [current],
                new BatchSubmitUnknown({
                  message: "remote submission result is unresolved",
                  key: remote.submitToken,
                }),
                "submit",
              );
              continue;
            }
            const row = resultRows.get(entry.item.id);
            const code = row === undefined ? "batch_error" : rowErrorCode(row.error);
            await finishUnassigned(job, [entry.item], code, false);
          }
        } catch (error) {
          await settleSpillFailure(
            job,
            eligible.map((entry) => entry.item),
            error,
            "submit",
          );
        }
      }
    } finally {
      deps.ledger.expire(deps.now());
      finalizeJob(job.id);
    }
  };

  const reconcileInterrupted = async (): Promise<boolean> => {
    let complete = true;
    for (const job of deps.ledger.activeJobs()) {
      const items = deps.ledger.items(job.id);
      const assigned = remotesForItems(job.id, items);
      for (const item of items) {
        if (item.status !== "interrupted") continue;
        const remote = assigned.get(item.id);
        if (remote?.intent === "confirmed" && remote.harvestedAt === null) {
          pollRetries.set(remote.id, { jobId: job.id, remoteId: remote.id });
          continue;
        }
        if (remote?.intent === "intended") {
          try {
            deps.ledger.markRemoteUnknown(remote.id);
          } catch {
            // A concurrent confirm/harvest wins; inspect its durable state below.
          }
        }
        const latestRemote =
          remote === undefined
            ? undefined
            : deps.ledger.remotes(job.id).find((entry) => entry.id === remote.id);
        if (latestRemote?.intent === "confirmed" && latestRemote.harvestedAt === null) {
          pollRetries.set(latestRemote.id, { jobId: job.id, remoteId: latestRemote.id });
          continue;
        }
        const resultCode =
          latestRemote?.intent === "unknown" ? "batch_submit_unknown" : "batch_interrupted";
        if (!(await finalizeInterrupted(job, item, resultCode))) complete = false;
      }
    }
    return complete;
  };

  const reconcileQueuedLinks = async (): Promise<boolean> => {
    let complete = true;
    for (const job of deps.ledger.activeJobs()) {
      const items = deps.ledger.items(job.id);
      const assigned = remotesForItems(job.id, items);
      for (const item of items) {
        if (job.status === "cancelling" && item.status === "running") {
          const remote = assigned.get(item.id);
          if (remote?.intent === "abandoned") {
            const outcome: FinalizeOutcome = {
              status: "abandoned",
              errorCode: "batch_cancelled",
              deploymentId: null,
            };
            const finalize =
              item.requestId === null
                ? undefined
                : () => deps.keys.finalizeDeferred(job.keyId, item.requestId!, outcome);
            await settleAfterFinalize(job, item, "batch_cancelled", "cancelled", finalize);
            if (pendingSettlements.has(item.id)) complete = false;
            continue;
          }
        }
        if (item.status !== "queued" || item.requestId === null) continue;
        try {
          await deps.keys.finalizeDeferred(job.keyId, item.requestId, {
            status: "abandoned",
            errorCode: "batch_retry",
            deploymentId: null,
          });
        } catch {
          complete = false;
          continue;
        }
        const latest = deps.ledger.job(job.id);
        if (latest?.status === "cancelling") {
          appendCancelled(latest, item);
        } else if (latest !== undefined && dispatchable(latest.status)) {
          try {
            deps.ledger.requeue(item.id);
          } catch {
            appendFailure(latest, item, "batch_retry");
          }
        } else if (latest !== undefined && !batchStatusIsTerminal(latest.status)) {
          appendFailure(latest, item, "batch_retry");
        }
      }
    }
    return complete;
  };

  const reconcileJobs = (): void => {
    for (const job of deps.ledger.activeJobs()) finalizeJob(job.id);
  };

  const runPendingLocalPersistence = async (): Promise<void> => {
    for (const pending of [...pendingLocalResults.values()]) await persistLocalResult(pending);
  };

  const runTick = async (): Promise<void> => {
    const now = deps.now();
    await retryPendingSettlements();
    await runPendingLocalPersistence();
    const interruptedReconciled = await reconcileInterrupted();
    const linksReconciled = await reconcileQueuedLinks();
    if (stopping) return;
    const pollKnown = deps.spill?.pollKnown;
    for (const remote of deps.ledger.pendingRemotes()) {
      const job = deps.ledger.job(remote.jobId);
      if (job === undefined) continue;
      if (pollKnown !== undefined) {
        pollRetries.set(remote.id, { jobId: job.id, remoteId: remote.id });
      }
    }
    if (interruptedReconciled && linksReconciled) deps.ledger.expire(deps.now());
    deps.results.sweepExpired(now);
    reconcileJobs();
    if (stopping) return;
    for (const retry of [...pollRetries.values()]) {
      if (!pollInFlight.has(retry.remoteId)) trackRemote(() => runPollRetry(retry));
    }
    if (pendingSettlements.size > 0 || !interruptedReconciled || !linksReconciled) return;
    const idle = deps.inference.interactiveIdle();
    const claimed = idle
      ? deps.ledger.claim(BATCH_DISPATCH_PER_TICK)
      : deps.ledger.claimDue(BATCH_DISPATCH_PER_TICK, now);
    const byJob = new Map<string, BatchItem[]>();
    for (const item of claimed) {
      const group = byJob.get(item.jobId);
      if (group === undefined) byJob.set(item.jobId, [item]);
      else group.push(item);
    }
    for (const [jobId, items] of byJob) {
      if (stopping) {
        for (const item of items) {
          try {
            deps.ledger.requeue(item.id);
          } catch {
            // Shutdown preserves every unstarted claim for the next scheduler process.
          }
        }
        continue;
      }
      const job = deps.ledger.job(jobId);
      if (job === undefined) {
        for (const item of items) {
          try {
            deps.ledger.requeue(item.id);
          } catch {
            // A missing job cannot authorize dispatch of its item input.
          }
        }
        continue;
      }
      if (hasSpilled(job.spillAt, deps.now())) {
        trackRemote(() => runRemoteGroup(job, items));
      } else if (idle) {
        await Promise.allSettled(items.map((item) => runLocalItem(job, item)));
        deps.ledger.expire(deps.now());
        finalizeJob(jobId);
      } else {
        for (const item of items) {
          try {
            deps.ledger.requeue(item.id);
          } catch {
            appendFailure(job, item, "batch_not_due");
          }
        }
      }
    }
  };
  const kick = (): void => {
    if (stopping) return;
    if (tickInFlight !== undefined) {
      tickAgain = true;
      return;
    }
    tickInFlight = runTick()
      .catch((error: unknown) => {
        console.error("batch scheduler tick failed", error);
        try {
          deps.onTickError?.();
        } catch (metricError) {
          console.error("batch scheduler error metric failed", metricError);
        }
      })
      .finally(() => {
        tickInFlight = undefined;
        if (tickAgain && !stopping) {
          tickAgain = false;
          kick();
        }
      });
  };

  const resumeRemotePolling = (): void => {
    if (deps.spill?.pollKnown === undefined) return;
    for (const remote of deps.ledger.pendingRemotes()) {
      const job = deps.ledger.job(remote.jobId);
      if (job === undefined || remote.remoteBatchId === null) continue;
      pollRetries.set(remote.id, { jobId: job.id, remoteId: remote.id });
    }
    if (pollRetries.size > 0) kick();
  };

  return {
    start(): void {
      if (started) return;
      started = true;
      resumeRemotePolling();
      timer = setInterval(kick, deps.intervalMs);
      timer.unref?.();
      kick();
    },
    kick,
    async drain(): Promise<void> {
      stopping = true;
      clearInterval(timer);
      while (tickInFlight !== undefined) await tickInFlight;
      shutdown.abort();
      await Promise.allSettled([...remoteInFlight]);
    },
  };
}
