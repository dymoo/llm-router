import { randomUUID } from "node:crypto";
import { Schema } from "effect";
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  lte,
  not,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { Conflict, DatabaseError, InvalidInput } from "../errors.ts";
import { batchItems, batchJobs, batchRemotes, requests } from "../db/schema.ts";
import type { ControlPlaneDb, ControlPlaneSession } from "../db/sqlite.ts";
import {
  BATCH_MAX_CUSTOM_ID_CHARS,
  BATCH_MAX_INFLIGHT_JOBS_PER_KEY,
  BATCH_MAX_ITEMS_PER_JOB,
  BATCH_TERMINAL_STATUSES,
  BatchUsage,
  batchItemStatusIsTerminal,
  batchStatusIsTerminal,
  type BatchItem,
  type BatchItemDraft,
  type BatchItemStatus,
  type BatchJob,
  type BatchJobDraft,
  type BatchRemote,
  type BatchRemoteIntent,
  type BatchRequestCounts,
  type BatchStatus,
  type BatchUsage as BatchUsageType,
} from "../domain.ts";

const JOB_TERMINAL_STATUSES = BATCH_TERMINAL_STATUSES;
/** The only job states that may dispatch: claim, requeue and new remote work are refused for
 * cancelling/finalizing (never new paid work after DELETE) and for every terminal. */
const JOB_DISPATCHABLE_STATUSES = ["validating", "queued", "in_progress"] as const;
const jobAllowsDispatch = (status: string): boolean =>
  (JOB_DISPATCHABLE_STATUSES as readonly string[]).includes(status);
const ITEM_DISPATCHABLE = ["queued", "running"] as const;
const COMPLETE_ITEM_ALLOWED: Record<BatchItemStatus, boolean> = {
  queued: false,
  running: false,
  completed: true,
  failed: true,
  cancelled: true,
  expired: false,
  interrupted: false,
};
const CREATE_ITEM_ALLOWED: Record<BatchItemStatus, boolean> = {
  queued: true,
  running: false,
  completed: false,
  failed: true,
  cancelled: true,
  expired: true,
  interrupted: false,
};
const INTERRUPTED_ERROR = "batch_interrupted";

/** The job state machine. Self-transitions are always allowed; terminals accept only themselves. */
const JOB_TRANSITIONS: Record<BatchStatus, readonly BatchStatus[]> = {
  validating: [
    "validating",
    "queued",
    "in_progress",
    "finalizing",
    "failed",
    "cancelling",
    "expired",
  ],
  queued: ["queued", "in_progress", "finalizing", "failed", "cancelling", "expired"],
  in_progress: ["in_progress", "finalizing", "failed", "cancelling", "expired"],
  finalizing: ["finalizing", "completed", "failed", "cancelling", "expired"],
  cancelling: ["cancelling", "cancelled", "expired"],
  completed: ["completed"],
  failed: ["failed"],
  expired: ["expired"],
  cancelled: ["cancelled"],
};

const decodeUsage = Schema.decodeUnknownSync(BatchUsage);

