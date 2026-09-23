import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  BatchResultBudgetExceeded,
  BatchResultStoreCorrupt,
  BATCH_RESULT_TTL_MS,
  createBatchResultStore,
  type BatchResultJobInfo,
  type BatchResultRow,
} from "../../src/batch/results.ts";
import { InvalidInput } from "../../src/errors.ts";

const dirs: string[] = [];

after(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "llm-router-batch-results-"));
  dirs.push(dir);
  return dir;
}

/** Fixed-width fields keep every row the same byte length for exact budget math. */
const okRow = (n: number): BatchResultRow => ({
  id: `batch_req_${String(n).padStart(4, "0")}`,
  custom_id: `c${String(n).padStart(4, "0")}`,
  response: {
    status_code: 200,
    request_id: `req-${String(n).padStart(4, "0")}`,
    body: { choices: [] },
  },
  error: null,
});

const errRow = (n: number): BatchResultRow => ({
  id: `batch_req_${String(n).padStart(4, "0")}`,
  custom_id: `c${String(n).padStart(4, "0")}`,
  response: null,
  error: { code: "boom" },
});

const info = (overrides: Partial<BatchResultJobInfo> = {}): BatchResultJobInfo => ({
  keyId: "key-a",
  status: "in_progress",
  finalizedAt: null,
  ...overrides,
});

