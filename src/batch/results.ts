import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import { DatabaseError, InvalidInput } from "../errors.ts";
import {
  BATCH_MAX_ITEM_BODY_BYTES,
  BATCH_MAX_JOB_BODY_BYTES,
  batchStatusIsTerminal,
  type BatchStatus,
} from "../domain.ts";

/** Inline result row, OpenRouter-shaped. Exactly one of response/error is set (XOR). */
export type BatchResultRow = {
  id: string;
  custom_id: string;
  response: { status_code: number; request_id: string | null; body: unknown } | null;
  error: unknown | null;
};

/** Everything the store needs to know about a job, read fresh on every decision. */
export type BatchResultJobInfo = {
  readonly keyId: string;
  readonly status: BatchStatus;
  readonly finalizedAt: number | null;
  /** Ledger request count, when available; guards completed reads against rows lost before
   * the filename index is rebuilt at restart. */
  readonly requestCount?: number;
};

/** The approved private batch store: durable request bodies plus result rows, outside the
 * metadata database. Every file write is failure-atomic (temp + rename, then indexed in the
 * same step — a mid-write failure can never leave untracked bytes), files are per-item under
 * `<jobId>.inputs/` and per-row under `<jobId>.results/` (never a whole-job rewrite, never an
 * append log that a torn line could poison). Reads are retry-safe: nothing is destroyed by
 * reading; retention is explicit drop (DELETE acknowledgement) or the TTL sweep 24h after the
 * job terminates, covering results AND inputs of any terminal job, failed/cancelled included.
 * Held-byte counts and row indexes are rebuilt from disk at construction; stale `.tmp` files
 * are cleaned then. */
export interface BatchResultStore {
  /** Idempotent per row id: re-appending the same row overwrites its file, never duplicates. */
  append(jobId: string, row: BatchResultRow): void;
  /** Reads every indexed row in sequence order. Corruption is explicit: a damaged, missing
   * or unreadable row file throws typed BatchResultStoreCorrupt (never a silent partial set). */
  rows(jobId: string): readonly BatchResultRow[];
  /** O(1) row-id existence from the in-memory filename index; does not read JSON.
   * Content integrity remains checked by rows() when the result is served. */
  hasRow(jobId: string, itemId: string): boolean;
  /** DELETE acknowledgement: purges this job's results and inputs. */
  drop(jobId: string): void;
  sweepExpired(now: number): void;
  /** Durable item bodies, keyed by generated ids, ownership-checked against keyId.
   * Per-item private files: only the named items are written, each accounted in the held-byte
   * index immediately after its rename. 512KiB/item and 32MiB/job caps; bytes count toward
   * the per-job/per-key storage budgets. */
  saveInputs(
    jobId: string,
    keyId: string,
    items: readonly { itemId: string; body: Readonly<Record<string, unknown>> }[],
  ): void;
  readInput(
    jobId: string,
    keyId: string,
    itemId: string,
  ): Readonly<Record<string, unknown>> | undefined;
  /** Removes one body (single unlink), or the whole job's inputs when itemId is omitted. */
  removeInputs(jobId: string, keyId: string, itemId?: string): void;
}

export const BATCH_RESULT_TTL_MS = 24 * 60 * 60 * 1_000;
export const BATCH_RESULT_JOB_BUDGET_BYTES = 64 * 1024 * 1024;
export const BATCH_RESULT_KEY_BUDGET_BYTES = 256 * 1024 * 1024;
export const BATCH_RESULTS_DEFAULT_DIRECTORY = "data/batch-results";

export class BatchResultBudgetExceeded extends Schema.TaggedError<BatchResultBudgetExceeded>()(
  "BatchResultBudgetExceeded",
  {
    message: Schema.String,
    scope: Schema.Literals(["job", "key"]),
    jobId: Schema.String,
    limitBytes: Schema.Int,
  },
) {}

/** Corruption is never hidden: rows() throws this instead of serving an incomplete
 * completed-result set. Surface may catch it and synthesize a per-item storage-error row
 * from the reported rowId, but a silent partial read is impossible. */