export interface BatchLedger {
  create(input: { job: BatchJobDraft; items: readonly BatchItemDraft[] }): {
    job: BatchJob;
    items: readonly BatchItem[];
  };
  job(jobId: string): BatchJob | undefined;
  items(jobId: string): readonly BatchItem[];
  list(keyId: string, page: { limit: number; after?: string }): readonly BatchJob[];
  /** Every NON-terminal job across ALL keys, oldest first — the boot/tick reconciliation
   * sweep that finds all-items-terminal jobs awaiting finalization. Unlike list(), this is
   * deliberately not key-scoped: reconciliation is process-level. */
  activeJobs(): readonly BatchJob[];
  /** Atomic queued→running for DISPATCHABLE jobs only (validating/queued/in_progress) —
   * cancelling/finalizing/terminal jobs never yield new paid work. */
  claim(limit: number): readonly BatchItem[];
  /** Atomic queued→running for dispatchable jobs whose spill deadline has arrived.
   * Eligibility is filtered before the limit, so pre-due items cannot crowd out due work. */
  claimDue(limit: number, spillDueAt: number): readonly BatchItem[];
  completeItem(
    itemId: string,
    outcome: {
      status: BatchItemStatus;
      errorCode?: string | null;
      requestId?: string | null;
      deploymentId?: string | null;
    },
  ): void;
  /** Local running → queued retry only. Refuses remotely assigned items, terminal items and
   * non-dispatchable jobs (cancelling/finalizing/terminal): a possibly-executed request is
   * never blindly replayed and DELETE never re-opens dispatch. After verifying any linked
   * request is terminal (never orphan a running one), the old attempt identity — requestId,
   * deploymentId, errorCode — is cleared so the next attach links fresh; old accounting
   * stays in the requests ledger. */
  requeue(itemId: string): void;
  /** Terminal targets stamp finalizedAt (default now) and refuse live linked requests;
   * finalizing does too. errorCode is stored when provided. `cancelling` cancels undispatched
   * items and lands `cancelled` only when no item or linked request still runs. */
  setJobStatus(
    jobId: string,
    status: BatchStatus,
    finalizedAt?: number | null,
    errorCode?: string | null,
  ): void;
  /** Job-level usage aggregate. null CLEARS a stored aggregate once a fact turns unknown
   * (unknown ≠ partial). */
  recordJobUsage(jobId: string, usage: BatchUsageType | null): void;
  counts(jobId: string): BatchRequestCounts;
  /** Deadline sweep: expires non-terminal jobs whose spillAt + completionWindowMs < before
   * (pass now). Never touches createdAt; queued items become expired. Jobs with running items
   * or linked running requests are skipped until a later sweep. */
  expire(before: number): void;
  /** Durable remote intent: record-if-absent on submitToken. Dispatchable jobs only —
   * cancelling/finalizing never start new remote work. A NEW group persists its exact item
   * assignments in the same transaction — before any POST. A repeat call returns the existing
   * row untouched (identity implies the assignment). */
  beginRemote(
    jobId: string,
    input: {
      groupKey: string;
      submitToken: string;
      itemIds: readonly string[];
      createdAt?: number;
    },
  ): BatchRemote;
  /** Ambiguous POST outcome (possibly executed): intended → unknown, assigned running items
   * become interrupted. Idempotent on unknown; refuses confirmed/abandoned. */
  markRemoteUnknown(remoteId: string): void;
  /** Definite clean rejection (provably never executed): intended → abandoned, assigned items
   * return to queued on dispatchable jobs. On cancelling jobs, linked running requests keep
   * their items running until accounting settles; other assigned items become cancelled.
   * No rejected item is requeued after DELETE. Refuses confirmed/unknown. */
  abandonRemote(remoteId: string): void;
  /** Confirms THE proven provider id for this group (one intent, one id; a compat split is a
   * separate intent). Intended/unknown → confirmed stamps remoteBatchId + confirmedAt; the
   * same id is idempotent; a different id on a confirmed group, an id bound to another group,
   * or an abandoned group are ALL Conflicts — conflicts are never swallowed. */
  confirmRemote(remoteId: string, remoteBatchId: string, confirmedAt?: number): void;
  /** Provider-reported usage for one group, persisted once at terminal harvest: first write
   * wins, an identical repeat is a no-op, a different payload is a Conflict. Confirmed groups
   * only. */
  recordRemoteUsage(remoteId: string, usage: BatchUsageType): void;
  /** Marks the group's terminal harvest complete (last step, after items and usage landed);
   * first write wins, confirmed groups only. Excludes the group from pendingRemotes(). */
  markRemoteHarvested(remoteId: string, harvestedAt?: number): void;
  /** Job cost as an aggregation of stored per-group usage facts (never re-added per poll).
   * Provably-zero abandoned groups are skipped; ANY other group without a persisted fact
   * (intended/unknown/confirmed-unharvested) makes the whole aggregate unknown → undefined
   * (wire null) — never a partial total presented as complete. Known totals: tokens sum,
   * cost sums but stays null when ANY fact's cost is unknown (unknown ≠ zero), is_byok is
   * null if any fact is null OR the facts are mixed, true only when every fact is byok,
   * false only when every fact is non-byok. No facts at all → undefined. */
  remoteUsageTotal(jobId: string): BatchUsageType | undefined;
  remotes(jobId: string): readonly BatchRemote[];
  remoteByToken(submitToken: string): BatchRemote | undefined;
  /** Boot resume: confirmed groups whose terminal harvest has not been persisted yet —
   * feed each to pollKnown(remoteBatchId, items, signal); never re-run grouping/spill. */
  pendingRemotes(): readonly BatchRemote[];
  /** Every item assigned to one remote group, any status (item rows do not carry remoteId). */
  itemsForRemote(remoteId: string): readonly BatchItem[];
  /** Late/standalone assignment; beginRemote already persists its itemIds atomically.
   * Dispatchable jobs only — same guard as beginRemote. */
  assignRemoteItems(remoteId: string, itemIds: readonly string[]): void;
}

export interface BatchLedgerOptions {
  now?: () => number;
  newId?: () => string;
}

type JobRow = typeof batchJobs.$inferSelect;
type ItemRow = typeof batchItems.$inferSelect;
type RemoteRow = typeof batchRemotes.$inferSelect;

function toJob(row: JobRow): BatchJob {
  return {
    id: row.id,
    keyId: row.keyId,
    model: row.model,
    status: row.status as BatchStatus,
    completionWindowMs: row.completionWindowMs,
    createdAt: row.createdAt,
    finalizedAt: row.finalizedAt,
    spillAt: row.spillAt,
    requestCounts: {
      total: row.requestCountsTotal,
      completed: row.requestCountsCompleted,
      failed: row.requestCountsFailed,
    },
    usage: row.usageJson === null ? null : (JSON.parse(row.usageJson) as BatchUsageType),
    errorCode: row.errorCode,
  };
}

function toItem(row: ItemRow): BatchItem {
  return {
    id: row.id,
    jobId: row.jobId,
    customId: row.customId,
    status: row.status as BatchItemStatus,
    requestId: row.requestId,
    deploymentId: row.deploymentId,
    errorCode: row.errorCode,
    createdAt: row.createdAt,
    dispatchedAt: row.dispatchedAt,
    finishedAt: row.finishedAt,
  };
}

function toRemote(row: RemoteRow): BatchRemote {
  return {
    id: row.id,
    jobId: row.jobId,
    groupKey: row.groupKey,
    intent: row.intent as BatchRemoteIntent,
    submitToken: row.submitToken,
    remoteBatchId: row.remoteBatchId,
    usage: row.usageJson === null ? null : (JSON.parse(row.usageJson) as BatchUsageType),
    harvestedAt: row.harvestedAt,
    createdAt: row.createdAt,
    confirmedAt: row.confirmedAt,
  };
}

