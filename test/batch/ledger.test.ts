import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import { createBatchLedger } from "../../src/batch/ledger.ts";
import { openControlPlaneSqlite, type SqliteDatabase } from "../../src/db/sqlite.ts";
import { Conflict, DatabaseError, InvalidInput } from "../../src/errors.ts";
import type { BatchItemDraft, BatchJobDraft } from "../../src/domain.ts";

const dirs: string[] = [];

after(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "llm-router-batch-"));
  dirs.push(dir);
  return join(dir, "control.sqlite");
}

function insertKey(opened: SqliteDatabase["Service"], id: string): void {
  opened.sqlite
    .prepare(
      "INSERT INTO api_keys (id, prefix, digest, name, policy_json, created_at, expires_at, revoked_at, last_used_at, version) VALUES (?, ?, ?, ?, '{}', 1, NULL, NULL, NULL, 1)",
    )
    .run(id, `jrv_${id}`, `digest-${id}`, id);
}

function sequencer(): () => string {
  let seq = 0;
  return () => `n${++seq}`;
}

const T = 1_700_000_000_000;

const jobDraft = (overrides: Partial<BatchJobDraft> = {}): BatchJobDraft => ({
  keyId: "key-a",
  model: "test-model",
  completionWindowMs: 86_400_000,
  spillAt: T + 60_000,
  createdAt: T,
  ...overrides,
});

const queued = (customId: string): BatchItemDraft => ({ customId });

const preFailed = (customId: string, errorCode = "invalid"): BatchItemDraft => ({
  customId,
  status: "failed",
  errorCode,
});