export class BatchResultStoreCorrupt extends Schema.TaggedError<BatchResultStoreCorrupt>()(
  "BatchResultStoreCorrupt",
  {
    message: Schema.String,
    jobId: Schema.String,
    rowId: Schema.String,
  },
) {}

export interface BatchResultStoreOptions {
  /** Defaults to data/batch-results (BATCH_RESULTS_DEFAULT_DIRECTORY); the server wiring
   * derives dirname(SQLITE_PATH)/batch-content instead. */
  directory?: string;
  /** Ledger lookup: keyId feeds ownership and the per-key budget; status+finalizedAt the TTL. */
  jobInfo: (jobId: string) => BatchResultJobInfo | undefined;
  jobBudgetBytes?: number;
  keyBudgetBytes?: number;
}

const SAFE_JOB_ID = /^[A-Za-z0-9_.-]+$/;
const GENERATED_JOB_ID = /^batch_[A-Za-z0-9_.-]+$/;
const INPUTS_DIR_SUFFIX = ".inputs";
const RESULTS_DIR_SUFFIX = ".results";
const ROW_FILE = /^(\d{8})-([A-Za-z0-9_.-]+)\.json$/;

type HeldEntry = {
  resultsBytes: number;
  inputsBytes: number;
  keyId: string | undefined;
  /** Row id → zero-padded sequence slot; dense from 0, rebuilt from filenames. */
  rows: Map<string, number>;
};