function mapLedgerError(cause: unknown): InvalidInput | Conflict | DatabaseError {
  if (cause instanceof InvalidInput || cause instanceof Conflict) {
    return cause;
  }
  if (cause instanceof Error && cause.message.includes("SQLITE_CONSTRAINT")) {
    return new InvalidInput({ message: "batch persistence rejected the write" });
  }
  return new DatabaseError({ message: "persistence failure" });
}

function requireJob(tx: ControlPlaneSession, jobId: string): JobRow {
  const row = tx.select().from(batchJobs).where(eq(batchJobs.id, jobId)).get();
  if (row === undefined) {
    throw new Conflict({ message: "batch job not found" });
  }
  return row;
}

function requireRemote(tx: ControlPlaneSession, remoteId: string): RemoteRow {
  const row = tx.select().from(batchRemotes).where(eq(batchRemotes.id, remoteId)).get();
  if (row === undefined) {
    throw new Conflict({ message: "batch remote group not found" });
  }
  return row;
}

function recomputeCounts(tx: ControlPlaneSession, jobId: string): BatchRequestCounts {
  const row = tx
    .select({
      total: count(),
      completed: sql<number>`COALESCE(SUM(CASE WHEN ${batchItems.status} = 'completed' THEN 1 ELSE 0 END), 0)`,
      failed: sql<number>`COALESCE(SUM(CASE WHEN ${batchItems.status} = 'failed' THEN 1 ELSE 0 END), 0)`,
    })
    .from(batchItems)
    .where(eq(batchItems.jobId, jobId))
    .get();
  const counts: BatchRequestCounts = {
    total: row?.total ?? 0,
    completed: Number(row?.completed ?? 0),
    failed: Number(row?.failed ?? 0),
  };
  tx.update(batchJobs)
    .set({
      requestCountsTotal: counts.total,
      requestCountsCompleted: counts.completed,
      requestCountsFailed: counts.failed,
    })
    .where(eq(batchJobs.id, jobId))
    .run();
  return counts;
}

function countItems(tx: ControlPlaneSession, jobId: string, statuses: readonly string[]): number {
  const row = tx
    .select({ value: count() })
    .from(batchItems)
    .where(and(eq(batchItems.jobId, jobId), inArray(batchItems.status, [...statuses])))
    .get();
  return row?.value ?? 0;
}

/** Terminalizing an item must not hide a still-running deferred request from reconciliation. */
function hasRunningLinkedRequest(tx: ControlPlaneSession, jobId: string): boolean {
  return (
    tx
      .select({ id: batchItems.id })
      .from(batchItems)
      .innerJoin(requests, eq(batchItems.requestId, requests.id))
      .where(and(eq(batchItems.jobId, jobId), eq(requests.status, "running")))
      .get() !== undefined
  );
}

function closeCancelling(tx: ControlPlaneSession, jobId: string, at: number): void {
  const job = tx.select().from(batchJobs).where(eq(batchJobs.id, jobId)).get();
  if (
    job !== undefined &&
    job.status === "cancelling" &&
    countItems(tx, jobId, ITEM_DISPATCHABLE) === 0 &&
    !hasRunningLinkedRequest(tx, jobId)
  ) {
    tx.update(batchJobs)
      .set({ status: "cancelled", finalizedAt: at })
      .where(eq(batchJobs.id, jobId))
      .run();
  }
}

function terminalizeQueued(
  tx: ControlPlaneSession,
  jobId: string,
  status: "failed" | "cancelled" | "expired",
  errorCode: string | null,
  now: number,
): void {
  tx.update(batchItems)
    .set({ status, errorCode, finishedAt: now })
    .where(and(eq(batchItems.jobId, jobId), eq(batchItems.status, "queued")))
    .run();
}

/** Maps free items into a remote group: queued → running + remote_id; already-running items
 * (claimed for spill intake in this same call chain, never issued locally) get remote_id only.
 * Refuses foreign, already-assigned, terminal and unknown items. */
function assignInto(
  tx: ControlPlaneSession,
  remote: RemoteRow,
  itemIds: readonly string[],
  at: number,
): void {
  if (itemIds.length === 0) {
    return;
  }
  const unique = [...new Set(itemIds)];
  const rows = tx.select().from(batchItems).where(inArray(batchItems.id, unique)).all();
  if (rows.length !== unique.length) {
    throw new Conflict({ message: "assignment references an unknown batch item" });
  }
  const queuedIds: string[] = [];
  const runningIds: string[] = [];
  for (const row of rows) {
    if (row.jobId !== remote.jobId) {
      throw new Conflict({ message: "assignment item belongs to another batch job" });
    }
    if (row.remoteId !== null) {
      throw new Conflict({ message: "assignment item is already assigned" });
    }
    if (row.status === "queued") {
      queuedIds.push(row.id);
    } else if (row.status === "running") {
      runningIds.push(row.id);
    } else {
      throw new Conflict({ message: "assignment item is not free to dispatch" });
    }
  }
  if (queuedIds.length > 0) {
    tx.update(batchItems)
      .set({ status: "running", remoteId: remote.id, dispatchedAt: at })
      .where(inArray(batchItems.id, queuedIds))
      .run();
  }
  if (runningIds.length > 0) {
    tx.update(batchItems)
      .set({ remoteId: remote.id })
      .where(inArray(batchItems.id, runningIds))
      .run();
  }
}