describe("BatchLedger", () => {
  it("creates metadata-only jobs and items with wire ids and computed counts", () => {
    const path = tempPath();
    const opened = openControlPlaneSqlite(path);
    insertKey(opened, "key-a");
    const ledger = createBatchLedger(opened.db, { newId: sequencer() });

    const created = ledger.create({
      job: jobDraft(),
      items: [queued("c1"), queued("c2"), preFailed("c3")],
    });
    assert.match(created.job.id, /^batch_/);
    assert.equal(created.job.status, "validating");
    assert.deepEqual(created.job.requestCounts, { total: 3, completed: 0, failed: 1 });
    assert.equal(created.job.usage, null);
    assert.equal(created.items.length, 3);
    for (const item of created.items) {
      assert.match(item.id, /^batch_req_/);
      assert.equal(item.jobId, created.job.id);
    }
    const byCustom = new Map(created.items.map((item) => [item.customId, item]));
    assert.equal(byCustom.get("c3")?.status, "failed");
    assert.equal(byCustom.get("c3")?.errorCode, "invalid");
    assert.equal(byCustom.get("c3")?.finishedAt, T);
    assert.equal(byCustom.get("c1")?.dispatchedAt, null);
    // The metadata tables never hold prompt text.
    const row = opened.sqlite
      .prepare("SELECT * FROM batch_items WHERE custom_id = 'c1'")
      .get() as Record<string, unknown>;
    assert.equal("body" in row, false);
    assert.equal(JSON.stringify(row).includes("messages"), false);
    assert.deepEqual(ledger.counts(created.job.id), { total: 3, completed: 0, failed: 1 });
    opened.sqlite.close();
  });

  it("enforces job-wide custom_id identity and submit caps", () => {
    const path = tempPath();
    const opened = openControlPlaneSqlite(path);
    insertKey(opened, "key-a");
    insertKey(opened, "key-b");
    const ledger = createBatchLedger(opened.db, { newId: sequencer() });

    // Identity is durable correlation: valid/nonempty/bounded/unique across ALL items,
    // including pre-failed rows. Violations reject the whole job (Surface 400s pre-create).
    assert.throws(
      () => ledger.create({ job: jobDraft(), items: [queued("ok"), preFailed("ok")] }),
      InvalidInput,
      "duplicates are refused even against pre-failed rows",
    );
    assert.throws(
      () => ledger.create({ job: jobDraft(), items: [queued("ok"), preFailed("")] }),
      InvalidInput,
      "empty identity is refused",
    );
    assert.throws(
      () => ledger.create({ job: jobDraft(), items: [preFailed("x".repeat(129))] }),
      InvalidInput,
      "overlong identity is refused",
    );

    assert.throws(
      () =>
        ledger.create({
          job: jobDraft(),
          items: Array.from({ length: 1_001 }, (_, index) => queued(`c${index}`)),
        }),
      InvalidInput,
    );
    assert.throws(
      () => ledger.create({ job: jobDraft(), items: [queued("dup"), queued("dup")] }),
      InvalidInput,
      "queued duplicates are refused",
    );
    assert.throws(
      () => ledger.create({ job: jobDraft(), items: [queued(""), queued("ok")] }),
      InvalidInput,
    );
    assert.throws(
      () => ledger.create({ job: jobDraft(), items: [queued("x".repeat(129)), queued("ok")] }),
      InvalidInput,
    );
    assert.throws(
      () => ledger.create({ job: jobDraft(), items: [{ customId: "ok", status: "running" }] }),
      InvalidInput,
      "items can never be created running",
    );

    const jobs = [1, 2, 3, 4].map((index) =>
      ledger.create({ job: jobDraft({ id: `batch_full${index}` }), items: [queued(`j${index}`)] }),
    );
    assert.throws(() => ledger.create({ job: jobDraft(), items: [queued("over")] }), Conflict);
    // The cap is per key: key-b is unaffected while key-a is at four in-flight jobs.
    const other = ledger.create({
      job: jobDraft({ keyId: "key-b" }),
      items: [queued("other")],
    });
    assert.equal(other.job.keyId, "key-b");

    const first = jobs[0]!;
    const only = ledger.items(first.job.id)[0]!;
    ledger.completeItem(only.id, { status: "failed", errorCode: "boom" });
    ledger.setJobStatus(first.job.id, "failed", undefined, "boom");
    const fifth = ledger.create({ job: jobDraft(), items: [queued("fits")] });
    assert.equal(fifth.job.status, "validating");
    opened.sqlite.close();
  });

  it("claims atomically across two connections without overlap", () => {
    const path = tempPath();
    const first = openControlPlaneSqlite(path);
    insertKey(first, "key-a");
    const ledgerA = createBatchLedger(first.db, { newId: sequencer() });
    const second = openControlPlaneSqlite(path);
    const ledgerB = createBatchLedger(second.db, { newId: sequencer() });

    const created = ledgerA.create({
      job: jobDraft(),
      items: ["a", "b", "c", "d", "e", "f"].map((id) => queued(id)),
    });
    const claim1 = ledgerA.claim(2);
    const claim2 = ledgerB.claim(2);
    const claim3 = ledgerA.claim(10);
    const claimedIds = [...claim1, ...claim2, ...claim3].map((item) => item.id);
    assert.equal(claimedIds.length, 6);
    assert.equal(new Set(claimedIds).size, 6, "no item may be claimed twice");
    assert.deepEqual(new Set(claimedIds), new Set(created.items.map((item) => item.id)));
    for (const item of [...claim1, ...claim2, ...claim3]) {
      assert.equal(item.status, "running");
      assert.equal(typeof item.dispatchedAt, "number");
    }
    assert.equal(ledgerB.claim(10).length, 0, "running items are not claimable again");
    first.sqlite.close();
    second.sqlite.close();
  });

  it("claims only due work before the limit across two SQLite connections", () => {
    const path = tempPath();
    const first = openControlPlaneSqlite(path);
    insertKey(first, "key-a");
    const ledgerA = createBatchLedger(first.db, { newId: sequencer(), now: () => T + 100 });
    const second = openControlPlaneSqlite(path);
    const ledgerB = createBatchLedger(second.db, { now: () => T + 100 });

    const futureFirst = ledgerA.create({
      job: jobDraft({ id: "batch_future_first", createdAt: T - 400, spillAt: T + 1 }),
      items: [queued("future-a"), queued("future-b")],
    });
    const dueFirst = ledgerA.create({
      job: jobDraft({ id: "batch_due_first", createdAt: T - 300, spillAt: T }),
      items: [queued("due-a")],
    });
    const futureSecond = ledgerA.create({
      job: jobDraft({ id: "batch_future_second", createdAt: T - 200, spillAt: T + 1 }),
      items: [queued("future-c")],
    });
    const dueSecond = ledgerA.create({
      job: jobDraft({ id: "batch_due_second", createdAt: T - 100, spillAt: T, status: "queued" }),
      items: [queued("due-b"), queued("due-c")],
    });
    assert.deepEqual(ledgerA.claimDue(1, T - 1), [], "the equality boundary is not yet due");
    for (const invalid of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => ledgerA.claimDue(1, invalid), InvalidInput);
    }

    const firstClaim = ledgerA.claimDue(1, T);
    const secondClaim = ledgerB.claimDue(1, T);
    const remainingDue = ledgerA.claimDue(10, T);
    assert.deepEqual(
      [...firstClaim, ...secondClaim, ...remainingDue].map((item) => item.id),
      [dueFirst.items[0]!.id, dueSecond.items[0]!.id, dueSecond.items[1]!.id],
      "pre-due queued items cannot consume a slot ahead of due items",
    );
    assert.deepEqual(ledgerB.claimDue(10, T), [], "neither connection can re-claim running items");
    for (const item of [...firstClaim, ...secondClaim, ...remainingDue]) {
      assert.equal(item.status, "running");
      assert.equal(item.dispatchedAt, T + 100);
    }
    assert.deepEqual(
      [...ledgerA.items(futureFirst.job.id), ...ledgerB.items(futureSecond.job.id)].map((item) => [
        item.status,
        item.dispatchedAt,
      ]),
      [
        ["queued", null],
        ["queued", null],
        ["queued", null],
      ],
      "pre-due work remains untouched, not requeued or dispatched",
    );
    assert.deepEqual(
      ledgerB.claim(10).map((item) => item.id),
      [...futureFirst.items, ...futureSecond.items].map((item) => item.id),
      "ordinary idle claims still include pre-due work",
    );
    first.sqlite.close();
    second.sqlite.close();
  });

  it("refuses to claim while another connection holds the write lock", () => {
    const path = tempPath();
    const opened = openControlPlaneSqlite(path);
    insertKey(opened, "key-a");
    const ledger = createBatchLedger(opened.db, { newId: sequencer() });
    ledger.create({ job: jobDraft(), items: [queued("a"), queued("b")] });

    const rival = new DatabaseSync(path);
    rival.exec("BEGIN IMMEDIATE");
    assert.throws(() => ledger.claim(1), DatabaseError);
    rival.exec("ROLLBACK");
    rival.close();
    assert.equal(ledger.claim(10).length, 2, "claims resume after the lock releases");
    opened.sqlite.close();
  });

  it("applies the job state machine and refuses invalid transitions", () => {
    const path = tempPath();
    const opened = openControlPlaneSqlite(path);
    insertKey(opened, "key-a");
    const ledger = createBatchLedger(opened.db, { newId: sequencer() });

    const created = ledger.create({ job: jobDraft(), items: [queued("a"), queued("b")] });
    const jobId = created.job.id;

    assert.throws(
      () => ledger.setJobStatus(jobId, "cancelled"),
      Conflict,
      "must go via cancelling",
    );
    ledger.setJobStatus(jobId, "queued");
    ledger.setJobStatus(jobId, "in_progress");
    assert.throws(() => ledger.setJobStatus(jobId, "queued"), Conflict, "no backwards transitions");
    assert.throws(
      () => ledger.setJobStatus(jobId, "completed"),
      Conflict,
      "cannot complete with undispatched items",
    );
    assert.throws(
      () => ledger.setJobStatus(jobId, "finalizing"),
      Conflict,
      "cannot finalize with undispatched items",
    );

    const running = ledger.claim(2);
    assert.equal(running.length, 2);
    assert.throws(
      () => ledger.setJobStatus(jobId, "failed"),
      Conflict,
      "in-flight items drain first",
    );

    ledger.completeItem(running[0]!.id, { status: "completed", requestId: "req-1" });
    ledger.completeItem(running[1]!.id, { status: "failed", errorCode: "provider_failure" });
    assert.deepEqual(ledger.counts(jobId), { total: 2, completed: 1, failed: 1 });
    ledger.setJobStatus(jobId, "finalizing");
    ledger.setJobStatus(jobId, "completed", T + 5_000);
    assert.equal(ledger.job(jobId)?.finalizedAt, T + 5_000);

    assert.throws(
      () => ledger.completeItem(created.items[0]!.id, { status: "completed" }),
      Conflict,
      "completeItem on a terminal job is refused",
    );
    assert.throws(() => ledger.setJobStatus(jobId, "in_progress"), Conflict);
    assert.throws(() => ledger.requeue(created.items[0]!.id), Conflict);
    assert.equal(ledger.job(jobId)?.status, "completed");
    opened.sqlite.close();
  });

  it("cancels undispatched items on cancelling and lets in-flight work finish", () => {
    const path = tempPath();
    const opened = openControlPlaneSqlite(path);
    insertKey(opened, "key-a");
    const ledger = createBatchLedger(opened.db, { newId: sequencer() });

    const created = ledger.create({
      job: jobDraft(),
      items: [queued("a"), queued("b"), queued("c")],
    });
    ledger.setJobStatus(created.job.id, "queued");
    ledger.setJobStatus(created.job.id, "in_progress");
    const claimed = ledger.claim(1);
    assert.equal(claimed.length, 1);

    ledger.setJobStatus(created.job.id, "cancelling");
    const after = ledger.items(created.job.id);
    const byId = new Map(after.map((item) => [item.id, item]));
    assert.equal(byId.get(claimed[0]!.id)?.status, "running", "in-flight work is not preempted");
    assert.equal(
      after.filter((item) => item.status === "cancelled").length,
      2,
      "undispatched items are cancelled",
    );
    assert.equal(ledger.job(created.job.id)?.status, "cancelling");

    ledger.completeItem(claimed[0]!.id, { status: "completed" });
    const closed = ledger.job(created.job.id);
    assert.equal(closed?.status, "cancelled", "last in-flight item closes the cancellation");
    assert.equal(typeof closed?.finalizedAt, "number");
    opened.sqlite.close();
  });

  it("requeues local running items but never remotely assigned or terminal ones", () => {
    const path = tempPath();
    const opened = openControlPlaneSqlite(path);
    insertKey(opened, "key-a");
    const ledger = createBatchLedger(opened.db, { newId: sequencer() });
    const created = ledger.create({ job: jobDraft(), items: [queued("a"), queued("b")] });
    const claimed = ledger.claim(2);
    assert.equal(claimed.length, 2);
    assert.equal(claimed[0]?.status, "running");
    ledger.requeue(claimed[0]!.id);
    let items = ledger.items(created.job.id);
    assert.equal(items.find((item) => item.id === claimed[0]!.id)?.status, "queued");
    assert.equal(items.find((item) => item.id === claimed[0]!.id)?.dispatchedAt, null);

    // The other item goes remote: requeue must refuse it (possibly executed, no blind replay).
    const remote = ledger.beginRemote(created.job.id, {
      groupKey: "compat-1",
      submitToken: "token-1",
      itemIds: [claimed[1]!.id],
    });
    assert.equal(remote.intent, "intended");
    assert.equal(ledger.itemsForRemote(remote.id).length, 1);
    assert.throws(
      () => ledger.requeue(claimed[1]!.id),
      Conflict,
      "remote assignment blocks replay",
    );

    items = ledger.items(created.job.id);
    const local = items.find((item) => item.id === claimed[0]!.id)!;
    ledger.completeItem(local.id, { status: "completed" });
    assert.throws(() => ledger.requeue(local.id), Conflict, "terminal items cannot requeue");
    opened.sqlite.close();
  });

  it("requeues only after the linked request is terminal and clears the old identity", () => {
    const path = tempPath();
    const opened = openControlPlaneSqlite(path);
    insertKey(opened, "key-a");
    const ledger = createBatchLedger(opened.db, { newId: sequencer() });
    const created = ledger.create({ job: jobDraft(), items: [queued("a")] });
    const claimed = ledger.claim(1);
    const itemId = claimed[0]!.id;

    // Simulate an attach: the running item points at a live request.
    opened.sqlite
      .prepare(
        "INSERT INTO requests (id, key_id, started_at, lease_expires_at, status) VALUES (?, ?, ?, ?, 'running')",
      )
      .run("req-old", "key-a", T, T + 60_000);
    opened.sqlite
      .prepare(
        "UPDATE batch_items SET request_id = 'req-old', deployment_id = 'dep-1', error_code = 'stale' WHERE id = ?",
      )
      .run(itemId);

    assert.throws(
      () => ledger.requeue(itemId),
      Conflict,
      "a running linked request is never orphaned",
    );

    opened.sqlite
      .prepare("UPDATE requests SET status = 'success', finished_at = ? WHERE id = ?")
      .run(T + 1_000, "req-old");
    ledger.requeue(itemId);
    const [back] = ledger.items(created.job.id);
    assert.equal(back?.status, "queued");
    assert.equal(back?.requestId, null, "old attempt identity is cleared for a fresh attach");
    assert.equal(back?.deploymentId, null);
    assert.equal(back?.errorCode, null);
    assert.equal(back?.dispatchedAt, null);
    const kept = opened.sqlite
      .prepare("SELECT status FROM requests WHERE id = 'req-old'")
      .get() as { status: string };
    assert.equal(kept.status, "success", "old request accounting stays in the requests ledger");

    // ALREADY-queued with a stale pointer (abandonRemote queues without clearing linkage):
    // the cleanup must still run, gated only on the linked request being terminal.
    const second = ledger.create({ job: jobDraft({ id: "batch_stale" }), items: [queued("b")] });
    // Take THIS job's own item: claim() serves the oldest queued item across jobs and would
    // pick the first phase's requeued item, which can never join second's remote group.
    const staleId = ledger.items(second.job.id)[0]!.id;
    opened.sqlite
      .prepare(
        "INSERT INTO requests (id, key_id, started_at, lease_expires_at, status) VALUES (?, ?, ?, ?, 'running')",
      )
      .run("req-stale", "key-a", T, T + 60_000);
    opened.sqlite
      .prepare(
        "UPDATE batch_items SET request_id = 'req-stale', deployment_id = 'dep-2', error_code = 'stale-attempt' WHERE id = ?",
      )
      .run(staleId);
    const group = ledger.beginRemote(second.job.id, {
      groupKey: "compat-q",
      submitToken: "token-q",
      itemIds: [staleId],
    });
    ledger.abandonRemote(group.id); // 429-path queues it, old linkage retained
    const stale = ledger.items(second.job.id)[0]!;
    assert.equal(stale.status, "queued");
    assert.equal(stale.requestId, "req-stale", "abandon keeps the old pointer until finalized");

    assert.throws(
      () => ledger.requeue(staleId),
      Conflict,
      "even already-queued requires the linked request finalized first",
    );
    opened.sqlite
      .prepare("UPDATE requests SET status = 'error', finished_at = ? WHERE id = ?")
      .run(T + 2_000, "req-stale");
    ledger.requeue(staleId);
    const cleaned = ledger.items(second.job.id)[0]!;
    assert.equal(cleaned.status, "queued");
    assert.equal(cleaned.requestId, null, "stale terminal pointer cleared for the next attach");
    assert.equal(cleaned.deploymentId, null);
    assert.equal(cleaned.errorCode, null);
    opened.sqlite.close();
  });

  it("expires past the spill-anchored deadline, never at createdAt", () => {
    const path = tempPath();
    const opened = openControlPlaneSqlite(path);
    insertKey(opened, "key-a");
    const ledger = createBatchLedger(opened.db, { newId: sequencer() });

    // Claim the live job's item first so only the stale job has undispatched work.
    const live = ledger.create({
      job: jobDraft({ id: "batch_live", spillAt: T, completionWindowMs: 1_000 }),
      items: [queued("b")],
    });
    assert.equal(ledger.claim(1).length, 1);
    const stale = ledger.create({
      job: jobDraft({ id: "batch_stale", spillAt: T, completionWindowMs: 1_000 }),
      items: [queued("a")],
    });
    // Far future createdAt-based cutoff: createdAt = T, but the deadline is T + 1000.
    const createdLater = ledger.create({
      job: jobDraft({
        id: "batch_later",
        createdAt: T,
        spillAt: T + 5_000,
        completionWindowMs: 1_000,
      }),
      items: [queued("c")],
    });

    ledger.expire(T + 500);
    assert.equal(ledger.job(stale.job.id)?.status, "validating", "deadline not reached");
    assert.equal(
      ledger.job(createdLater.job.id)?.status,
      "validating",
      "createdAt is never the expiry trigger",
    );

    ledger.expire(T + 1_001);
    assert.equal(ledger.job(stale.job.id)?.status, "expired");
    assert.equal(ledger.items(stale.job.id)[0]?.status, "expired");
    assert.notEqual(ledger.job(live.job.id)?.status, "expired", "running items block expiry");
    assert.equal(
      ledger.job(createdLater.job.id)?.status,
      "validating",
      "still before its own spill-anchored deadline",
    );

    ledger.completeItem(ledger.items(live.job.id)[0]!.id, { status: "completed" });
    ledger.expire(T + 1_001);
    assert.equal(ledger.job(live.job.id)?.status, "expired");
    assert.equal(
      ledger.items(live.job.id)[0]?.status,
      "completed",
      "finished work keeps its outcome",
    );
    opened.sqlite.close();
  });

  it("lists per key newest-first with an id cursor and rejects bad cursors", () => {
    const path = tempPath();
    const opened = openControlPlaneSqlite(path);
    insertKey(opened, "key-a");
    insertKey(opened, "key-b");
    const ledger = createBatchLedger(opened.db, { newId: sequencer() });

    ledger.create({
      job: jobDraft({ id: "batch_one", createdAt: T }),
      items: [queued("a")],
    });
    const second = ledger.create({
      job: jobDraft({ id: "batch_two", createdAt: T + 1_000 }),
      items: [queued("b")],
    });
    ledger.create({
      job: jobDraft({ id: "batch_other", keyId: "key-b", createdAt: T + 2_000 }),
      items: [queued("c")],
    });

    const page1 = ledger.list("key-a", { limit: 1 });
    assert.deepEqual(
      page1.map((job) => job.id),
      ["batch_two"],
    );
    const page2 = ledger.list("key-a", { limit: 1, after: page1[0]!.id });
    assert.deepEqual(
      page2.map((job) => job.id),
      ["batch_one"],
    );
    assert.deepEqual(
      ledger.list("key-a", { limit: 10 }).map((job) => job.id),
      ["batch_two", "batch_one"],
      "key-b jobs never appear in key-a listings",
    );
    assert.equal(second.job.keyId, "key-a");
    assert.throws(() => ledger.list("key-a", { limit: 10, after: "batch_nope" }), InvalidInput);
    assert.throws(
      () => ledger.list("key-a", { limit: 10, after: "batch_other" }),
      (error: unknown) => error instanceof InvalidInput && error.message === "invalid batch cursor",
      "a foreign cursor is indistinguishable from an unknown cursor",
    );
    opened.sqlite.close();
  });

  it("lists every nonterminal job across keys for tick reconciliation", () => {
    const path = tempPath();
    const opened = openControlPlaneSqlite(path);
    insertKey(opened, "key-a");
    insertKey(opened, "key-b");
    const ledger = createBatchLedger(opened.db, { newId: sequencer() });

    const first = ledger.create({
      job: jobDraft({ id: "batch_live-a", createdAt: T }),
      items: [queued("a")],
    });
    const second = ledger.create({
      job: jobDraft({ id: "batch_live-b", keyId: "key-b", createdAt: T + 1_000 }),
      items: [queued("b")],
    });
    const doomed = ledger.create({
      job: jobDraft({ id: "batch_done", createdAt: T + 2_000 }),
      items: [queued("c")],
    });
    // Finish one job fully: it must vanish from the sweep, while both keys' live jobs remain.
    ledger.completeItem(ledger.items(doomed.job.id)[0]!.id, { status: "completed" });
    ledger.setJobStatus(doomed.job.id, "queued");
    ledger.setJobStatus(doomed.job.id, "finalizing");
    ledger.setJobStatus(doomed.job.id, "completed", T + 3_000);

    assert.deepEqual(
      ledger.activeJobs().map((job) => job.id),
      ["batch_live-a", "batch_live-b"],
      "cross-key, oldest first, terminals excluded",
    );
    assert.equal(ledger.activeJobs().length, 2);
    assert.equal(first.job.status, "validating");
    assert.equal(second.job.keyId, "key-b");
    opened.sqlite.close();
  });

  it("records provider-reported usage and rejects unknown counts", () => {
    const path = tempPath();
    const opened = openControlPlaneSqlite(path);
    insertKey(opened, "key-a");
    const ledger = createBatchLedger(opened.db, { newId: sequencer() });
    const created = ledger.create({ job: jobDraft(), items: [queued("a")] });
    const jobId = created.job.id;

    ledger.recordJobUsage(jobId, {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      cost: 0.001,
      is_byok: false,
    });
    assert.deepEqual(ledger.job(jobId)?.usage, {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      cost: 0.001,
      is_byok: false,
    });
    assert.throws(() => ledger.recordJobUsage(jobId, { prompt_tokens: -1 } as never), InvalidInput);
    ledger.recordJobUsage(jobId, null);
    assert.equal(ledger.job(jobId)?.usage, null, "null clears a stale aggregate");
    assert.throws(() => ledger.counts("batch_missing"), Conflict, "unknown never reads as zero");
    opened.sqlite.close();
  });

  it("runs durable remote intent: one group, one proven id, persisted-once facts", () => {
    const path = tempPath();
    const opened = openControlPlaneSqlite(path);
    insertKey(opened, "key-a");
    const ledger = createBatchLedger(opened.db, { newId: sequencer() });
    const created = ledger.create({ job: jobDraft(), items: [queued("a"), queued("b")] });
    const jobId = created.job.id;

    const intent = ledger.beginRemote(jobId, {
      groupKey: "compat-1",
      submitToken: "sha-token",
      itemIds: created.items.map((item) => item.id),
      createdAt: T,
    });
    assert.equal(intent.intent, "intended");
    assert.equal(intent.remoteBatchId, null);
    assert.equal(intent.harvestedAt, null);
    assert.match(intent.id, /^batch_grp_/);
    const again = ledger.beginRemote(jobId, {
      groupKey: "compat-1",
      submitToken: "sha-token",
      itemIds: [],
    });
    assert.equal(again.id, intent.id, "record-if-absent returns the existing group");
    assert.equal(ledger.remoteByToken("sha-token")?.id, intent.id);

    // Assignment persisted AT begin, before any POST: both items are running + mapped.
    const assigned = ledger.itemsForRemote(intent.id);
    assert.equal(assigned.length, 2, "exact group assignment is durable and enumerable");
    for (const item of assigned) {
      assert.equal(item.status, "running");
    }
    assert.equal(ledger.pendingRemotes().length, 0, "pending requires a confirmed group");

    // One intent ↔ one proven id: same id idempotent, a second different id is a Conflict.
    ledger.confirmRemote(intent.id, "orb_batch_1", T + 10);
    ledger.confirmRemote(intent.id, "orb_batch_1", T + 11);
    assert.throws(
      () => ledger.confirmRemote(intent.id, "orb_batch_2", T + 12),
      Conflict,
      "ids are never appended to one intent",
    );
    const confirmed = ledger.remotes(jobId)[0]!;
    assert.equal(confirmed.intent, "confirmed");
    assert.equal(confirmed.remoteBatchId, "orb_batch_1");
    assert.equal(confirmed.confirmedAt, T + 10, "first confirm stamps confirmedAt");
    assert.equal(ledger.pendingRemotes().length, 1, "confirmed un-harvested groups resume");

    // Per-group terminal facts persist once; identical repeats are no-ops.
    const usageA = {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      cost: 0.5,
      is_byok: true,
    };
    ledger.recordRemoteUsage(intent.id, usageA);
    ledger.recordRemoteUsage(intent.id, usageA);
    assert.throws(
      () =>
        ledger.recordRemoteUsage(intent.id, {
          prompt_tokens: 1,
          completion_tokens: 1,
          total_tokens: 2,
          cost: 0.9,
          is_byok: false,
        }),
      Conflict,
      "usage is persisted once",
    );

    // A second group on the same job: many intents per job, one id each.
    const secondGroup = ledger.beginRemote(jobId, {
      groupKey: "compat-2",
      submitToken: "sha-token-2",
      itemIds: [],
    });
    assert.throws(
      () => ledger.recordRemoteUsage(secondGroup.id, usageA),
      Conflict,
      "unconfirmed groups carry no facts",
    );
    assert.throws(
      () => ledger.confirmRemote(secondGroup.id, "orb_batch_1"),
      Conflict,
      "a proven id belongs to another group",
    );
    ledger.confirmRemote(secondGroup.id, "orb_batch_2", T + 20);
    ledger.recordRemoteUsage(secondGroup.id, {
      prompt_tokens: 1,
      completion_tokens: 2,
      total_tokens: 3,
      cost: 0.1,
      is_byok: false,
    });

    // Mixed byok facts aggregate to UNKNOWN, not false; known costs sum. Monetary values
    // are asserted with tolerance — never against a float representation.
    const mixed = ledger.remoteUsageTotal(jobId);
    assert.ok(mixed !== undefined, "aggregate exists");
    assert.deepEqual(
      {
        prompt_tokens: mixed.prompt_tokens,
        completion_tokens: mixed.completion_tokens,
        total_tokens: mixed.total_tokens,
        is_byok: mixed.is_byok,
      },
      { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, is_byok: null },
    );
    assert.ok(
      mixed.cost !== null && Math.abs(mixed.cost - 0.6) < 1e-9,
      "known costs sum with tolerance, not float representation",
    );

    // Any unknown cost keeps the aggregate unknown (unknown ≠ zero).
    const thirdGroup = ledger.beginRemote(jobId, {
      groupKey: "compat-4",
      submitToken: "sha-token-4",
      itemIds: [],
    });
    ledger.confirmRemote(thirdGroup.id, "orb_batch_4", T + 25);
    ledger.recordRemoteUsage(thirdGroup.id, {
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 2,
      cost: null,
      is_byok: null,
    });
    assert.deepEqual(ledger.remoteUsageTotal(jobId), {
      prompt_tokens: 12,
      completion_tokens: 8,
      total_tokens: 20,
      cost: null,
      is_byok: null,
    });
    assert.equal(ledger.pendingRemotes().length, 3, "confirmed un-harvested groups await resume");

    // Harvest drops a group from resume; first write wins.
    assert.throws(
      () => ledger.markRemoteHarvested(secondGroup.id, -1),
      InvalidInput,
      "negative stamps are rejected",
    );
    ledger.markRemoteHarvested(intent.id, T + 30);
    ledger.markRemoteHarvested(intent.id, T + 31);
    assert.equal(ledger.pendingRemotes().length, 2);
    assert.equal(ledger.remotes(jobId)[0]?.harvestedAt, T + 30, "first harvest stamp wins");
    ledger.markRemoteHarvested(secondGroup.id, T + 31);
    ledger.markRemoteHarvested(thirdGroup.id, T + 32);
    assert.equal(ledger.pendingRemotes().length, 0, "harvested groups never re-poll");

    // Terminal intents are frozen against ambiguity flips.
    assert.throws(() => ledger.markRemoteUnknown(confirmed.id), Conflict, "confirmed stays known");
    assert.throws(() => ledger.abandonRemote(confirmed.id), Conflict);

    // Proven ids are never adopted across groups or jobs.
    const otherJob = ledger.create({ job: jobDraft({ id: "batch_other" }), items: [queued("z")] });
    const otherGroup = ledger.beginRemote(otherJob.job.id, {
      groupKey: "compat-3",
      submitToken: "sha-token-3",
      itemIds: [],
    });
    assert.throws(() => ledger.confirmRemote(otherGroup.id, "orb_batch_1"), Conflict);
    // Standalone assignment wrapper shares the same guards (intended + free items).
    ledger.assignRemoteItems(otherGroup.id, [ledger.items(otherJob.job.id)[0]!.id]);
    assert.equal(ledger.itemsForRemote(otherGroup.id).length, 1);
    ledger.confirmRemote(otherGroup.id, "orb_batch_3", T + 40);
    assert.equal(ledger.remoteByToken("sha-token-3")?.remoteBatchId, "orb_batch_3");
    assert.equal(ledger.remoteUsageTotal(otherJob.job.id), undefined, "no facts is undefined");
    opened.sqlite.close();
  });

  it("interrupts ambiguous remote items and abandons clean rejections back to queued", () => {
    const path = tempPath();
    const opened = openControlPlaneSqlite(path);
    insertKey(opened, "key-a");
    const ledger = createBatchLedger(opened.db, { newId: sequencer() });
    const created = ledger.create({ job: jobDraft(), items: [queued("a"), queued("b")] });

    const ambiguous = ledger.beginRemote(created.job.id, {
      groupKey: "compat-u",
      submitToken: "token-u",
      itemIds: [created.items[0]!.id],
    });
    ledger.markRemoteUnknown(ambiguous.id);
    const interrupted = ledger
      .items(created.job.id)
      .find((item) => item.id === created.items[0]!.id)!;
    assert.equal(interrupted.status, "interrupted", "possibly executed work is never replayed");
    assert.equal(interrupted.errorCode, "batch_interrupted");
    assert.throws(() => ledger.requeue(interrupted.id), Conflict);
    assert.deepEqual(
      ledger.counts(created.job.id),
      { total: 2, completed: 0, failed: 0 },
      "interrupted counts in neither bucket",
    );
    ledger.markRemoteUnknown(ambiguous.id); // idempotent

    const rejected = ledger.beginRemote(created.job.id, {
      groupKey: "compat-r",
      submitToken: "token-r",
      itemIds: [created.items[1]!.id],
    });
    ledger.abandonRemote(rejected.id);
    const recovered = ledger
      .items(created.job.id)
      .find((item) => item.id === created.items[1]!.id)!;
    assert.equal(recovered.status, "queued", "clean rejection returns items to queued");
    assert.equal(recovered.dispatchedAt, null);
    assert.equal(
      ledger.itemsForRemote(rejected.id).length,
      0,
      "abandoned group keeps no assignments",
    );
    opened.sqlite.close();
  });

  it("recovers from a crashed process without losing queued work", () => {
    const path = tempPath();
    const first = openControlPlaneSqlite(path);
    insertKey(first, "key-a");
    const ledger = createBatchLedger(first.db, { newId: sequencer() });
    const created = ledger.create({
      job: jobDraft(),
      items: [queued("a"), queued("b"), queued("c")],
    });
    const claimed = ledger.claim(1);
    assert.equal(claimed.length, 1);

    // A confirmed remote group mid-poll: its running item must survive the restart.
    const remote = ledger.beginRemote(created.job.id, {
      groupKey: "compat-c",
      submitToken: "token-c",
      itemIds: [created.items[2]!.id],
    });
    ledger.confirmRemote(remote.id, "orb_batch_c");

    const second = openControlPlaneSqlite(path);
    const restarted = createBatchLedger(second.db, { newId: sequencer() });
    const items = restarted.items(created.job.id);
    const local = items.find((item) => item.id === claimed[0]!.id)!;
    assert.equal(local.status, "interrupted", "crashed local dispatch is marked, not replayed");
    assert.equal(local.errorCode, "batch_interrupted");
    const polled = items.find((item) => item.id === created.items[2]!.id)!;
    assert.equal(polled.status, "running", "confirmed remote work resumes polling");
    const untouched = items.find((item) => item.id === created.items[1]!.id)!;
    assert.equal(untouched.status, "queued", "never-dispatched items stay recoverable");
    assert.equal(restarted.claim(10).length, 1, "the recoverable item claims normally");
    assert.equal(restarted.pendingRemotes().length, 1);
    assert.deepEqual(restarted.counts(created.job.id), { total: 3, completed: 0, failed: 0 });
    first.sqlite.close();
    second.sqlite.close();
  });

  it("never dispatches new paid work after cancelling", () => {
    const path = tempPath();
    const opened = openControlPlaneSqlite(path);
    insertKey(opened, "key-a");
    const ledger = createBatchLedger(opened.db, { newId: sequencer() });
    const created = ledger.create({
      job: jobDraft(),
      items: [queued("a"), queued("b"), queued("c")],
    });
    const jobId = created.job.id;
    const intake = ledger.claim(1);
    assert.equal(intake.length, 1);
    const remote = ledger.beginRemote(jobId, {
      groupKey: "compat-d",
      submitToken: "token-d",
      itemIds: [intake[0]!.id],
    });
    ledger.setJobStatus(jobId, "cancelling");

    // Cancelling never re-opens dispatch: no requeue, no new remote groups.
    assert.throws(() => ledger.requeue(intake[0]!.id), Conflict, "no requeue while cancelling");
    assert.throws(
      () =>
        ledger.beginRemote(jobId, { groupKey: "fresh", submitToken: "token-fresh", itemIds: [] }),
      Conflict,
      "no new remote group while cancelling",
    );

    // Clean rejection while cancelling: the affected item dies cancelled, never queued.
    ledger.abandonRemote(remote.id);
    const abandoned = ledger.items(jobId).find((item) => item.id === intake[0]!.id)!;
    assert.equal(abandoned.status, "cancelled", "never re-queued after DELETE");
    assert.equal(ledger.job(jobId)?.status, "cancelled", "cancellation closes when drained");
    assert.equal(ledger.claim(10).length, 0, "no new claim after DELETE");
    assert.throws(
      () => ledger.beginRemote(jobId, { groupKey: "x", submitToken: "y", itemIds: [] }),
      Conflict,
      "terminal jobs never start remote work",
    );
    opened.sqlite.close();
  });

  it("keeps cancellation open until remote-linked running requests settle", () => {
    const path = tempPath();
    const opened = openControlPlaneSqlite(path);
    insertKey(opened, "key-a");
    const ledger = createBatchLedger(opened.db, { newId: sequencer() });

    const ambiguous = ledger.create({
      job: jobDraft({ id: "batch_ambiguous_cancel" }),
      items: [queued("ambiguous")],
    });
    const unknown = ledger.beginRemote(ambiguous.job.id, {
      groupKey: "unknown",
      submitToken: "unknown",
      itemIds: [ambiguous.items[0]!.id],
    });
    opened.sqlite
      .prepare(
        "INSERT INTO requests (id, key_id, started_at, lease_expires_at, status) VALUES (?, ?, ?, ?, 'running')",
      )
      .run("req-unknown", "key-a", T, T + 60_000);
    opened.sqlite
      .prepare("UPDATE batch_items SET request_id = ? WHERE id = ?")
      .run("req-unknown", ambiguous.items[0]!.id);
    ledger.markRemoteUnknown(unknown.id);
    ledger.setJobStatus(ambiguous.job.id, "cancelling");
    assert.equal(ledger.items(ambiguous.job.id)[0]?.status, "interrupted");
    assert.equal(
      ledger.job(ambiguous.job.id)?.status,
      "cancelling",
      "initial DELETE cannot auto-close",
    );
    assert.throws(() => ledger.setJobStatus(ambiguous.job.id, "cancelled"), Conflict);
    assert.deepEqual(ledger.claim(10), [], "cancelling jobs yield no paid work");
    assert.equal(
      ledger.activeJobs().some((job) => job.id === ambiguous.job.id),
      true,
      "interrupted accounting stays reachable for reconciliation",
    );
    opened.sqlite
      .prepare("UPDATE requests SET status = 'success', finished_at = ? WHERE id = ?")
      .run(T + 1_000, "req-unknown");
    ledger.setJobStatus(ambiguous.job.id, "cancelled");

    const rejected = ledger.create({
      job: jobDraft({ id: "batch_rejected_cancel" }),
      items: [queued("linked"), queued("unlinked"), queued("undispatched")],
    });
    const remote = ledger.beginRemote(rejected.job.id, {
      groupKey: "rejected",
      submitToken: "rejected",
      itemIds: [rejected.items[0]!.id, rejected.items[1]!.id],
    });
    opened.sqlite
      .prepare(
        "INSERT INTO requests (id, key_id, started_at, lease_expires_at, status) VALUES (?, ?, ?, ?, 'running')",
      )
      .run("req-rejected", "key-a", T, T + 60_000);
    opened.sqlite
      .prepare("UPDATE batch_items SET request_id = ? WHERE id = ?")
      .run("req-rejected", rejected.items[0]!.id);
    ledger.setJobStatus(rejected.job.id, "cancelling");
    ledger.abandonRemote(remote.id);
    const [linked, unlinked, undispatched] = rejected.items.map((item) =>
      ledger.items(rejected.job.id).find((current) => current.id === item.id)!,
    );
    assert.equal(linked?.status, "running", "linked work awaits deferred finalization");
    assert.deepEqual(
      ledger.itemsForRemote(remote.id).map((item) => item.id),
      [linked!.id],
      "abandoned remote remains discoverable for retry",
    );
    assert.equal(unlinked?.status, "cancelled", "unlinked rejected work can be cancelled");
    assert.equal(undispatched?.status, "cancelled");
    assert.equal(ledger.job(rejected.job.id)?.status, "cancelling");
    assert.deepEqual(ledger.claim(10), [], "abandoned work never re-enters dispatch");
    assert.throws(() => ledger.setJobStatus(rejected.job.id, "cancelled"), Conflict);
    opened.sqlite
      .prepare("UPDATE requests SET status = 'success', finished_at = ? WHERE id = ?")
      .run(T + 1_000, "req-rejected");
    ledger.completeItem(linked!.id, { status: "cancelled" });
    assert.equal(ledger.job(rejected.job.id)?.status, "cancelled");
    opened.sqlite.close();
  });

  it("refuses failed/finalizing/expiry closure while an interrupted item has live accounting", () => {
    const path = tempPath();
    const opened = openControlPlaneSqlite(path);
    insertKey(opened, "key-a");
    const ledger = createBatchLedger(opened.db, { newId: sequencer() });
    const created = ledger.create({
      job: jobDraft({ id: "batch_unknown_failure", spillAt: T, completionWindowMs: 1_000 }),
      items: [queued("failure")],
    });
    const remote = ledger.beginRemote(created.job.id, {
      groupKey: "failure",
      submitToken: "failure",
      itemIds: [created.items[0]!.id],
    });
    opened.sqlite
      .prepare(
        "INSERT INTO requests (id, key_id, started_at, lease_expires_at, status) VALUES (?, ?, ?, ?, 'running')",
      )
      .run("req-failure", "key-a", T, T + 60_000);
    opened.sqlite
      .prepare("UPDATE batch_items SET request_id = ? WHERE id = ?")
      .run("req-failure", created.items[0]!.id);
    ledger.markRemoteUnknown(remote.id);
    assert.equal(ledger.items(created.job.id)[0]?.status, "interrupted");
    assert.throws(() => ledger.setJobStatus(created.job.id, "failed"), Conflict);
    assert.throws(() => ledger.setJobStatus(created.job.id, "finalizing"), Conflict);
    ledger.expire(T + 1_001);
    assert.equal(ledger.job(created.job.id)?.status, "validating", "expiry defers live accounting");
    assert.equal(
      ledger.activeJobs().some((job) => job.id === created.job.id),
      true,
      "failed deferred finalization can retry while the job remains active",
    );
    opened.sqlite
      .prepare("UPDATE requests SET status = 'success', finished_at = ? WHERE id = ?")
      .run(T + 1_000, "req-failure");
    ledger.setJobStatus(created.job.id, "failed");
    assert.equal(ledger.job(created.job.id)?.status, "failed");
    opened.sqlite.close();
  });

  it("reopens only abandoned tombstones and never presents a partial usage total", () => {
    const path = tempPath();
    const opened = openControlPlaneSqlite(path);
    insertKey(opened, "key-a");
    const ledger = createBatchLedger(opened.db, { newId: sequencer() });
    const created = ledger.create({ job: jobDraft(), items: [queued("a"), queued("b")] });
    const jobId = created.job.id;

    // One known group with a persisted fact: a complete total.
    const known = ledger.beginRemote(jobId, {
      groupKey: "k1",
      submitToken: "tok-k1",
      itemIds: [created.items[0]!.id],
    });
    ledger.confirmRemote(known.id, "orb_k1", T + 5);
    ledger.recordRemoteUsage(known.id, {
      prompt_tokens: 4,
      completion_tokens: 2,
      total_tokens: 6,
      cost: 0.25,
      is_byok: true,
    });
    const knownTotal = ledger.remoteUsageTotal(jobId);
    assert.ok(knownTotal !== undefined, "aggregate exists");
    assert.deepEqual(
      {
        prompt_tokens: knownTotal.prompt_tokens,
        completion_tokens: knownTotal.completion_tokens,
        total_tokens: knownTotal.total_tokens,
        is_byok: knownTotal.is_byok,
      },
      { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6, is_byok: true },
    );
    assert.ok(
      knownTotal.cost !== null && Math.abs(knownTotal.cost - 0.25) < 1e-9,
      "monetary value asserted with tolerance, not float representation",
    );

    // A group with NO fact voids the whole aggregate — never a partial total.
    const cleanReject = ledger.beginRemote(jobId, {
      groupKey: "k2",
      submitToken: "tok-k2",
      itemIds: [created.items[1]!.id],
    });
    assert.equal(
      ledger.remoteUsageTotal(jobId),
      undefined,
      "unharvested group without facts voids the total",
    );

    // Provably-zero abandoned groups are the ONLY skippable ones — abandoned straight from
    // intended (an unknown group is neither abandonable nor reopenable, ever).
    ledger.abandonRemote(cleanReject.id);
    const restored = ledger.remoteUsageTotal(jobId);
    assert.ok(restored !== undefined, "abandon restores a complete total");
    assert.deepEqual(
      {
        prompt_tokens: restored.prompt_tokens,
        completion_tokens: restored.completion_tokens,
        total_tokens: restored.total_tokens,
        is_byok: restored.is_byok,
      },
      { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6, is_byok: true },
    );
    assert.ok(
      restored.cost !== null && Math.abs(restored.cost - 0.25) < 1e-9,
      "abandoned group carries no cost into the total",
    );

    // Confirmed without facts is unknown too.
    const unfact = ledger.beginRemote(jobId, {
      groupKey: "k3",
      submitToken: "tok-k3",
      itemIds: [],
    });
    ledger.confirmRemote(unfact.id, "orb_k3", T + 6);
    assert.equal(ledger.remoteUsageTotal(jobId), undefined, "confirmed without facts is unknown");

    // Isolated job: an ambiguous group voids ITS total without borrowing other factors.
    const isoJob = ledger.create({ job: jobDraft({ id: "batch_iso" }), items: [queued("i")] });
    const isoKnown = ledger.beginRemote(isoJob.job.id, {
      groupKey: "iso-1",
      submitToken: "tok-iso-1",
      itemIds: [],
    });
    ledger.confirmRemote(isoKnown.id, "orb_iso_1", T + 7);
    ledger.recordRemoteUsage(isoKnown.id, {
      prompt_tokens: 2,
      completion_tokens: 1,
      total_tokens: 3,
      cost: 0.5,
      is_byok: false,
    });
    const isoTotal = ledger.remoteUsageTotal(isoJob.job.id);
    assert.ok(isoTotal !== undefined, "isolated job has its complete total");
    assert.equal(isoTotal.is_byok, false, "single non-byok fact stays exact");
    assert.ok(
      isoTotal.cost !== null && Math.abs(isoTotal.cost - 0.5) < 1e-9,
      "single known cost with tolerance",
    );
    const isoUnknown = ledger.beginRemote(isoJob.job.id, {
      groupKey: "iso-2",
      submitToken: "tok-iso-2",
      itemIds: [],
    });
    ledger.markRemoteUnknown(isoUnknown.id);
    assert.equal(
      ledger.remoteUsageTotal(isoJob.job.id),
      undefined,
      "ambiguous (possibly billed) group voids the total in isolation",
    );

    // Abandoned tombstones reopen for the identical set (never-executed is proven)…
    const reopened = ledger.beginRemote(jobId, {
      groupKey: "k2",
      submitToken: "tok-k2",
      itemIds: [created.items[1]!.id],
    });
    assert.equal(reopened.id, cleanReject.id, "same token keeps the same row");
    assert.equal(reopened.intent, "intended");
    assert.equal(
      ledger.itemsForRemote(reopened.id).length,
      1,
      "reopen re-persists the assignment before any POST",
    );

    // …while possibly-executed (unknown) groups never reopen.
    const ambiguousTwo = ledger.beginRemote(jobId, {
      groupKey: "k4",
      submitToken: "tok-k4",
      itemIds: [],
    });
    ledger.markRemoteUnknown(ambiguousTwo.id);
    const repeat = ledger.beginRemote(jobId, {
      groupKey: "k4",
      submitToken: "tok-k4",
      itemIds: [],
    });
    assert.equal(repeat.id, ambiguousTwo.id);
    assert.equal(repeat.intent, "unknown", "possibly-executed groups never reopen");
    opened.sqlite.close();
  });
});