export function createBatchResultStore(options: BatchResultStoreOptions): BatchResultStore {
  const directory = options.directory ?? BATCH_RESULTS_DEFAULT_DIRECTORY;
  const jobBudget = options.jobBudgetBytes ?? BATCH_RESULT_JOB_BUDGET_BYTES;
  const keyBudget = options.keyBudgetBytes ?? BATCH_RESULT_KEY_BUDGET_BYTES;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const held = new Map<string, HeldEntry>();
  const heldPerKey = new Map<string, number>();

  const requireSafe = (id: string): void => {
    if (id.length === 0 || !SAFE_JOB_ID.test(id)) {
      throw new InvalidInput({ message: "invalid batch id" });
    }
  };
  const resultsDirOf = (jobId: string): string => {
    requireSafe(jobId);
    return join(directory, `${jobId}${RESULTS_DIR_SUFFIX}`);
  };
  const inputsDirOf = (jobId: string): string => {
    requireSafe(jobId);
    return join(directory, `${jobId}${INPUTS_DIR_SUFFIX}`);
  };
  const inputPathOf = (jobId: string, itemId: string): string => {
    requireSafe(itemId);
    return join(inputsDirOf(jobId), `${itemId}.json`);
  };
  const rowPathOf = (jobId: string, seq: number, rowId: string): string =>
    join(resultsDirOf(jobId), `${String(seq).padStart(8, "0")}-${rowId}.json`);
  const applyKeyDelta = (keyId: string, delta: number): void => {
    const total = (heldPerKey.get(keyId) ?? 0) + delta;
    if (total <= 0) {
      heldPerKey.delete(keyId);
    } else {
      heldPerKey.set(keyId, total);
    }
  };
  /** Index this job's held bytes (both directories), moving them between key buckets on
   * change. Entries share one rows map by reference across replacements. */
  const track = (jobId: string, entry: HeldEntry): void => {
    const previous = held.get(jobId);
    if (previous?.keyId !== undefined) {
      applyKeyDelta(previous.keyId, -(previous.resultsBytes + previous.inputsBytes));
    }
    held.set(jobId, entry);
    if (entry.keyId !== undefined) {
      applyKeyDelta(entry.keyId, entry.resultsBytes + entry.inputsBytes);
    }
  };
  const release = (jobId: string): void => {
    const entry = held.get(jobId);
    if (entry === undefined) {
      return;
    }
    held.delete(jobId);
    if (entry.keyId !== undefined) {
      applyKeyDelta(entry.keyId, -(entry.resultsBytes + entry.inputsBytes));
    }
  };
  const requireOwned = (jobId: string, keyId: string): BatchResultJobInfo => {
    const info = options.jobInfo(jobId);
    if (info === undefined) {
      throw new InvalidInput({ message: "batch job is not in the ledger" });
    }
    if (info.keyId !== keyId) {
      throw new InvalidInput({ message: "batch job does not belong to this key" });
    }
    return info;
  };
  const entryOf = (jobId: string, keyId: string): HeldEntry =>
    held.get(jobId) ?? { resultsBytes: 0, inputsBytes: 0, keyId, rows: new Map() };
  const assertBudget = (
    jobId: string,
    keyId: string,
    addedBytes: number,
    entry: HeldEntry,
  ): void => {
    if (entry.resultsBytes + entry.inputsBytes + addedBytes > jobBudget) {
      throw new BatchResultBudgetExceeded({
        message: "batch store exceeds the 64MiB per-job budget",
        scope: "job",
        jobId,
        limitBytes: jobBudget,
      });
    }
    if ((heldPerKey.get(keyId) ?? 0) + addedBytes > keyBudget) {
      throw new BatchResultBudgetExceeded({
        message: "batch store exceeds the 256MiB per-key budget",
        scope: "key",
        jobId,
        limitBytes: keyBudget,
      });
    }
  };
  /** temp + rename: the destination only ever holds complete content; the temp is removed
   * on an in-process failure and swept at restart. */
  const atomicWrite = (path: string, payload: string): void => {
    const tmp = `${path}.tmp`;
    try {
      writeFileSync(tmp, payload, { mode: 0o600 });
      renameSync(tmp, path);
      chmodSync(path, 0o600);
    } catch (cause) {
      rmSync(tmp, { force: true });
      throw cause;
    }
  };
  const sizeOf = (path: string): number => (existsSync(path) ? statSync(path).size : 0);
  const purgeJobFiles = (jobId: string): void => {
    rmSync(resultsDirOf(jobId), { recursive: true, force: true });
    rmSync(inputsDirOf(jobId), { recursive: true, force: true });
  };

  // Rebuild held bytes and the row index from disk (files outlive processes), and sweep away
  // any stale temp files a crash left behind — they are never valid state. Dynamic runtime
  // store paths must not be traced at build time: that can package the live SQLite database.
  for (const dirent of readdirSync(/* turbopackIgnore: true */ directory, {
    withFileTypes: true,
  })) {
    if (!dirent.isDirectory()) {
      continue;
    }
    const suffix = dirent.name.endsWith(RESULTS_DIR_SUFFIX)
      ? RESULTS_DIR_SUFFIX
      : dirent.name.endsWith(INPUTS_DIR_SUFFIX)
        ? INPUTS_DIR_SUFFIX
        : undefined;
    if (suffix === undefined) continue;
    const jobId = dirent.name.slice(0, -suffix.length);
    if (!SAFE_JOB_ID.test(jobId)) continue;
    const jobInfo = options.jobInfo(jobId);
    if (jobInfo === undefined) {
      // Only store-generated paths are ours to remove without ledger metadata.
      if (GENERATED_JOB_ID.test(jobId)) purgeJobFiles(jobId);
      continue;
    }
    let resultsBytes = 0;
    let inputsBytes = 0;
    const rows = new Map<string, number>();
    if (suffix === RESULTS_DIR_SUFFIX) {
      const resultsDir = join(/* turbopackIgnore: true */ directory, dirent.name);
      for (const file of readdirSync(/* turbopackIgnore: true */ resultsDir)) {
        const path = join(/* turbopackIgnore: true */ resultsDir, file);
        if (file.endsWith(".tmp")) {
          rmSync(path, { force: true });
          continue;
        }
        const parsed = ROW_FILE.exec(file);
        if (parsed === null) {
          continue;
        }
        rows.set(parsed[2]!, Number(parsed[1]));
        resultsBytes += statSync(/* turbopackIgnore: true */ path).size;
      }
    } else {
      const inputsDir = join(/* turbopackIgnore: true */ directory, dirent.name);
      for (const file of readdirSync(/* turbopackIgnore: true */ inputsDir)) {
        const path = join(/* turbopackIgnore: true */ inputsDir, file);
        if (file.endsWith(".tmp")) {
          rmSync(path, { force: true });
          continue;
        }
        if (file.endsWith(".json")) {
          inputsBytes += statSync(/* turbopackIgnore: true */ path).size;
        }
      }
    }
    const existing = held.get(jobId);
    const merged: HeldEntry = existing ?? {
      resultsBytes: 0,
      inputsBytes: 0,
      keyId: undefined,
      rows: new Map(),
    };
    track(jobId, {
      resultsBytes: merged.resultsBytes + resultsBytes,
      inputsBytes: merged.inputsBytes + inputsBytes,
      keyId: jobInfo.keyId,
      rows: merged.rows.size > 0 ? merged.rows : rows,
    });
  }

  return {
    append(jobId, row) {
      resultsDirOf(jobId); // path-safe id check first
      const info = options.jobInfo(jobId);
      if (info === undefined) {
        throw new InvalidInput({ message: "batch job is not in the ledger" });
      }
      const hasResponse = row.response !== null && row.response !== undefined;
      const hasError = row.error !== null && row.error !== undefined;
      if (hasResponse === hasError) {
        throw new InvalidInput({
          message: "batch result row must set exactly one of response or error",
        });
      }
      requireSafe(row.id);
      const payload = JSON.stringify(row);
      if (payload === undefined) {
        throw new InvalidInput({ message: "batch result row is not serializable" });
      }
      const bytes = Buffer.byteLength(payload, "utf8");
      const entry = entryOf(jobId, info.keyId);
      const existingSeq = entry.rows.get(row.id);
      const seq = existingSeq ?? entry.rows.size;
      const path = rowPathOf(jobId, seq, row.id);
      const delta = bytes - (existingSeq !== undefined ? sizeOf(path) : 0);
      assertBudget(jobId, info.keyId, delta, entry);
      mkdirSync(resultsDirOf(jobId), { recursive: true, mode: 0o700 });
      atomicWrite(path, payload);
      const current = held.get(jobId) ?? entry;
      if (existingSeq === undefined) {
        current.rows.set(row.id, seq);
      }
      track(jobId, {
        resultsBytes: current.resultsBytes + delta,
        inputsBytes: current.inputsBytes,
        keyId: current.keyId ?? info.keyId,
        rows: current.rows,
      });
    },

    hasRow(jobId, itemId) {
      resultsDirOf(jobId);
      return held.get(jobId)?.rows.has(itemId) ?? false;
    },
    rows(jobId) {
      const resultsDir = resultsDirOf(jobId);
      const entry = held.get(jobId);
      const info = options.jobInfo(jobId);
      if (
        info?.status === "completed" &&
        info.requestCount !== undefined &&
        existsSync(resultsDir) &&
        (entry?.rows.size ?? 0) !== info.requestCount
      ) {
        throw new BatchResultStoreCorrupt({
          message: "completed batch result row count does not match ledger",
          jobId,
          rowId: "<missing>",
        });
      }
      if (entry === undefined) {
        return [];
      }
      const ordered = [...entry.rows.entries()].sort((a, b) => a[1] - b[1]);
      const rows: BatchResultRow[] = [];
      for (const [rowId, seq] of ordered) {
        let raw: string;
        try {
          raw = readFileSync(rowPathOf(jobId, seq, rowId), "utf8");
        } catch {
          throw new BatchResultStoreCorrupt({
            message: "batch result row file is missing or unreadable",
            jobId,
            rowId,
          });
        }
        try {
          rows.push(JSON.parse(raw) as BatchResultRow);
        } catch {
          throw new BatchResultStoreCorrupt({
            message: "batch result row file is damaged",
            jobId,
            rowId,
          });
        }
      }
      return rows;
    },

    drop(jobId) {
      purgeJobFiles(jobId);
      release(jobId);
    },

    sweepExpired(now) {
      for (const jobId of [...held.keys()]) {
        const info = options.jobInfo(jobId);
        if (
          info !== undefined &&
          (info.finalizedAt === null ||
            !batchStatusIsTerminal(info.status) ||
            now < info.finalizedAt + BATCH_RESULT_TTL_MS)
        ) {
          continue;
        }
        purgeJobFiles(jobId);
        release(jobId);
      }
    },

    saveInputs(jobId, keyId, items) {
      const info = requireOwned(jobId, keyId);
      if (items.length === 0) {
        return;
      }
      // Last write wins for duplicate ids within one call; validate and serialize everything
      // before writing so a rejected save leaves no partial state behind.
      const prepared = new Map<
        string,
        { body: Readonly<Record<string, unknown>>; payload: string }
      >();
      for (const item of items) {
        if (typeof item.itemId !== "string" || !SAFE_JOB_ID.test(item.itemId)) {
          throw new InvalidInput({ message: "saveInputs requires a generated item id" });
        }
        if (typeof item.body !== "object" || item.body === null || Array.isArray(item.body)) {
          throw new InvalidInput({ message: "batch item body must be an object" });
        }
        let payload: string | undefined;
        try {
          payload = JSON.stringify(item.body);
        } catch {
          throw new InvalidInput({ message: "batch item body is not serializable" });
        }
        if (payload === undefined) {
          throw new InvalidInput({ message: "batch item body is not serializable" });
        }
        if (Buffer.byteLength(payload, "utf8") > BATCH_MAX_ITEM_BODY_BYTES) {
          throw new InvalidInput({ message: "batch item body exceeds 512KiB" });
        }
        prepared.set(item.itemId, { body: item.body, payload });
      }
      const entry = entryOf(jobId, info.keyId);
      let deltaBytes = 0;
      for (const itemId of prepared.keys()) {
        const bytes = Buffer.byteLength(prepared.get(itemId)!.payload, "utf8");
        deltaBytes += bytes - sizeOf(inputPathOf(jobId, itemId));
      }
      if (entry.inputsBytes + deltaBytes > BATCH_MAX_JOB_BODY_BYTES) {
        throw new InvalidInput({ message: "batch inputs exceed 32MiB" });
      }
      assertBudget(jobId, info.keyId, deltaBytes, entry);
      const inputsDir = inputsDirOf(jobId);
      mkdirSync(inputsDir, { recursive: true, mode: 0o700 });
      for (const [itemId, { payload }] of prepared) {
        const path = inputPathOf(jobId, itemId);
        const previousBytes = sizeOf(path);
        atomicWrite(path, payload);
        // Account immediately after every rename: a mid-write failure can never leave
        // unindexed bytes that would dodge the budget or the TTL until restart.
        const current = held.get(jobId) ?? entry;
        track(jobId, {
          resultsBytes: current.resultsBytes,
          inputsBytes: current.inputsBytes + Buffer.byteLength(payload, "utf8") - previousBytes,
          keyId: current.keyId ?? info.keyId,
          rows: current.rows,
        });
      }
    },

    readInput(jobId, keyId, itemId) {
      requireOwned(jobId, keyId);
      let raw: string;
      try {
        raw = readFileSync(inputPathOf(jobId, itemId), "utf8");
      } catch (cause) {
        if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
          return undefined;
        }
        throw new DatabaseError({ message: "batch input store read failed" });
      }
      try {
        const body: unknown = JSON.parse(raw);
        if (typeof body !== "object" || body === null || Array.isArray(body)) {
          throw new Error("shape");
        }
        return body as Readonly<Record<string, unknown>>;
      } catch {
        throw new DatabaseError({ message: "batch input store is corrupt" });
      }
    },

    removeInputs(jobId, keyId, itemId) {
      requireOwned(jobId, keyId);
      const entry = entryOf(jobId, keyId);
      if (itemId === undefined) {
        rmSync(inputsDirOf(jobId), { recursive: true, force: true });
        track(jobId, { ...entry, inputsBytes: 0 });
        return;
      }
      const path = inputPathOf(jobId, itemId);
      const bytes = sizeOf(path);
      if (bytes === 0) {
        return;
      }
      unlinkSync(path);
      track(jobId, { ...entry, inputsBytes: entry.inputsBytes - bytes });
    },
  };
}
