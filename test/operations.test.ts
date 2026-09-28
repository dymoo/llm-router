import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { openControlPlaneSqlite } from "../src/db/sqlite.ts";
import { CONTROL_PLANE_SCHEMA_VERSION } from "../src/db/migrate.ts";
import { apiKeys, batchItems, batchJobs, batchRemotes, requests } from "../src/db/schema.ts";
import { createBatchLedger } from "../src/batch/ledger.ts";
import { eq } from "drizzle-orm";

function command(script: string, args: string[], database: string) {
  return spawnSync(process.execPath, [`scripts/${script}.mjs`, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, SQLITE_PATH: database },
    encoding: "utf8",
  });
}
function keyName(path: string) {
  const opened = openControlPlaneSqlite(path);
  try {
    return opened.db.select({ name: apiKeys.name }).from(apiKeys).get()?.name;
  } finally {
    opened.sqlite.close();
  }
}
/** Fixture seam: a lone control-plane database with one identified key. */
function insertKey(database: string, name: string) {
  const opened = openControlPlaneSqlite(database);
  try {
    opened.db
      .insert(apiKeys)
      .values({
        id: "key",
        prefix: "test",
        digest: "test",
        name,
        policyJson: "{}",
        createdAt: 1,
        version: 1,
      })
      .run();
  } finally {
    opened.sqlite.close();
  }
}

/**
 * Test seam: a point lookup that must hit — narrows `T | undefined` to `T` with a runtime
 * assertion instead of casting the raw row (`Record<string, SQLOutputValue>`) to an ad-hoc
 * shape, which TypeScript (rightly) rejects as a non-overlapping conversion.
 */
function expectRow<T>(row: T | undefined, expectation: string): T {
  assert.ok(row !== undefined, `expected ${expectation}`);
  return row;
}

