import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import { Effect, Layer, ManagedRuntime } from "effect";
import { POLICY_SUGGESTIONS, type KeyPolicy } from "../../src/domain.ts";
import {
  ConcurrentLimit,
  Conflict,
  KeyExpired,
  KeyRevoked,
  RateLimited,
  StaleVersion,
} from "../../src/errors.ts";
import { sqliteDatabaseLayer } from "../../src/db/sqlite.ts";
import { ApiKeys, apiKeysLayer } from "../../src/keys/api-keys.ts";
import { keyRepositoryLayer } from "../../src/keys/repository.ts";

const dirs: string[] = [];

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "llm-router-batch-admit-"));
  dirs.push(dir);
  return join(dir, "control.sqlite");
}

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function live(path: string) {
  return apiKeysLayer.pipe(
    Layer.provideMerge(keyRepositoryLayer({ pepper: "batch-admission-pepper" })),
    Layer.provide(sqliteDatabaseLayer(path)),
  );
}

const policy: KeyPolicy = {
  ...POLICY_SUGGESTIONS.Standard,
  maxConcurrent: 1,
  requestsPerMinute: 30,
};

function seedRunningItem(
  path: string,
  keyId: string,
  input: { jobId: string; itemId: string; now: number; windowMs?: number },
): number {
  const windowMs = input.windowMs ?? 60 * 60 * 1000;
  const deadlineAt = input.now + windowMs;
  const sqlite = new DatabaseSync(path);
  try {
    sqlite
      .prepare(
        `INSERT INTO batch_jobs
          (id, key_id, model, status, completion_window_ms, created_at, finalized_at, spill_at,
           usage_json, request_counts_total, request_counts_completed, request_counts_failed, error_code)
         VALUES (?, ?, ?, 'queued', ?, ?, NULL, ?, NULL, 1, 0, 0, NULL)`,
      )
      .run(input.jobId, keyId, "batch-model", windowMs, input.now, input.now);
    sqlite
      .prepare(
        `INSERT INTO batch_items
          (id, job_id, custom_id, status, request_id, deployment_id, error_code, created_at,
           dispatched_at, finished_at, remote_id)
         VALUES (?, ?, ?, 'running', NULL, NULL, NULL, ?, ?, NULL, NULL)`,
      )
      .run(input.itemId, input.jobId, `${input.itemId}-custom`, input.now, input.now);
  } finally {
    sqlite.close();
  }
  return deadlineAt;
}

function requestRow(path: string, requestId: string): Record<string, unknown> {
  const sqlite = new DatabaseSync(path);
  try {
    return sqlite.prepare("SELECT * FROM requests WHERE id = ?").get(requestId) as Record<
      string,
      unknown
    >;
  } finally {
    sqlite.close();
  }
}

function batchItemRow(path: string, itemId: string): Record<string, unknown> {
  const sqlite = new DatabaseSync(path);
  try {
    return sqlite.prepare("SELECT * FROM batch_items WHERE id = ?").get(itemId) as Record<
      string,
      unknown
    >;
  } finally {
    sqlite.close();
  }
}