/** Drizzle's sync drivers guard async callbacks through a conditional return type
 * (`A extends Promise<any> ? DrizzleTypeError : A`) that cannot resolve for a free generic.
 * The transaction callback below therefore returns void — a concrete type the guard resolves —
 * and captures the synchronous result in a definitely-assigned local (assigned on every
 * successful commit; on any throw drizzle rolls back and rethrows, so the local is never read
 * after a failure). The union keeps the other half of the contract: only these result shapes
 * may flow through run(), so an async callback is a compile error at its call site instead of
 * an unsound acceptance that would commit before the promise settles. Adding a new run()
 * return shape means adding it here deliberately. */
type SyncTransactionResult = void | ItemRow[] | readonly BatchItem[] | BatchRemote;

export function createBatchLedger(db: ControlPlaneDb, options?: BatchLedgerOptions): BatchLedger {
  const now = options?.now ?? Date.now;
  const newId = options?.newId ?? (() => randomUUID());

  const run = <A extends SyncTransactionResult>(fn: (tx: ControlPlaneSession) => A): A => {
    let outcome!: A;
    try {
      db.transaction(
        (tx) => {
          outcome = fn(tx);
        },
        { behavior: "immediate" },
      );
    } catch (cause) {
      throw mapLedgerError(cause);
    }
    return outcome;
  };

  const claimQueued = (limit: number, spillDueAt?: number): readonly BatchItem[] => {
    if (!Number.isFinite(limit) || limit < 1) {
      return [];
    }
    return run((tx) => {
      const rows = tx
        .select({ item: batchItems })
        .from(batchItems)
        .innerJoin(batchJobs, eq(batchItems.jobId, batchJobs.id))
        .where(
          and(
            eq(batchItems.status, "queued"),
            inArray(batchJobs.status, [...JOB_DISPATCHABLE_STATUSES]),
            spillDueAt === undefined ? undefined : lte(batchJobs.spillAt, spillDueAt),
          ),
        )
        .orderBy(asc(batchItems.createdAt), asc(batchItems.id))
        .limit(Math.floor(limit))
        .all()
        .map((row) => row.item);
      if (rows.length === 0) {
        return [];
      }
      const at = now();
      tx.update(batchItems)
        .set({ status: "running", dispatchedAt: at })
        .where(
          inArray(
            batchItems.id,
            rows.map((row) => row.id),
          ),
        )
        .run();
      return rows.map((row): BatchItem => ({
        ...toItem(row),
        status: "running",
        dispatchedAt: at,
      }));
    });
  };

  // Crash recovery: dispatch that was in flight when the process died is marked interrupted —
  // possibly executed, never blindly replayed. Remotely assigned items only survive when their
  // group is confirmed (upstream still executes; the adapter resumes polling). Queued items are
  // never touched: durable inputs keep them recoverable.
  run((tx) => {
    const running = tx.select().from(batchItems).where(eq(batchItems.status, "running")).all();
    const stale: ItemRow[] = [];
    const remoteCache = new Map<string, RemoteRow | null>();
    for (const row of running) {
      if (row.remoteId === null) {
        stale.push(row);
        continue;
      }
      if (!remoteCache.has(row.remoteId)) {
        remoteCache.set(
          row.remoteId,
          tx.select().from(batchRemotes).where(eq(batchRemotes.id, row.remoteId)).get() ?? null,
        );
      }
      const remote = remoteCache.get(row.remoteId) ?? null;
      if (remote === null || remote.intent !== "confirmed") {
        stale.push(row);
      }
    }
    if (stale.length === 0) {
      return;
    }
    const at = now();
    tx.update(batchItems)
      .set({ status: "interrupted", errorCode: INTERRUPTED_ERROR, finishedAt: at })
      .where(
        inArray(
          batchItems.id,
          stale.map((row) => row.id),
        ),
      )
      .run();
    for (const jobId of [...new Set(stale.map((row) => row.jobId))]) {
      recomputeCounts(tx, jobId);
      closeCancelling(tx, jobId, at);
    }
  });

  return {
    create({ job, items }) {
      if (job.keyId.length === 0 || job.model.length === 0) {
        throw new InvalidInput({ message: "batch job requires keyId and model" });
      }
      if (!Number.isInteger(job.completionWindowMs) || job.completionWindowMs < 1) {
        throw new InvalidInput({ message: "batch completion window must be a positive integer" });
      }
      if (!Number.isInteger(job.spillAt) || job.spillAt < 0) {
        throw new InvalidInput({ message: "batch spillAt must be a non-negative integer" });
      }
      const createdAt = job.createdAt ?? now();
      if (!Number.isInteger(createdAt) || createdAt < 0) {
        throw new InvalidInput({ message: "batch createdAt must be a non-negative integer" });
      }
      const initialStatus = job.status ?? "validating";
      if (initialStatus !== "validating" && initialStatus !== "queued") {
        throw new InvalidInput({ message: "a batch job can only be created validating or queued" });
      }
      if (items.length === 0) {
        throw new InvalidInput({ message: "batch requires at least one item" });
      }
      if (items.length > BATCH_MAX_ITEMS_PER_JOB) {
        throw new InvalidInput({ message: "batch exceeds the 1000 item limit" });
      }
      const seen = new Set<string>();
      for (const item of items) {
        if (typeof item.customId !== "string") {
          throw new InvalidInput({ message: "batch custom_id must be a string" });
        }
        const status = item.status ?? "queued";
        if (!CREATE_ITEM_ALLOWED[status]) {
          throw new InvalidInput({ message: "batch items cannot be created in this status" });
        }
        if (item.customId.length === 0) {
          throw new InvalidInput({ message: "batch custom_id must be non-empty" });
        }
        if (item.customId.length > BATCH_MAX_CUSTOM_ID_CHARS) {
          throw new InvalidInput({ message: "batch custom_id exceeds 128 characters" });
        }
        if (seen.has(item.customId)) {
          throw new InvalidInput({ message: "batch custom_id must be unique within the job" });
        }
        seen.add(item.customId);
      }
      const jobId = job.id ?? `batch_${newId()}`;
      if (jobId.length === 0) {
        throw new InvalidInput({ message: "batch job id must be a non-empty string" });
      }
      const rows = run((tx): ItemRow[] => {
        const inflight = tx
          .select({ value: count() })
          .from(batchJobs)
          .where(
            and(
              eq(batchJobs.keyId, job.keyId),
              not(inArray(batchJobs.status, [...JOB_TERMINAL_STATUSES])),
            ),
          )
          .get();
        if ((inflight?.value ?? 0) >= BATCH_MAX_INFLIGHT_JOBS_PER_KEY) {
          throw new Conflict({ message: "key already has four in-flight batch jobs" });
        }
        if (tx.select().from(batchJobs).where(eq(batchJobs.id, jobId)).get() !== undefined) {
          throw new Conflict({ message: "batch job already exists" });
        }
        const failedItems = items.filter((item) => (item.status ?? "queued") === "failed").length;
        tx.insert(batchJobs)
          .values({
            id: jobId,
            keyId: job.keyId,
            model: job.model,
            status: initialStatus,
            completionWindowMs: job.completionWindowMs,
            createdAt,
            finalizedAt: null,
            spillAt: job.spillAt,
            usageJson: null,
            requestCountsTotal: items.length,
            requestCountsCompleted: 0,
            requestCountsFailed: failedItems,
            errorCode: job.errorCode ?? null,
          })
          .run();
        const created: ItemRow[] = [];
        for (const item of items) {
          const status = item.status ?? "queued";
          const row: ItemRow = {
            id: `batch_req_${newId()}`,
            jobId,
            customId: item.customId,
            status,
            requestId: null,
            deploymentId: null,
            errorCode: item.errorCode ?? null,
            createdAt,
            dispatchedAt: null,
            finishedAt: batchItemStatusIsTerminal(status) ? createdAt : null,
            remoteId: null,
          };
          tx.insert(batchItems).values(row).run();
          created.push(row);
        }
        return created;
      });
      return {
        job: toJob(requireJob(db, jobId)),
        items: rows.map(toItem),
      };
    },

    job(jobId) {
      const row = db.select().from(batchJobs).where(eq(batchJobs.id, jobId)).get();
      return row === undefined ? undefined : toJob(row);
    },

    items(jobId) {
      requireJob(db, jobId);
      return db
        .select()
        .from(batchItems)
        .where(eq(batchItems.jobId, jobId))
        .orderBy(asc(batchItems.createdAt), asc(batchItems.id))
        .all()
        .map(toItem);
    },

    list(keyId, page) {
      if (!Number.isFinite(page.limit)) {
        throw new InvalidInput({ message: "invalid batch list limit" });
      }
      const limit = Math.min(Math.max(Math.floor(page.limit), 1), 100);
      const filters = [eq(batchJobs.keyId, keyId)];
      if (page.after !== undefined) {
        const cursor = db
          .select()
          .from(batchJobs)
          .where(and(eq(batchJobs.id, page.after), eq(batchJobs.keyId, keyId)))
          .get();
        if (cursor === undefined) {
          throw new InvalidInput({ message: "invalid batch cursor" });
        }
        filters.push(
          or(
            lt(batchJobs.createdAt, cursor.createdAt),
            and(eq(batchJobs.createdAt, cursor.createdAt), lt(batchJobs.id, cursor.id)),
          )!,
        );
      }
      return db
        .select()
        .from(batchJobs)
        .where(and(...filters))
        .orderBy(desc(batchJobs.createdAt), desc(batchJobs.id))
        .limit(limit)
        .all()
        .map(toJob);
    },

    activeJobs() {
      return db
        .select()
        .from(batchJobs)
        .where(not(inArray(batchJobs.status, [...JOB_TERMINAL_STATUSES])))
        .orderBy(asc(batchJobs.createdAt), asc(batchJobs.id))
        .all()
        .map(toJob);
    },

    claim(limit) {
      return claimQueued(limit);
    },

    claimDue(limit, spillDueAt) {
      if (!Number.isInteger(spillDueAt) || spillDueAt < 0) {
        throw new InvalidInput({ message: "batch spillDueAt must be a non-negative integer" });
      }
      return claimQueued(limit, spillDueAt);
    },

    completeItem(itemId, outcome) {
      if (!COMPLETE_ITEM_ALLOWED[outcome.status]) {
        throw new InvalidInput({
          message: "completeItem requires a terminal item status",
        });
      }
      run((tx) => {
        const item = tx.select().from(batchItems).where(eq(batchItems.id, itemId)).get();
        if (item === undefined) {
          throw new Conflict({ message: "batch item not found" });
        }
        const job = requireJob(tx, item.jobId);
        if (batchStatusIsTerminal(job.status as BatchStatus)) {
          throw new Conflict({ message: "cannot complete an item of a terminal batch job" });
        }
        if (batchItemStatusIsTerminal(item.status as BatchItemStatus)) {
          throw new Conflict({ message: "batch item is already terminal" });
        }
        const at = now();
        tx.update(batchItems)
          .set({
            status: outcome.status,
            errorCode: "errorCode" in outcome ? (outcome.errorCode ?? null) : item.errorCode,
            requestId: "requestId" in outcome ? (outcome.requestId ?? null) : item.requestId,
            deploymentId:
              "deploymentId" in outcome ? (outcome.deploymentId ?? null) : item.deploymentId,
            finishedAt: at,
          })
          .where(eq(batchItems.id, itemId))
          .run();
        recomputeCounts(tx, item.jobId);
        closeCancelling(tx, item.jobId, at);
      });
    },

    requeue(itemId) {
      run((tx) => {
        const item = tx.select().from(batchItems).where(eq(batchItems.id, itemId)).get();
        if (item === undefined) {
          throw new Conflict({ message: "batch item not found" });
        }
        const job = requireJob(tx, item.jobId);
        if (!jobAllowsDispatch(job.status)) {
          throw new Conflict({
            message: "batch job no longer accepts dispatch (cancelling/finalizing/terminal)",
          });
        }
        if (item.remoteId !== null) {
          throw new Conflict({
            message: "cannot requeue a remotely assigned batch item",
          });
        }
        if (batchItemStatusIsTerminal(item.status as BatchItemStatus)) {
          throw new Conflict({ message: "cannot requeue a terminal batch item" });
        }
        // Identity hand-off: never orphan a running request. The previous attempt must be
        // finalized first (or was already pruned — retention never deletes running rows);
        // its accounting stays in the requests ledger untouched. Runs for ALREADY-queued
        // items too: abandonRemote queues an item without clearing its old linkage, so a
        // stale terminal requestId must be cleared here or the next attach is blocked.
        if (item.requestId !== null) {
          const linked = tx.select().from(requests).where(eq(requests.id, item.requestId)).get();
          if (linked !== undefined && linked.status === "running") {
            throw new Conflict({
              message: "linked request is still running; finalize it before requeue",
            });
          }
        }
        tx.update(batchItems)
          .set({
            status: "queued",
            dispatchedAt: null,
            requestId: null,
            deploymentId: null,
            errorCode: null,
          })
          .where(eq(batchItems.id, itemId))
          .run();
      });
    },

    setJobStatus(jobId, status, finalizedAt, errorCode) {
      run((tx) => {
        const job = requireJob(tx, jobId);
        const current = job.status as BatchStatus;
        if (!JOB_TRANSITIONS[current].includes(status)) {
          throw new Conflict({
            message: `batch job cannot transition from ${current} to ${status}`,
          });
        }
        const at = now();
        let patch: Partial<JobRow> = {};
        if (status === "cancelling") {
          terminalizeQueued(tx, jobId, "cancelled", errorCode ?? null, at);
          patch =
            countItems(tx, jobId, ITEM_DISPATCHABLE) === 0 && !hasRunningLinkedRequest(tx, jobId)
              ? { status: "cancelled", finalizedAt: at }
              : { status: "cancelling" };
        } else if (status === "finalizing") {
          if (countItems(tx, jobId, ITEM_DISPATCHABLE) > 0 || hasRunningLinkedRequest(tx, jobId)) {
            throw new Conflict({
              message: "batch job still has undispatched or in-flight items",
            });
          }
          patch = { status: "finalizing" };
        } else if (batchStatusIsTerminal(status)) {
          if (status === "failed") {
            terminalizeQueued(tx, jobId, "failed", errorCode ?? null, at);
          } else if (status === "expired") {
            terminalizeQueued(tx, jobId, "expired", errorCode ?? null, at);
          } else if (status === "cancelled") {
            terminalizeQueued(tx, jobId, "cancelled", errorCode ?? null, at);
          }
          if (countItems(tx, jobId, ["running"]) > 0) {
            throw new Conflict({ message: "batch job has in-flight items" });
          }
          if (countItems(tx, jobId, ITEM_DISPATCHABLE) > 0) {
            throw new Conflict({ message: "batch job still has undispatched items" });
          }
          if (hasRunningLinkedRequest(tx, jobId)) {
            throw new Conflict({ message: "batch job has a running linked request" });
          }
          patch = { status, finalizedAt: finalizedAt ?? at };
        } else {
          patch = { status };
        }
        if (errorCode !== undefined) {
          patch.errorCode = errorCode ?? null;
        }
        recomputeCounts(tx, jobId);
        tx.update(batchJobs).set(patch).where(eq(batchJobs.id, jobId)).run();
      });
    },

    recordJobUsage(jobId, usage) {
      let encoded: string | null = null;
      if (usage !== null) {
        try {
          encoded = JSON.stringify(decodeUsage(usage));
        } catch {
          throw new InvalidInput({ message: "batch usage is invalid" });
        }
      }
      run((tx) => {
        requireJob(tx, jobId);
        // null clears a stale aggregate once a fact turns unknown.
        tx.update(batchJobs).set({ usageJson: encoded }).where(eq(batchJobs.id, jobId)).run();
      });
    },

    counts(jobId) {
      return toJob(requireJob(db, jobId)).requestCounts;
    },

    expire(before) {
      if (!Number.isInteger(before) || before < 0) {
        throw new InvalidInput({ message: "batch expiry cutoff must be a non-negative integer" });
      }
      run((tx) => {
        const candidates = tx
          .select()
          .from(batchJobs)
          .where(
            and(
              lt(sql<number>`${batchJobs.spillAt} + ${batchJobs.completionWindowMs}`, before),
              not(inArray(batchJobs.status, [...JOB_TERMINAL_STATUSES])),
            ),
          )
          .all();
        for (const job of candidates) {
          if (countItems(tx, job.id, ["running"]) > 0 || hasRunningLinkedRequest(tx, job.id)) {
            continue;
          }
          const at = now();
          terminalizeQueued(tx, job.id, "expired", null, at);
          recomputeCounts(tx, job.id);
          tx.update(batchJobs)
            .set({ status: "expired", finalizedAt: at })
            .where(eq(batchJobs.id, job.id))
            .run();
        }
      });
    },

    beginRemote(jobId, input) {
      if (input.groupKey.length === 0 || input.submitToken.length === 0) {
        throw new InvalidInput({ message: "remote group requires groupKey and submitToken" });
      }
      if (
        input.createdAt !== undefined &&
        (!Number.isInteger(input.createdAt) || input.createdAt < 0)
      ) {
        throw new InvalidInput({ message: "remote createdAt must be a non-negative integer" });
      }
      return run((tx) => {
        const existing = tx
          .select()
          .from(batchRemotes)
          .where(eq(batchRemotes.submitToken, input.submitToken))
          .get();
        if (existing !== undefined) {
          if (existing.jobId !== jobId || existing.groupKey !== input.groupKey) {
            throw new Conflict({ message: "submit token is already bound to another group" });
          }
          if (existing.intent === "abandoned") {
            // Abandon proves the earlier POST never executed (clean rejection), so the
            // tombstone may reopen for the identical set. unknown/confirmed never reopen:
            // possibly-executed and proven work stay frozen.
            const reopenedJob = requireJob(tx, jobId);
            if (!jobAllowsDispatch(reopenedJob.status)) {
              throw new Conflict({
                message: "batch job no longer accepts dispatch (cancelling/finalizing/terminal)",
              });
            }
            tx.update(batchRemotes)
              .set({ intent: "intended" })
              .where(eq(batchRemotes.id, existing.id))
              .run();
            const reopened: RemoteRow = { ...existing, intent: "intended" };
            assignInto(tx, reopened, input.itemIds, input.createdAt ?? now());
            return toRemote(reopened);
          }
          // Record-if-absent: identity implies the assignment was persisted with the row.
          return toRemote(existing);
        }
        const job = requireJob(tx, jobId);
        if (!jobAllowsDispatch(job.status)) {
          throw new Conflict({
            message: "batch job no longer accepts dispatch (cancelling/finalizing/terminal)",
          });
        }
        const at = input.createdAt ?? now();
        const row: RemoteRow = {
          id: `batch_grp_${newId()}`,
          jobId,
          groupKey: input.groupKey,
          intent: "intended",
          submitToken: input.submitToken,
          remoteBatchId: null,
          usageJson: null,
          harvestedAt: null,
          createdAt: at,
          confirmedAt: null,
        };
        tx.insert(batchRemotes).values(row).run();
        // Persist the exact item set BEFORE any POST — crash-safe intent + assignment.
        assignInto(tx, row, input.itemIds, at);
        return toRemote(row);
      });
    },

    markRemoteUnknown(remoteId) {
      run((tx) => {
        const remote = requireRemote(tx, remoteId);
        if (remote.intent === "unknown") {
          return;
        }
        if (remote.intent !== "intended") {
          throw new Conflict({
            message: `cannot mark a ${remote.intent} remote group unknown`,
          });
        }
        const at = now();
        tx.update(batchRemotes)
          .set({ intent: "unknown" })
          .where(eq(batchRemotes.id, remoteId))
          .run();
        tx.update(batchItems)
          .set({ status: "interrupted", errorCode: INTERRUPTED_ERROR, finishedAt: at })
          .where(and(eq(batchItems.remoteId, remoteId), eq(batchItems.status, "running")))
          .run();
        recomputeCounts(tx, remote.jobId);
        closeCancelling(tx, remote.jobId, at);
      });
    },

    abandonRemote(remoteId) {
      run((tx) => {
        const remote = requireRemote(tx, remoteId);
        if (remote.intent === "abandoned") {
          return;
        }
        if (remote.intent !== "intended") {
          throw new Conflict({
            message: `cannot abandon a ${remote.intent} remote group`,
          });
        }
        tx.update(batchRemotes)
          .set({ intent: "abandoned" })
          .where(eq(batchRemotes.id, remoteId))
          .run();
        const job = requireJob(tx, remote.jobId);
        const at = now();
        if (job.status === "cancelling") {
          // A running linked request must remain visible until its accounting finalizes.
          // Other rejected items can be cancelled now; none is requeued after DELETE.
          tx.update(batchItems)
            .set({ status: "cancelled", remoteId: null, dispatchedAt: null, finishedAt: at })
            .where(
              and(
                eq(batchItems.remoteId, remoteId),
                eq(batchItems.status, "running"),
                notExists(
                  tx
                    .select({ id: requests.id })
                    .from(requests)
                    .where(
                      and(eq(requests.id, batchItems.requestId), eq(requests.status, "running")),
                    ),
                ),
              ),
            )
            .run();
          recomputeCounts(tx, remote.jobId);
          closeCancelling(tx, remote.jobId, at);
          return;
        }
        tx.update(batchItems)
          .set({ status: "queued", remoteId: null, dispatchedAt: null })
          .where(and(eq(batchItems.remoteId, remoteId), eq(batchItems.status, "running")))
          .run();
      });
    },

    confirmRemote(remoteId, remoteBatchId, confirmedAt) {
      if (remoteBatchId.length === 0) {
        throw new InvalidInput({ message: "confirmed remote id must be non-empty" });
      }
      const at = confirmedAt ?? now();
      if (!Number.isInteger(at) || at < 0) {
        throw new InvalidInput({ message: "confirmedAt must be a non-negative integer" });
      }
      run((tx) => {
        const remote = requireRemote(tx, remoteId);
        if (remote.intent === "confirmed") {
          if (remote.remoteBatchId === remoteBatchId) {
            return;
          }
          throw new Conflict({ message: "a proven remote id is never replaced" });
        }
        if (remote.intent === "abandoned") {
          throw new Conflict({ message: "cannot confirm an abandoned remote group" });
        }
        const bound = tx
          .select()
          .from(batchRemotes)
          .where(eq(batchRemotes.remoteBatchId, remoteBatchId))
          .get();
        if (bound !== undefined) {
          throw new Conflict({ message: "a proven remote id belongs to another group" });
        }
        tx.update(batchRemotes)
          .set({ intent: "confirmed", remoteBatchId, confirmedAt: at })
          .where(eq(batchRemotes.id, remoteId))
          .run();
      });
    },

    recordRemoteUsage(remoteId, usage) {
      let encoded: string;
      try {
        encoded = JSON.stringify(decodeUsage(usage));
      } catch {
        throw new InvalidInput({ message: "batch usage is invalid" });
      }
      run((tx) => {
        const remote = requireRemote(tx, remoteId);
        if (remote.intent !== "confirmed") {
          throw new Conflict({
            message: "usage persists only for a confirmed remote group",
          });
        }
        if (remote.usageJson !== null) {
          if (remote.usageJson === encoded) {
            return;
          }
          throw new Conflict({ message: "remote group usage is persisted once" });
        }
        tx.update(batchRemotes)
          .set({ usageJson: encoded })
          .where(eq(batchRemotes.id, remoteId))
          .run();
      });
    },

    markRemoteHarvested(remoteId, harvestedAt) {
      const at = harvestedAt ?? now();
      if (!Number.isInteger(at) || at < 0) {
        throw new InvalidInput({ message: "harvestedAt must be a non-negative integer" });
      }
      run((tx) => {
        const remote = requireRemote(tx, remoteId);
        if (remote.intent !== "confirmed") {
          throw new Conflict({
            message: "only a confirmed remote group can be harvested",
          });
        }
        if (remote.harvestedAt !== null) {
          return;
        }
        tx.update(batchRemotes).set({ harvestedAt: at }).where(eq(batchRemotes.id, remoteId)).run();
      });
    },

    remoteUsageTotal(jobId) {
      requireJob(db, jobId);
      const rows = db.select().from(batchRemotes).where(eq(batchRemotes.jobId, jobId)).all();
      let promptTokens = 0;
      let completionTokens = 0;
      let totalTokens = 0;
      let cost: number | null = 0;
      let isByok: boolean | null = null;
      let byokSeen = false;
      let seen = false;
      for (const row of rows) {
        if ((row.intent as BatchRemoteIntent) === "abandoned") {
          // Provably never executed: carries no cost and may be skipped.
          continue;
        }
        if (row.usageJson === null) {
          // Any other group without a persisted fact is unknown (possibly billed): the whole
          // aggregate is unknown — never present a partial total as complete.
          return undefined;
        }
        const usage = JSON.parse(row.usageJson) as BatchUsageType;
        seen = true;
        promptTokens += usage.prompt_tokens;
        completionTokens += usage.completion_tokens;
        totalTokens += usage.total_tokens;
        cost = cost === null || usage.cost === null ? null : cost + usage.cost;
        if (!byokSeen) {
          isByok = usage.is_byok;
          byokSeen = true;
        } else if (usage.is_byok === null || isByok === null) {
          isByok = null;
        } else if (usage.is_byok !== isByok) {
          // Mixed fees-only and full-provider charges: the aggregate is unknown, not false.
          isByok = null;
        }
      }
      if (!seen) {
        return undefined;
      }
      return {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
        cost,
        is_byok: isByok,
      };
    },

    remotes(jobId) {
      requireJob(db, jobId);
      return db
        .select()
        .from(batchRemotes)
        .where(eq(batchRemotes.jobId, jobId))
        .orderBy(asc(batchRemotes.createdAt), asc(batchRemotes.id))
        .all()
        .map(toRemote);
    },

    remoteByToken(submitToken) {
      const row = db
        .select()
        .from(batchRemotes)
        .where(eq(batchRemotes.submitToken, submitToken))
        .get();
      return row === undefined ? undefined : toRemote(row);
    },

    itemsForRemote(remoteId) {
      requireRemote(db, remoteId);
      return db
        .select()
        .from(batchItems)
        .where(eq(batchItems.remoteId, remoteId))
        .orderBy(asc(batchItems.createdAt), asc(batchItems.id))
        .all()
        .map(toItem);
    },

    pendingRemotes() {
      return db
        .select()
        .from(batchRemotes)
        .where(and(eq(batchRemotes.intent, "confirmed"), isNull(batchRemotes.harvestedAt)))
        .orderBy(asc(batchRemotes.createdAt), asc(batchRemotes.id))
        .all()
        .map(toRemote);
    },

    assignRemoteItems(remoteId, itemIds) {
      if (itemIds.length === 0) {
        return;
      }
      run((tx) => {
        const remote = requireRemote(tx, remoteId);
        if (remote.intent !== "intended") {
          throw new Conflict({
            message: "items can only be assigned to an intended remote group",
          });
        }
        const job = requireJob(tx, remote.jobId);
        if (!jobAllowsDispatch(job.status)) {
          throw new Conflict({
            message: "batch job no longer accepts dispatch (cancelling/finalizing/terminal)",
          });
        }
        assignInto(tx, remote, itemIds, now());
      });
    },
  };
}