test("online backup includes committed WAL and offline restore preserves a previous snapshot", () => {
  const directory = mkdtempSync(join(tmpdir(), "hub-backup-"));
  const database = join(directory, "control.sqlite");
  const snapshot = join(directory, "snapshot.sqlite");
  const opened = openControlPlaneSqlite(database);
  try {
    opened.db
      .insert(apiKeys)
      .values({
        id: "key",
        prefix: "test",
        digest: "test",
        name: "original",
        policyJson: "{}",
        createdAt: 1,
        version: 1,
      })
      .run();
    const copied = command("backup", [snapshot], database);
    assert.equal(copied.status, 0, copied.stderr);
    assert.equal(keyName(snapshot), "original");
    assert.equal(statSync(snapshot).mode & 0o777, 0o600);
    opened.db.update(apiKeys).set({ name: "changed" }).where(eq(apiKeys.id, "key")).run();
    assert.notEqual(command("backup", [snapshot], database).status, 0);
    assert.equal(keyName(snapshot), "original");
    opened.sqlite.close();
    assert.notEqual(command("restore", [snapshot], database).status, 0);
    assert.equal(keyName(database), "changed");
    const restored = command("restore", ["--replace", "--offline", snapshot], database);
    assert.equal(restored.status, 0, restored.stderr);
    assert.equal(keyName(database), "original");
    assert.equal(statSync(database).mode & 0o777, 0o600);
    const previous = readdirSync(directory).find((name) => name.includes("before-restore"));
    assert.ok(previous);
    assert.equal(keyName(join(directory, previous)), "changed");
  } finally {
    try {
      opened.sqlite.close();
    } catch {
      /* already closed for offline restore */
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("foreign database restore is refused without changing the destination", () => {
  const directory = mkdtempSync(join(tmpdir(), "hub-restore-invalid-"));
  const database = join(directory, "control.sqlite");
  const foreign = join(directory, "foreign.sqlite");
  const opened = openControlPlaneSqlite(database);
  opened.db
    .insert(apiKeys)
    .values({
      id: "key",
      prefix: "test",
      digest: "test",
      name: "keep",
      policyJson: "{}",
      createdAt: 1,
      version: 1,
    })
    .run();
  opened.sqlite.close();
  const other = new DatabaseSync(foreign);
  other.exec("CREATE TABLE unrelated (value TEXT)");
  other.close();
  try {
    assert.notEqual(command("restore", ["--replace", "--offline", foreign], database).status, 0);
    assert.equal(keyName(database), "keep");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("v5 databases are accepted while inconsistent or newer schema versions are refused", () => {
  const directory = mkdtempSync(join(tmpdir(), "hub-ops-version-"));
  const database = join(directory, "control.sqlite");
  const target = join(directory, "target.sqlite");
  const inconsistent = join(directory, "inconsistent.sqlite");
  const future = join(directory, "future.sqlite");
  insertKey(database, "v5-key");
  const next = CONTROL_PLANE_SCHEMA_VERSION + 1;
  try {
    // v5 acceptance: the on-disk stamps equal the migrate.ts source of truth, and the
    // scripts accept such a database for backup.
    const probe = new DatabaseSync(database, { readOnly: true });
    const stamped = expectRow(
      probe.prepare("SELECT value FROM settings WHERE key = 'schema_version'").get(),
      "settings.schema_version",
    );
    const pragma = expectRow(probe.prepare("PRAGMA user_version").get(), "PRAGMA user_version");
    probe.close();
    assert.equal(Number(stamped.value), CONTROL_PLANE_SCHEMA_VERSION);
    assert.equal(pragma.user_version, CONTROL_PLANE_SCHEMA_VERSION);
    const snapshot = join(directory, "v5.sqlite");
    assert.equal(command("backup", [snapshot], database).status, 0);

    // settings.schema_version diverging from PRAGMA user_version is refused fail-closed
    // and the destination is left untouched.
    copyFileSync(database, target);
    copyFileSync(database, inconsistent);
    const diverged = new DatabaseSync(inconsistent);
    diverged.exec(`PRAGMA user_version = ${next}`);
    diverged.close();
    const refusedDiverged = command("restore", ["--replace", "--offline", inconsistent], target);
    assert.notEqual(refusedDiverged.status, 0, refusedDiverged.stderr);
    assert.equal(keyName(target), "v5-key");

    // A consistent database stamped newer than the supported migrations is refused by
    // both backup and restore.
    copyFileSync(database, future);
    const newer = new DatabaseSync(future);
    newer.prepare("UPDATE settings SET value = ? WHERE key = 'schema_version'").run(String(next));
    newer.exec(`PRAGMA user_version = ${next}`);
    newer.close();
    assert.notEqual(command("backup", [join(directory, "never.sqlite")], future).status, 0);
    const refusedNewer = command("restore", ["--replace", "--offline", future], target);
    assert.notEqual(refusedNewer.status, 0, refusedNewer.stderr);
    assert.equal(keyName(target), "v5-key");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("restore quarantines pending batch state while the original backup stays untouched", () => {
  const directory = mkdtempSync(join(tmpdir(), "hub-restore-batch-"));
  const database = join(directory, "control.sqlite");
  const snapshot = join(directory, "snapshot.sqlite");
  const probe = join(directory, "probe.sqlite");
  const opened = openControlPlaneSqlite(database);
  try {
    opened.db
      .insert(apiKeys)
      .values({
        id: "key",
        prefix: "test",
        digest: "test",
        name: "keeper",
        policyJson: "{}",
        createdAt: 1,
        version: 1,
      })
      .run();
    opened.db
      .insert(batchJobs)
      .values([
        {
          id: "job-queued",
          keyId: "key",
          model: "m",
          status: "queued",
          completionWindowMs: 60_000,
          createdAt: 1,
          spillAt: 2,
          requestCountsTotal: 4,
          requestCountsCompleted: 1,
          requestCountsFailed: 0,
        },
        {
          id: "job-cancelling",
          keyId: "key",
          model: "m",
          status: "cancelling",
          completionWindowMs: 60_000,
          createdAt: 1,
          spillAt: 2,
          requestCountsTotal: 0,
          requestCountsCompleted: 0,
          requestCountsFailed: 0,
        },
        {
          id: "job-pending-remote",
          keyId: "key",
          model: "m",
          status: "in_progress",
          completionWindowMs: 60_000,
          createdAt: 1,
          spillAt: 2,
          requestCountsTotal: 1,
          requestCountsCompleted: 0,
          requestCountsFailed: 0,
        },
      ])
      .run();
    opened.db
      .insert(batchRemotes)
      .values([
        {
          id: "rm-intended",
          jobId: "job-queued",
          groupKey: "g1",
          intent: "intended",
          submitToken: "token-1",
          createdAt: 1,
        },
        {
          id: "rm-confirmed",
          jobId: "job-pending-remote",
          groupKey: "g2",
          intent: "confirmed",
          submitToken: "token-2",
          remoteBatchId: "upstream-42",
          createdAt: 1,
          confirmedAt: 10,
        },
      ])
      .run();
    opened.db
      .insert(requests)
      .values([
        {
          id: "req-local",
          keyId: "key",
          startedAt: 1,
          leaseExpiresAt: 1_000_000,
          status: "running",
          deferred: 1,
          priority: "throughput",
          providerReportedUsd: 1.23,
          estimatedCostUsd: 0.5,
        },
        {
          id: "req-remote",
          keyId: "key",
          startedAt: 1,
          leaseExpiresAt: 1_000_000,
          status: "running",
          deferred: 1,
          priority: "throughput",
          providerReportedUsd: 4.56,
          estimatedCostUsd: 2,
        },
        {
          // Stuck combination per BatchLedger: an item the boot sweep already
          // interrupted keeps its request_id, and its deferred binding has no other
          // finalization path.
          id: "req-stuck",
          keyId: "key",
          startedAt: 1,
          leaseExpiresAt: 1_000_000,
          status: "running",
          deferred: 1,
          priority: "throughput",
          providerReportedUsd: 7.89,
          estimatedCostUsd: 3,
        },
      ])
      .run();
    opened.db
      .insert(batchItems)
      .values([
        {
          id: "item-queued",
          jobId: "job-queued",
          customId: "c1",
          status: "queued",
          createdAt: 1,
        },
        {
          id: "item-interrupted",
          jobId: "job-queued",
          customId: "c5",
          status: "interrupted",
          errorCode: "batch_interrupted",
          createdAt: 1,
          finishedAt: 3,
          requestId: "req-stuck",
        },
        {
          id: "item-running-local",
          jobId: "job-queued",
          customId: "c2",
          status: "running",
          createdAt: 1,
          dispatchedAt: 2,
          requestId: "req-local",
        },
        {
          id: "item-done",
          jobId: "job-queued",
          customId: "c3",
          status: "completed",
          createdAt: 1,
          finishedAt: 3,
        },
        {
          id: "item-running-remote",
          jobId: "job-pending-remote",
          customId: "c4",
          status: "running",
          createdAt: 1,
          dispatchedAt: 2,
          remoteId: "rm-confirmed",
          requestId: "req-remote",
        },
      ])
      .run();
    opened.sqlite.close();

    const copied = command("backup", [snapshot], database);
    assert.equal(copied.status, 0, copied.stderr);
    const before = createHash("sha256").update(readFileSync(snapshot)).digest("hex");

    const restored = command("restore", ["--replace", "--offline", snapshot], database);
    assert.equal(restored.status, 0, restored.stderr);

    // The original backup is never mutated by the restore quarantine.
    const after = createHash("sha256").update(readFileSync(snapshot)).digest("hex");
    assert.equal(after, before);
    // Key identity survives the round trip.
    assert.equal(keyName(database), "keeper");

    const raw = new DatabaseSync(database, { readOnly: true });
    try {
      const itemById = raw.prepare(
        "SELECT status, error_code, finished_at FROM batch_items WHERE id = ?",
      );
      const queued = expectRow(itemById.get("item-queued"), "item-queued");
      assert.equal(queued.status, "interrupted");
      assert.equal(queued.error_code, "restore_review_required");
      assert.ok(queued.finished_at !== null);
      const local = expectRow(itemById.get("item-running-local"), "item-running-local");
      assert.equal(local.status, "interrupted");
      assert.equal(local.error_code, "restore_review_required");
      // Terminal work is untouched.
      assert.equal(expectRow(itemById.get("item-done"), "item-done").status, "completed");
      // A running item owned by a confirmed remote survives for the re-poll.
      assert.equal(
        expectRow(itemById.get("item-running-remote"), "item-running-remote").status,
        "running",
      );

      const remoteById = raw.prepare(
        "SELECT intent, remote_batch_id FROM batch_remotes WHERE id = ?",
      );
      const intended = expectRow(remoteById.get("rm-intended"), "rm-intended");
      // The snapshot-time intent may already have POSTed: ambiguous, never re-posted.
      assert.equal(intended.intent, "unknown");
      assert.equal(intended.remote_batch_id, null);
      // The proven upstream id is preserved for re-polling.
      const confirmed = expectRow(remoteById.get("rm-confirmed"), "rm-confirmed");
      assert.equal(confirmed.intent, "confirmed");
      assert.equal(confirmed.remote_batch_id, "upstream-42");

      // Linked running requests are finalized with the item (deferred rows would
      // otherwise stay running forever — stale-lease recovery skips them), and stored
      // spend metadata is preserved.
      const linked = expectRow(
        raw
          .prepare(
            "SELECT status, error_code, finished_at, provider_reported_usd, estimated_cost_usd, deferred FROM requests WHERE id = ?",
          )
          .get("req-local"),
        "req-local",
      );
      assert.equal(linked.status, "abandoned");
      assert.equal(linked.error_code, "restore_review_required");
      assert.ok(linked.finished_at !== null);
      assert.equal(linked.provider_reported_usd, 1.23);
      assert.equal(linked.estimated_cost_usd, 0.5);
      assert.equal(linked.deferred, 1);
      // The request linked to the confirmed-remote survivor keeps running for re-poll.
      const remoteLinked = expectRow(
        raw.prepare("SELECT status FROM requests WHERE id = ?").get("req-remote"),
        "req-remote",
      );
      assert.equal(remoteLinked.status, "running");
      // A request linked to an already-boot-swept interrupted item is finalized too —
      // deferred bindings on interrupted items have no other finalization path.
      const stuck = expectRow(
        raw
          .prepare("SELECT status, error_code, finished_at FROM requests WHERE id = ?")
          .get("req-stuck"),
        "req-stuck",
      );
      assert.equal(stuck.status, "abandoned");
      assert.equal(stuck.error_code, "restore_review_required");
      assert.ok(stuck.finished_at !== null);
      // The interrupted item itself keeps its original boot-sweep provenance.
      const interrupted = expectRow(
        raw
          .prepare("SELECT status, error_code FROM batch_items WHERE id = ?")
          .get("item-interrupted"),
        "item-interrupted",
      );
      assert.equal(interrupted.status, "interrupted");
      assert.equal(interrupted.error_code, "batch_interrupted");

      const jobById = raw.prepare(
        "SELECT status, error_code, finalized_at FROM batch_jobs WHERE id = ?",
      );
      const failed = expectRow(jobById.get("job-queued"), "job-queued");
      assert.equal(failed.status, "failed");
      assert.equal(failed.error_code, "restore_review_required");
      assert.ok(failed.finalized_at !== null);
      const cancelled = expectRow(jobById.get("job-cancelling"), "job-cancelling");
      assert.equal(cancelled.status, "cancelled");
      assert.equal(cancelled.error_code, "restore_review_required");
      // The job owning the unharvested confirmed remote stays nonterminal so
      // pollKnown's completion can land after the restore.
      const pending = expectRow(jobById.get("job-pending-remote"), "job-pending-remote");
      assert.equal(pending.status, "in_progress");
      assert.equal(pending.error_code, null);
    } finally {
      raw.close();
    }

    // Replay proof. Ordinary restart recovery on the untouched backup keeps the queued
    // item claimable; the restored database cannot replay it.
    copyFileSync(snapshot, probe);
    const probeOpen = openControlPlaneSqlite(probe);
    const ordinaryClaim = createBatchLedger(probeOpen.db).claim(10);
    probeOpen.sqlite.close();
    assert.deepEqual(
      ordinaryClaim.map((entry) => entry.customId),
      ["c1"],
    );

    const restoredOpen = openControlPlaneSqlite(database);
    try {
      assert.deepEqual(createBatchLedger(restoredOpen.db).claim(10), []);
      // Provenance distinguishes quarantine from ordinary crash recovery.
      const quarantined = restoredOpen.db
        .select({ errorCode: batchItems.errorCode })
        .from(batchItems)
        .where(eq(batchItems.id, "item-queued"))
        .get();
      assert.equal(quarantined?.errorCode, "restore_review_required");
    } finally {
      restoredOpen.sqlite.close();
    }
  } finally {
    try {
      opened.sqlite.close();
    } catch {
      /* already closed */
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