describe("batch key admission lifecycle", () => {
  it("defers the admitted request outside concurrency and finalizes it after revocation", async () => {
    const path = tempDb();
    const runtime = ManagedRuntime.make(live(path));
    const setup = await runtime.runPromise(
      Effect.gen(function* () {
        const keys = yield* ApiKeys;
        const created = yield* keys.createKey({ name: "remote", expiresAt: null, policy });
        const admission = yield* keys.admitByKeyId(created.key.id);
        return {
          keyId: created.key.id,
          version: created.key.version,
          secret: created.secret,
          admission,
        };
      }),
    );
    const now = Date.now();
    const deadlineAt = seedRunningItem(path, setup.keyId, {
      jobId: "batch-job-remote",
      itemId: "batch-item-remote",
      now,
    });

    await runtime.runPromise(
      Effect.gen(function* () {
        const keys = yield* ApiKeys;
        yield* keys.attach(setup.admission, "batch-item-remote");
        yield* keys.defer(
          setup.admission,
          "batch-item-remote",
          {
            deploymentId: "cloud-batch-1",
            classifierBackend: "laya",
            modelRevision: "classifier-r1",
            source: "full-input",
            classifierInputTokens: 11,
            classifierElapsedMs: 7,
            reuse: "classified",
            decisionReason: "cloud-quality",
            selectionReasonCode: "cloud-quality",
            selectionReasonDetail: "remote batch is the pinned candidate",
            saturation: false,
          },
          deadlineAt,
        );
      }),
    );

    const deferred = requestRow(path, setup.admission.requestId);
    assert.equal(deferred.deferred, 1);
    assert.equal(deferred.status, "running");
    assert.equal(deferred.lease_expires_at, deadlineAt);
    assert.equal(deferred.classifier_backend, "laya");
    assert.equal(deferred.decision_reason, "cloud-quality");
    assert.equal(deferred.prompt_tokens, null);
    assert.equal(deferred.provider_reported_usd, null);
    const deferredItem = batchItemRow(path, "batch-item-remote");
    assert.equal(deferredItem.deployment_id, "cloud-batch-1");

    await runtime.runPromise(
      Effect.gen(function* () {
        const keys = yield* ApiKeys;
        yield* keys.recheckDeferred(setup.admission);
      }),
    );
    const staleBeforePost = await runtime.runPromise(
      Effect.gen(function* () {
        const keys = yield* ApiKeys;
        yield* keys.updateKey({
          id: setup.keyId,
          expectedVersion: setup.version,
          name: "remote",
          expiresAt: null,
          policy,
        });
        return yield* keys.recheckDeferred(setup.admission).pipe(Effect.result);
      }),
    );
    assert.equal(staleBeforePost._tag, "Failure");
    if (staleBeforePost._tag === "Failure") {
      assert.ok(staleBeforePost.failure instanceof StaleVersion);
    }

    // A stale deferred lease is owned by the batch lifecycle, not ordinary recovery.
    const sqlite = new DatabaseSync(path);
    sqlite
      .prepare("UPDATE requests SET lease_expires_at = 1 WHERE id = ?")
      .run(setup.admission.requestId);
    sqlite.close();

    const second = await runtime.runPromise(
      Effect.gen(function* () {
        const keys = yield* ApiKeys;
        return yield* keys.admit(setup.secret);
      }),
    );
    assert.notEqual(second.requestId, setup.admission.requestId);
    await runtime.runPromise(
      Effect.gen(function* () {
        const keys = yield* ApiKeys;
        yield* keys.finalize(second, { status: "success" });
        yield* keys.revokeKey(setup.keyId);
        const revokedBeforePost = yield* keys.recheckDeferred(setup.admission).pipe(Effect.result);
        assert.equal(revokedBeforePost._tag, "Failure");
        if (revokedBeforePost._tag === "Failure") {
          assert.ok(revokedBeforePost.failure instanceof KeyRevoked);
        }
        yield* keys.finalizeDeferred(setup.keyId, setup.admission.requestId, {
          status: "success",
          promptTokens: 17,
          completionTokens: 9,
          providerReportedUsd: null,
        });
        // A clean reject/requeue clears the item binding after the request is
        // already terminal; retries remain idempotent without that binding.
        const sqliteAfterFinalize = new DatabaseSync(path);
        sqliteAfterFinalize
          .prepare(
            "UPDATE batch_items SET status = 'queued', request_id = NULL, deployment_id = NULL, error_code = NULL, dispatched_at = NULL WHERE id = ?",
          )
          .run("batch-item-remote");
        sqliteAfterFinalize.close();
        yield* keys.finalizeDeferred(setup.keyId, setup.admission.requestId, {
          status: "success",
          promptTokens: 17,
          completionTokens: 9,
        });
      }),
    );

    const finished = requestRow(path, setup.admission.requestId);
    assert.equal(finished.deferred, 0);
    assert.equal(finished.status, "success");
    assert.equal(finished.prompt_tokens, 17);
    assert.equal(finished.completion_tokens, 9);
    assert.equal(finished.classifier_backend, "laya");
    await runtime.dispose();
  });

  it("rejects cross-key and cross-request attachment", async () => {
    const path = tempDb();
    const runtime = ManagedRuntime.make(live(path));
    const setup = await runtime.runPromise(
      Effect.gen(function* () {
        const keys = yield* ApiKeys;
        const a = yield* keys.createKey({
          name: "a",
          expiresAt: null,
          policy: { ...policy, maxConcurrent: 4 },
        });
        const b = yield* keys.createKey({
          name: "b",
          expiresAt: null,
          policy: { ...policy, maxConcurrent: 4 },
        });
        const admissionA = yield* keys.admitByKeyId(a.key.id);
        const admissionA2 = yield* keys.admitByKeyId(a.key.id);
        const admissionB = yield* keys.admitByKeyId(b.key.id);
        return { a, b, admissionA, admissionA2, admissionB };
      }),
    );
    const now = Date.now();
    seedRunningItem(path, setup.b.key.id, {
      jobId: "batch-job-b",
      itemId: "batch-item-b",
      now,
    });
    seedRunningItem(path, setup.a.key.id, {
      jobId: "batch-job-a",
      itemId: "batch-item-a",
      now,
    });

    await runtime.runPromise(
      Effect.gen(function* () {
        const keys = yield* ApiKeys;
        const foreign = yield* keys.attach(setup.admissionA, "batch-item-b").pipe(Effect.result);
        assert.equal(foreign._tag, "Failure");
        if (foreign._tag === "Failure") assert.ok(foreign.failure instanceof Conflict);

        yield* keys.attach(setup.admissionA, "batch-item-a");
        const relink = yield* keys.attach(setup.admissionA2, "batch-item-a").pipe(Effect.result);
        assert.equal(relink._tag, "Failure");
        if (relink._tag === "Failure") assert.ok(relink.failure instanceof Conflict);
        yield* keys.finalize(setup.admissionA, { status: "abandoned" });
        yield* keys.finalize(setup.admissionA2, { status: "abandoned" });
        yield* keys.finalize(setup.admissionB, { status: "abandoned" });
      }),
    );
    await runtime.dispose();
  });

  it("settles interrupted ordinary and deferred requests without re-admission", async () => {
    const path = tempDb();
    const runtime = ManagedRuntime.make(live(path));
    const setup = await runtime.runPromise(
      Effect.gen(function* () {
        const keys = yield* ApiKeys;
        const owner = yield* keys.createKey({
          name: "interrupted-owner",
          expiresAt: null,
          policy: { ...policy, maxConcurrent: 4 },
        });
        const other = yield* keys.createKey({
          name: "interrupted-other",
          expiresAt: null,
          policy: { ...policy, maxConcurrent: 4 },
        });
        const foreignRequest = yield* keys.admitByKeyId(other.key.id);
        const ordinary = yield* keys.admitByKeyId(owner.key.id);
        const deferred = yield* keys.admitByKeyId(owner.key.id);
        const liveRequest = yield* keys.admitByKeyId(owner.key.id);
        return { owner, other, ordinary, deferred, liveRequest, foreignRequest };
      }),
    );
    const now = Date.now();
    seedRunningItem(path, setup.owner.key.id, {
      jobId: "batch-job-interrupted-ordinary",
      itemId: "batch-item-interrupted-ordinary",
      now,
    });
    seedRunningItem(path, setup.owner.key.id, {
      jobId: "batch-job-interrupted-deferred",
      itemId: "batch-item-interrupted-deferred",
      now,
    });
    seedRunningItem(path, setup.owner.key.id, {
      jobId: "batch-job-interrupted-live",
      itemId: "batch-item-interrupted-live",
      now,
    });
    seedRunningItem(path, setup.owner.key.id, {
      jobId: "batch-job-interrupted-unlinked",
      itemId: "batch-item-interrupted-unlinked",
      now,
    });
    seedRunningItem(path, setup.owner.key.id, {
      jobId: "batch-job-interrupted-wrong-request",
      itemId: "batch-item-interrupted-wrong-request",
      now,
    });

    const sqlite = new DatabaseSync(path);
    sqlite
      .prepare("UPDATE requests SET prompt_tokens = 3, estimated_cost_usd = 0.4 WHERE id = ?")
      .run(setup.ordinary.requestId);
    sqlite
      .prepare(
        "UPDATE requests SET deferred = 1, completion_tokens = 8, provider_reported_usd = 0.25 WHERE id = ?",
      )
      .run(setup.deferred.requestId);
    sqlite
      .prepare(
        "UPDATE batch_items SET status = 'interrupted', request_id = ?, error_code = 'batch_interrupted' WHERE id = ?",
      )
      .run(setup.ordinary.requestId, "batch-item-interrupted-ordinary");
    sqlite
      .prepare(
        "UPDATE batch_items SET status = 'interrupted', request_id = ?, error_code = 'batch_interrupted' WHERE id = ?",
      )
      .run(setup.deferred.requestId, "batch-item-interrupted-deferred");
    sqlite
      .prepare("UPDATE batch_items SET request_id = ? WHERE id = ?")
      .run(setup.liveRequest.requestId, "batch-item-interrupted-live");
    sqlite
      .prepare("UPDATE batch_items SET status = 'interrupted' WHERE id = ?")
      .run("batch-item-interrupted-unlinked");
    sqlite
      .prepare("UPDATE batch_items SET status = 'interrupted', request_id = ? WHERE id = ?")
      .run(setup.foreignRequest.requestId, "batch-item-interrupted-wrong-request");
    sqlite.close();

    const beforeCount = requestRow(path, setup.ordinary.requestId);
    assert.equal(beforeCount.status, "running");
    await runtime.runPromise(
      Effect.gen(function* () {
        const keys = yield* ApiKeys;
        const wrongOwner = yield* keys
          .finalizeInterrupted(setup.other.key.id, "batch-item-interrupted-ordinary")
          .pipe(Effect.result);
        assert.equal(wrongOwner._tag, "Failure");
        if (wrongOwner._tag === "Failure") assert.ok(wrongOwner.failure instanceof Conflict);

        const wrongRequest = yield* keys
          .finalizeInterrupted(setup.owner.key.id, "batch-item-interrupted-wrong-request")
          .pipe(Effect.result);
        assert.equal(wrongRequest._tag, "Failure");
        if (wrongRequest._tag === "Failure") {
          assert.ok(wrongRequest.failure instanceof Conflict);
        }

        const live = yield* keys
          .finalizeInterrupted(setup.owner.key.id, "batch-item-interrupted-live")
          .pipe(Effect.result);
        assert.equal(live._tag, "Failure");
        if (live._tag === "Failure") assert.ok(live.failure instanceof Conflict);

        // An interrupted item with no request binding is an idempotent no-op.
        yield* keys.finalizeInterrupted(setup.owner.key.id, "batch-item-interrupted-unlinked");

        yield* keys.revokeKey(setup.owner.key.id);
        yield* keys.finalizeInterrupted(setup.owner.key.id, "batch-item-interrupted-ordinary");
        yield* keys.finalizeInterrupted(setup.owner.key.id, "batch-item-interrupted-deferred");
        // Repeated recovery after the same rows are terminal is idempotent.
        yield* keys.finalizeInterrupted(setup.owner.key.id, "batch-item-interrupted-ordinary");
        yield* keys.finalizeInterrupted(setup.owner.key.id, "batch-item-interrupted-deferred");
      }),
    );

    const ordinary = requestRow(path, setup.ordinary.requestId);
    assert.equal(ordinary.status, "abandoned");
    assert.equal(ordinary.error_code, "batch_interrupted");
    assert.equal(ordinary.deferred, 0);
    assert.equal(ordinary.prompt_tokens, 3);
    assert.equal(typeof ordinary.finished_at, "number");
    assert.equal(ordinary.estimated_cost_usd, 0.4);
    const deferred = requestRow(path, setup.deferred.requestId);
    assert.equal(deferred.status, "abandoned");
    assert.equal(deferred.error_code, "batch_interrupted");
    assert.equal(deferred.deferred, 0);
    assert.equal(deferred.completion_tokens, 8);
    assert.equal(typeof deferred.finished_at, "number");
    assert.equal(deferred.provider_reported_usd, 0.25);
    assert.equal(requestRow(path, setup.liveRequest.requestId).status, "running");
    assert.equal(requestRow(path, setup.foreignRequest.requestId).status, "running");
    const unlinked = batchItemRow(path, "batch-item-interrupted-unlinked");
    assert.equal(unlinked.status, "interrupted");
    assert.equal(unlinked.request_id, null);
    await runtime.dispose();
  });

  it("keeps admitByKeyId and recheck guards before dispatch", async () => {
    const path = tempDb();
    const runtime = ManagedRuntime.make(live(path));
    await runtime.runPromise(
      Effect.gen(function* () {
        const keys = yield* ApiKeys;
        const capped = yield* keys.createKey({
          name: "capped",
          expiresAt: null,
          policy: { ...policy, requestsPerMinute: 1 },
        });
        const first = yield* keys.admitByKeyId(capped.key.id);
        const concurrent = yield* keys.admitByKeyId(capped.key.id).pipe(Effect.result);
        assert.equal(concurrent._tag, "Failure");
        if (concurrent._tag === "Failure") assert.ok(concurrent.failure instanceof ConcurrentLimit);
        yield* keys.finalize(first, { status: "abandoned" });
        const rate = yield* keys.admitByKeyId(capped.key.id).pipe(Effect.result);
        assert.equal(rate._tag, "Failure");
        if (rate._tag === "Failure") assert.ok(rate.failure instanceof RateLimited);

        const versioned = yield* keys.createKey({ name: "versioned", expiresAt: null, policy });
        const admission = yield* keys.admitByKeyId(versioned.key.id);
        yield* keys.updateKey({
          id: versioned.key.id,
          expectedVersion: versioned.key.version,
          name: "versioned",
          expiresAt: null,
          policy: { ...policy, maxConcurrent: 2 },
        });
        const stale = yield* keys.recheck(admission).pipe(Effect.result);
        assert.equal(stale._tag, "Failure");
        if (stale._tag === "Failure") assert.ok(stale.failure instanceof StaleVersion);
        yield* keys.finalize(admission, { status: "abandoned" });

        const revoked = yield* keys.createKey({ name: "revoked", expiresAt: null, policy });
        yield* keys.revokeKey(revoked.key.id);
        const revokedResult = yield* keys.admitByKeyId(revoked.key.id).pipe(Effect.result);
        assert.equal(revokedResult._tag, "Failure");
        if (revokedResult._tag === "Failure")
          assert.ok(revokedResult.failure instanceof KeyRevoked);

        const expired = yield* keys.createKey({ name: "expired", expiresAt: null, policy });
        const sqlite = new DatabaseSync(path);
        sqlite.prepare("UPDATE api_keys SET expires_at = 1 WHERE id = ?").run(expired.key.id);
        sqlite.close();
        const expiredResult = yield* keys.admitByKeyId(expired.key.id).pipe(Effect.result);
        assert.equal(expiredResult._tag, "Failure");
        if (expiredResult._tag === "Failure")
          assert.ok(expiredResult.failure instanceof KeyExpired);
      }),
    );
    await runtime.dispose();
  });
});