describe("BatchResultStore", () => {
  it("persists rows as private per-row files outside the metadata database", () => {
    const directory = tempDir();
    const store = createBatchResultStore({ directory, jobInfo: () => info() });
    store.append("batch_a", okRow(1));
    store.append("batch_a", errRow(2));
    const resultsDir = join(directory, "batch_a.results");
    assert.equal(existsSync(resultsDir), true);
    assert.equal(statSync(resultsDir).mode & 0o777, 0o700);
    const files = readdirSync(resultsDir);
    assert.equal(files.length, 2, "one private file per row");
    for (const file of files) {
      assert.equal(statSync(join(resultsDir, file)).mode & 0o777, 0o600);
    }
    const rows = store.rows("batch_a");
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], okRow(1));
    assert.deepEqual(rows[1], errRow(2));
    store.append("batch_a", okRow(1));
    assert.equal(store.rows("batch_a").length, 2, "re-appending a row id is idempotent");
    assert.equal(
      readdirSync(directory).filter((name) => name.endsWith(".jsonl")).length,
      0,
      "no append-log file exists to tear",
    );
    assert.equal(
      readdirSync(directory).filter((name) => name.endsWith(".sqlite")).length,
      0,
      "the metadata database never lives in the result store",
    );
  });

  it("enforces response XOR error, ledger membership and path-safe ids", () => {
    const directory = tempDir();
    const store = createBatchResultStore({
      directory,
      jobInfo: (jobId) => (jobId === "batch_a" ? info() : undefined),
    });
    assert.throws(
      () =>
        store.append("batch_a", {
          id: "batch_req_0001",
          custom_id: "c0001",
          response: { status_code: 200, request_id: null, body: {} },
          error: { nope: true },
        }),
      InvalidInput,
      "response and error together is rejected",
    );
    assert.throws(
      () =>
        store.append("batch_a", {
          id: "batch_req_0001",
          custom_id: "c0001",
          response: null,
          error: null,
        }),
      InvalidInput,
      "neither response nor error is rejected",
    );
    assert.throws(() => store.append("batch_unknown", okRow(1)), InvalidInput);
    assert.throws(() => store.append("../escape", okRow(1)), InvalidInput);
    assert.throws(
      () => store.append("batch_a", { ...okRow(1), id: "../evil" }),
      InvalidInput,
      "path-unsafe row ids are refused",
    );
    assert.equal(store.rows("batch_a").length, 0);
  });

  it("reads retry-safely; drop is the DELETE acknowledgement", () => {
    const directory = tempDir();
    const store = createBatchResultStore({ directory, jobInfo: () => info() });
    store.append("batch_a", okRow(1));
    store.append("batch_a", okRow(2));
    store.saveInputs("batch_a", "key-a", [
      { itemId: "batch_req_0001", body: { messages: [{ role: "user", content: "hi" }] } },
    ]);
    const resultsFile = join(directory, "batch_a.results");
    const inputsFile = join(directory, "batch_a.inputs");
    assert.equal(store.rows("batch_a").length, 2, "first read");
    assert.equal(store.rows("batch_a").length, 2, "second read is identical — nothing consumed");
    assert.equal(existsSync(resultsFile), true, "reading never destroys results");
    assert.equal(existsSync(inputsFile), true);

    store.drop("batch_a");
    assert.equal(existsSync(resultsFile), false, "DELETE purges results");
    assert.equal(existsSync(inputsFile), false, "DELETE also purges inputs");
    assert.deepEqual(store.rows("batch_a"), []);
    store.drop("batch_a");
    assert.equal(existsSync(resultsFile), false, "drop of a missing job is a no-op");
  });

  it("holds durable inputs with ownership checks and targeted removal", () => {
    const directory = tempDir();
    // Scoped stub: only batch_a exists in the ledger, so the unknown-job contract below is real.
    const store = createBatchResultStore({
      directory,
      jobInfo: (jobId) => (jobId === "batch_a" ? info() : undefined),
    });
    store.saveInputs("batch_a", "key-a", [
      { itemId: "batch_req_0001", body: { messages: [{ role: "user", content: "one" }] } },
      { itemId: "batch_req_0002", body: { messages: [{ role: "user", content: "two" }] } },
    ]);
    const file = join(directory, "batch_a.inputs");
    assert.equal(statSync(file).mode & 0o777, 0o700, "input directories are private");
    assert.equal(
      statSync(join(file, "batch_req_0001.json")).mode & 0o777,
      0o600,
      "per-item files are private",
    );
    assert.deepEqual(store.readInput("batch_a", "key-a", "batch_req_0001"), {
      messages: [{ role: "user", content: "one" }],
    });
    assert.equal(
      store.readInput("batch_a", "key-a", "batch_req_missing"),
      undefined,
      "unknown item reads as missing, not an error",
    );

    // Per-key isolation: another key can neither read nor mutate this job's bodies.
    assert.throws(() => store.readInput("batch_a", "key-b", "batch_req_0001"), InvalidInput);
    assert.throws(
      () => store.saveInputs("batch_a", "key-b", [{ itemId: "batch_req_0003", body: {} }]),
      InvalidInput,
    );
    assert.throws(() => store.removeInputs("batch_a", "key-b"), InvalidInput);
    assert.throws(() => store.readInput("batch_unknown", "key-a", "x"), InvalidInput);

    // Per-item overwrite: re-saving one item rewrites only that file (bounded O(1) work).
    const stableSibling = statSync(join(file, "batch_req_0002.json")).ino;
    store.saveInputs("batch_a", "key-a", [
      { itemId: "batch_req_0001", body: { messages: [{ role: "user", content: "edited" }] } },
    ]);
    assert.deepEqual(store.readInput("batch_a", "key-a", "batch_req_0001"), {
      messages: [{ role: "user", content: "edited" }],
    });
    assert.deepEqual(store.readInput("batch_a", "key-a", "batch_req_0002"), {
      messages: [{ role: "user", content: "two" }],
    });
    assert.equal(
      statSync(join(file, "batch_req_0002.json")).ino,
      stableSibling,
      "sibling bodies are never rewritten",
    );

    store.removeInputs("batch_a", "key-a", "batch_req_0001");
    assert.equal(store.readInput("batch_a", "key-a", "batch_req_0001"), undefined);
    assert.notEqual(store.readInput("batch_a", "key-a", "batch_req_0002"), undefined);
    assert.equal(
      statSync(join(file, "batch_req_0002.json")).ino,
      stableSibling,
      "removing one item unlinks only that file",
    );
    store.removeInputs("batch_a", "key-a");
    assert.equal(existsSync(file), false, "whole-job removal clears the directory");
  });

  it("rejects oversized bodies and an oversized merged input set", () => {
    const directory = tempDir();
    const store = createBatchResultStore({ directory, jobInfo: () => info() });
    assert.throws(
      () =>
        store.saveInputs("batch_a", "key-a", [
          { itemId: "batch_req_0001", body: { blob: "x".repeat(600 * 1024) } },
        ]),
      InvalidInput,
      "512KiB per-item cap",
    );
    const many = Array.from({ length: 70 }, (_, index) => ({
      itemId: `batch_req_${String(index).padStart(4, "0")}`,
      body: { blob: "x".repeat(500 * 1024) },
    }));
    assert.throws(() => store.saveInputs("batch_a", "key-a", many), InvalidInput, "32MiB job cap");
    assert.equal(
      existsSync(join(directory, "batch_a.inputs")),
      false,
      "a rejected save writes nothing",
    );
  });

  it("expires results AND inputs 24h after any terminal job", () => {
    const directory = tempDir();
    const finalizedAt = 1_700_000_000_000;
    const infos = new Map<string, BatchResultJobInfo>([
      ["batch_done", info({ status: "completed", finalizedAt })],
      ["batch_failed", info({ status: "failed", finalizedAt })],
      ["batch_open", info({ status: "in_progress", finalizedAt: null })],
    ]);
    const store = createBatchResultStore({ directory, jobInfo: (jobId) => infos.get(jobId) });
    store.append("batch_done", okRow(1));
    store.saveInputs("batch_done", "key-a", [{ itemId: "batch_req_0001", body: { a: 1 } }]);
    store.saveInputs("batch_failed", "key-a", [{ itemId: "batch_req_0001", body: { b: 2 } }]);
    store.saveInputs("batch_open", "key-a", [{ itemId: "batch_req_0001", body: { c: 3 } }]);

    store.sweepExpired(finalizedAt + BATCH_RESULT_TTL_MS - 1);
    assert.equal(store.rows("batch_done").length, 1, "rows survive until the TTL lapses");
    assert.notEqual(
      store.readInput("batch_failed", "key-a", "batch_req_0001"),
      undefined,
      "failed-job inputs survive until the TTL lapses",
    );
    store.sweepExpired(finalizedAt + BATCH_RESULT_TTL_MS);
    assert.deepEqual(store.rows("batch_done"), []);
    assert.equal(
      store.readInput("batch_failed", "key-a", "batch_req_0001"),
      undefined,
      "TTL covers inputs of failed jobs",
    );
    assert.notEqual(
      store.readInput("batch_open", "key-a", "batch_req_0001"),
      undefined,
      "non-terminal jobs never expire",
    );
  });

  it("bounds held bytes per job and per key, inputs included", () => {
    const directory = tempDir();
    // Measure one row with a scratch store, then drop it so budgets start clean.
    const probe = createBatchResultStore({ directory, jobInfo: () => info() });
    probe.append("batch_probe", okRow(9_999));
    const probeDir = join(directory, "batch_probe.results");
    const rowBytes = statSync(join(probeDir, readdirSync(probeDir)[0]!)).size;
    probe.drop("batch_probe");

    const store = createBatchResultStore({
      directory,
      jobInfo: (jobId) => (jobId === "batch_other-key" ? info({ keyId: "key-b" }) : info()),
      jobBudgetBytes: rowBytes * 3,
      keyBudgetBytes: rowBytes * 4,
    });

    let written = 0;
    let jobError: unknown;
    try {
      for (let i = 0; i < 50; i += 1) {
        store.append("batch_a", okRow(i));
        written += 1;
      }
    } catch (error) {
      jobError = error;
    }
    assert.ok(jobError instanceof BatchResultBudgetExceeded, "job breach throws a typed failure");
    assert.equal(jobError.scope, "job");
    assert.equal(jobError.limitBytes, rowBytes * 3);
    assert.equal(written, 3, "the per-job budget bound the store");
    assert.equal(store.rows("batch_a").length, written, "rows written before the breach are kept");

    // Same key: job-b may write while key-a has one row of headroom left, then the key bites.
    let keyError: unknown;
    try {
      for (let i = 0; i < 50; i += 1) {
        store.append("batch_b", okRow(i));
      }
    } catch (error) {
      keyError = error;
    }
    assert.ok(keyError instanceof BatchResultBudgetExceeded, "key breach throws a typed failure");
    assert.equal(keyError.scope, "key");
    assert.equal(keyError.limitBytes, rowBytes * 4);
    assert.equal(store.rows("batch_b").length, 1, "only the headroom row was held");

    // A different key is isolated from key-a's budget usage.
    let otherError: unknown;
    try {
      for (let i = 0; i < 50; i += 1) {
        store.append("batch_other-key", okRow(i));
      }
    } catch (error) {
      otherError = error;
    }
    assert.ok(otherError instanceof BatchResultBudgetExceeded);
    assert.equal(otherError.scope, "job");
    assert.equal(
      store.rows("batch_other-key").length,
      3,
      "key-b is unaffected by key-a's fullness",
    );

    // Input bytes count toward the same budgets.
    const inputsStore = createBatchResultStore({
      directory,
      jobInfo: () => info(),
      jobBudgetBytes: 500,
      keyBudgetBytes: 1_000_000,
    });
    assert.throws(
      () =>
        inputsStore.saveInputs("batch_inputs", "key-a", [
          { itemId: "batch_req_0001", body: { blob: "x".repeat(600) } },
        ]),
      BatchResultBudgetExceeded,
      "inputs count toward the per-job storage budget",
    );
  });

  it("accounts every file the moment it lands, even when a later write fails", () => {
    const directory = tempDir();
    const firstBody = { messages: [{ role: "user", content: "one" }] };
    const secondBody = { a: "x".repeat(8) };
    const firstBytes = Buffer.byteLength(JSON.stringify(firstBody));
    const secondBytes = Buffer.byteLength(JSON.stringify(secondBody));
    const store = createBatchResultStore({
      directory,
      jobInfo: () => info(),
      jobBudgetBytes: firstBytes + secondBytes,
      keyBudgetBytes: 1_000_000,
    });
    // Fault injection: the second item's destination is a directory, so its rename fails
    // mid-loop AFTER the first item already landed.
    mkdirSync(join(directory, "batch_a.inputs"), { recursive: true });
    mkdirSync(join(directory, "batch_a.inputs", "batch_req_0002.json"));
    assert.throws(() =>
      store.saveInputs("batch_a", "key-a", [
        { itemId: "batch_req_0001", body: firstBody },
        { itemId: "batch_req_0002", body: secondBody },
      ]),
    );
    assert.deepEqual(store.readInput("batch_a", "key-a", "batch_req_0001"), firstBody);
    // The landed file IS in the held-byte index: one more row breaches the job budget,
    // proving the partial save cannot dodge the quota until restart.
    assert.throws(
      () => store.append("batch_a", okRow(7)),
      (error: unknown) => error instanceof BatchResultBudgetExceeded && error.scope === "job",
      "partial writes stay accounted",
    );
  });

  it("rebuilds bytes and row index at restart and sweeps torn temp files", () => {
    const directory = tempDir();
    const rowBytes = Buffer.byteLength(JSON.stringify(okRow(1)));
    const jobInfo = () => info();
    const options = {
      directory,
      jobInfo,
      jobBudgetBytes: rowBytes * 2,
      keyBudgetBytes: 1_000_000,
    };
    const first = createBatchResultStore(options);
    first.append("batch_a", okRow(1));
    first.append("batch_a", okRow(2));

    // Crash debris from an interrupted write must not survive a restart.
    const resultsDir = join(directory, "batch_a.results");
    const staleTmp = join(resultsDir, "00000099-stale.json.tmp");
    writeFileSync(staleTmp, "partial");

    const reopened = createBatchResultStore(options);
    assert.equal(existsSync(staleTmp), false, "stale temp files are swept at restart");
    assert.equal(reopened.rows("batch_a").length, 2, "row index rebuilt from filenames");
    assert.throws(
      () => reopened.append("batch_a", okRow(3)),
      BatchResultBudgetExceeded,
      "byte budget rebuilt from disk",
    );
    reopened.append("batch_a", okRow(1));
    assert.equal(
      reopened.rows("batch_a").length,
      2,
      "idempotent re-append survives the rebuild (zero delta, same slot)",
    );
  });

  it("purges orphaned generated job content at restart and releases its key budget", () => {
    const directory = tempDir();
    const rowBytes = Buffer.byteLength(JSON.stringify(okRow(1)));
    const jobs = new Map<string, BatchResultJobInfo>([
      ["batch_orphan", info()],
      ["batch_live", info()],
    ]);
    const options = {
      directory,
      jobInfo: (jobId: string) => jobs.get(jobId),
      keyBudgetBytes: rowBytes * 2 + Buffer.byteLength(JSON.stringify({ note: "orphan" })),
    };
    const first = createBatchResultStore(options);
    first.append("batch_orphan", okRow(1));
    first.append("batch_live", okRow(1));
    first.saveInputs("batch_orphan", "key-a", [
      { itemId: "batch_req_0001", body: { note: "orphan" } },
    ]);
    mkdirSync(join(directory, "notes.results"));
    writeFileSync(join(directory, "notes.results", "keep.txt"), "unrelated");
    jobs.delete("batch_orphan");

    const reopened = createBatchResultStore(options);
    assert.equal(existsSync(join(directory, "batch_orphan.results")), false);
    assert.equal(existsSync(join(directory, "batch_orphan.inputs")), false);
    assert.equal(existsSync(join(directory, "notes.results", "keep.txt")), true);
    assert.deepEqual(reopened.rows("batch_live"), [okRow(1)]);
    reopened.append("batch_live", okRow(2));
    assert.deepEqual(reopened.rows("batch_live"), [okRow(1), okRow(2)]);
  });

  it("sweeps jobs removed from the ledger and frees held bytes without touching other jobs", () => {
    const directory = tempDir();
    const rowBytes = Buffer.byteLength(JSON.stringify(okRow(1)));
    const jobs = new Map<string, BatchResultJobInfo>([
      ["batch_orphan", info()],
      ["batch_live", info()],
    ]);
    const store = createBatchResultStore({
      directory,
      jobInfo: (jobId) => jobs.get(jobId),
      keyBudgetBytes: rowBytes * 2,
    });
    store.append("batch_orphan", okRow(1));
    store.append("batch_live", okRow(1));
    jobs.delete("batch_orphan");
    store.sweepExpired(Date.now());
    assert.equal(existsSync(join(directory, "batch_orphan.results")), false);
    store.append("batch_live", okRow(2));
    assert.deepEqual(store.rows("batch_live"), [okRow(1), okRow(2)]);
  });

  it("checks row existence from the index without reading a corrupt sibling", () => {
    const directory = tempDir();
    const options = { directory, jobInfo: () => info() };
    const first = createBatchResultStore(options);
    first.append("batch_a", okRow(1));
    first.append("batch_a", okRow(2));
    writeFileSync(
      join(directory, "batch_a.results", "00000000-batch_req_0001.json"),
      '{"id":"truncated',
    );
    const reopened = createBatchResultStore(options);
    assert.equal(reopened.hasRow("batch_a", "batch_req_0002"), true);
    assert.equal(reopened.hasRow("batch_a", "batch_req_0001"), true);
    assert.equal(reopened.hasRow("batch_a", "batch_req_missing"), false);
    assert.equal(reopened.hasRow("batch_unknown", "batch_req_0002"), false);
    assert.throws(() => reopened.rows("batch_a"), BatchResultStoreCorrupt);
    reopened.drop("batch_a");
    assert.equal(reopened.hasRow("batch_a", "batch_req_0002"), false);
  });

  it("fails loudly with a typed error instead of serving a partial result set", () => {
    const directory = tempDir();
    const store = createBatchResultStore({ directory, jobInfo: () => info() });
    store.append("batch_a", okRow(1));
    store.append("batch_a", okRow(2));
    const resultsDir = join(directory, "batch_a.results");
    const files = readdirSync(resultsDir);
    const damaged = files.find((file) => file.includes("00000000"))!;
    writeFileSync(join(resultsDir, damaged), '{"id":"truncated');

    assert.throws(
      () => store.rows("batch_a"),
      (error: unknown) =>
        error instanceof BatchResultStoreCorrupt &&
        error.jobId === "batch_a" &&
        error.rowId.length > 0,
      "corruption surfaces as a typed failure naming the damaged row",
    );
    assert.throws(() => store.rows("batch_a"), BatchResultStoreCorrupt, "and it is stable");
  });
  for (const missing of [0, 1, 2]) {
    it("detects a missing row at slot " + missing + " after restart", () => {
      const directory = tempDir();
      const jobInfo = () =>
        info({
          status: "completed",
          finalizedAt: 1_700_000_000_000,
          requestCount: 3,
        });
      const options = { directory, jobInfo };
      const first = createBatchResultStore(options);
      for (let n = 1; n <= 3; n += 1) first.append("batch_a", okRow(n));
      const resultsDir = join(directory, "batch_a.results");
      const file = readdirSync(resultsDir).find((name) =>
        name.startsWith(String(missing).padStart(8, "0")),
      )!;
      unlinkSync(join(resultsDir, file));

      const reopened = createBatchResultStore(options);
      assert.throws(
        () => reopened.rows("batch_a"),
        (error: unknown) => error instanceof BatchResultStoreCorrupt && error.jobId === "batch_a",
        "a restart must not silently return the remaining rows",
      );
    });
  }

  it("does not mistake an acknowledged purge for missing completed rows after restart", () => {
    const directory = tempDir();
    const jobInfo = () =>
      info({
        status: "completed",
        finalizedAt: 1_700_000_000_000,
        requestCount: 2,
      });
    const options = { directory, jobInfo };
    const first = createBatchResultStore(options);
    first.append("batch_a", okRow(1));
    first.append("batch_a", okRow(2));
    first.drop("batch_a");
    first.append("batch_expired", okRow(1));
    first.append("batch_expired", okRow(2));
    first.sweepExpired(1_700_000_000_000 + BATCH_RESULT_TTL_MS);
    const reopened = createBatchResultStore(options);
    assert.deepEqual(reopened.rows("batch_a"), []);
    assert.deepEqual(reopened.rows("batch_expired"), []);
  });
});
