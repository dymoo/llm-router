import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import { Effect, Layer, ManagedRuntime } from "effect";
import { POLICY_SUGGESTIONS, type KeyPolicy } from "../../src/domain.ts";
import {
  AuthFailed,
  ConcurrentLimit,
  KeyRevoked,
  RateLimited,
  StaleVersion,
} from "../../src/errors.ts";
import { sqliteDatabaseLayer } from "../../src/db/sqlite.ts";
import { ApiKeys, apiKeysLayer } from "../../src/keys/api-keys.ts";
import { keyRepositoryLayer } from "../../src/keys/repository.ts";

const dirs: string[] = [];

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "llm-router-admit-"));
  dirs.push(dir);
  return join(dir, "control.sqlite");
}

after(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function live(path: string, pepper = "pepper-a") {
  return apiKeysLayer.pipe(
    Layer.provideMerge(keyRepositoryLayer({ pepper })),
    Layer.provide(sqliteDatabaseLayer(path)),
  );
}

const oneAtATime: KeyPolicy = {
  ...POLICY_SUGGESTIONS.Standard,
  maxConcurrent: 1,
  requestsPerMinute: 30,
};

describe("admission", () => {
  it("authenticates, limits concurrency, and recovers after finalize", async () => {
    const path = tempDb();
    const runtime = ManagedRuntime.make(live(path));
    await runtime.runPromise(
      Effect.gen(function* () {
        const keys = yield* ApiKeys;
        const created = yield* keys.createKey({
          name: "admit",
          expiresAt: null,
          policy: oneAtATime,
        });
        const first = yield* keys.admit(created.secret);
        assert.equal(first.keyId, created.key.id);
        const busy = yield* keys.admit(created.secret).pipe(Effect.result);
        assert.equal(busy._tag, "Failure");
        if (busy._tag === "Failure") {
          assert.ok(busy.failure instanceof ConcurrentLimit);
        }
        yield* keys.finalize(first, { status: "success", promptTokens: 10, completionTokens: 4 });
        const second = yield* keys.admit(created.secret);
        assert.notEqual(second.requestId, first.requestId);
        yield* keys.finalize(second, { status: "abandoned" });
      }),
    );
    await runtime.dispose();
  });

  it("rejects invalid tokens without leaking secrets", async () => {
    const path = tempDb();
    const runtime = ManagedRuntime.make(live(path));
    await runtime.runPromise(
      Effect.gen(function* () {
        const keys = yield* ApiKeys;
        const failed = yield* keys.admit("not-a-key").pipe(Effect.result);
        assert.equal(failed._tag, "Failure");
        if (failed._tag === "Failure") {
          assert.ok(failed.failure instanceof AuthFailed);
          assert.equal(failed.failure.message.includes("not-a-key"), false);
        }
      }),
    );
    await runtime.dispose();
  });

  it("rechecks policy version and revocation before dispatch", async () => {
    const path = tempDb();
    const runtime = ManagedRuntime.make(live(path));
    await runtime.runPromise(
      Effect.gen(function* () {
        const keys = yield* ApiKeys;
        const created = yield* keys.createKey({
          name: "recheck",
          expiresAt: null,
          policy: oneAtATime,
        });
        const admission = yield* keys.admit(created.secret);
        yield* keys.updateKey({
          id: created.key.id,
          expectedVersion: created.key.version,
          name: "recheck",
          expiresAt: null,
          policy: { ...POLICY_SUGGESTIONS.Interactive, maxConcurrent: 1, requestsPerMinute: 30 },
        });
        const stale = yield* keys.recheck(admission).pipe(Effect.result);
        assert.equal(stale._tag, "Failure");
        if (stale._tag === "Failure") {
          assert.ok(stale.failure instanceof StaleVersion);
        }
        yield* keys.finalize(admission, { status: "abandoned" });

        const next = yield* keys.admit(created.secret);
        yield* keys.revokeKey(created.key.id);
        const revoked = yield* keys.recheck(next).pipe(Effect.result);
        assert.equal(revoked._tag, "Failure");
        if (revoked._tag === "Failure") {
          assert.ok(revoked.failure instanceof KeyRevoked);
        }
        yield* keys.finalize(next, { status: "abandoned" });
      }),
    );
    await runtime.dispose();
  });

  it("enforces a fixed UTC-minute RPM cap", async () => {
    const path = tempDb();
    const runtime = ManagedRuntime.make(live(path));
    await runtime.runPromise(
      Effect.gen(function* () {
        const keys = yield* ApiKeys;
        const created = yield* keys.createKey({
          name: "rpm",
          expiresAt: null,
          policy: { ...POLICY_SUGGESTIONS.Standard, maxConcurrent: 8, requestsPerMinute: 1 },
        });
        const first = yield* keys.admit(created.secret);
        const limited = yield* keys.admit(created.secret).pipe(Effect.result);
        assert.equal(limited._tag, "Failure");
        if (limited._tag === "Failure") {
          assert.ok(limited.failure instanceof RateLimited);
        }
        yield* keys.finalize(first, { status: "error", errorCode: "cancelled" });
      }),
    );
    await runtime.dispose();
  });

  it("treats a zero limit as unlimited", async () => {
    const path = tempDb();
    const runtime = ManagedRuntime.make(live(path));
    await runtime.runPromise(
      Effect.gen(function* () {
        const keys = yield* ApiKeys;
        const created = yield* keys.createKey({
          name: "unlimited",
          expiresAt: null,
          policy: { ...POLICY_SUGGESTIONS.Standard, maxConcurrent: 0, requestsPerMinute: 0 },
        });
        const leases = [];
        for (let i = 0; i < 5; i += 1) leases.push(yield* keys.admit(created.secret));
        for (const lease of leases) yield* keys.finalize(lease, { status: "success" });
      }),
    );
    await runtime.dispose();
  });

  it("recovers stale leases from another connection", async () => {
    const path = tempDb();
    const runtime = ManagedRuntime.make(live(path));
    const secret = await runtime.runPromise(
      Effect.gen(function* () {
        const keys = yield* ApiKeys;
        const created = yield* keys.createKey({
          name: "stale-lease",
          expiresAt: null,
          policy: oneAtATime,
        });
        yield* keys.admit(created.secret);
        return created.secret;
      }),
    );
    const sqlite = new DatabaseSync(path);
    sqlite.exec("UPDATE requests SET lease_expires_at = 1 WHERE status = 'running'");
    sqlite.close();
    await runtime.runPromise(
      Effect.gen(function* () {
        const keys = yield* ApiKeys;
        const recovered = yield* keys.admit(secret);
        yield* keys.finalize(recovered, { status: "success" });
      }),
    );
    await runtime.dispose();
  });

  it("finalizes on scope release so a later admit can proceed", async () => {
    const path = tempDb();
    const runtime = ManagedRuntime.make(live(path));
    await runtime.runPromise(
      Effect.gen(function* () {
        const keys = yield* ApiKeys;
        const created = yield* keys.createKey({
          name: "finalizer",
          expiresAt: null,
          policy: oneAtATime,
        });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const admission = yield* keys.admit(created.secret);
            yield* Effect.addFinalizer(() =>
              keys
                .finalize(admission, { status: "abandoned" })
                .pipe(Effect.catch(() => Effect.void)),
            );
          }),
        );
        const next = yield* keys.admit(created.secret);
        yield* keys.finalize(next, {
          status: "success",
          promptTokens: null,
          completionTokens: null,
        });
      }),
    );
    await runtime.dispose();
  });

  it("counts unknown usage and zero API price without local COGS separately", async () => {
    const path = tempDb();
    const runtime = ManagedRuntime.make(live(path));
    await runtime.runPromise(
      Effect.gen(function* () {
        const keys = yield* ApiKeys;
        const created = yield* keys.createKey({
          name: "cogs",
          expiresAt: null,
          policy: { ...POLICY_SUGGESTIONS.Standard, maxConcurrent: 4, requestsPerMinute: 30 },
        });
        const a = yield* keys.admit(created.secret);
        yield* keys.finalize(a, {
          status: "success",
          promptTokens: 5,
          completionTokens: 2,
          providerReportedUsd: 0,
          localComputeEstimatedUsd: null,
        });
        const b = yield* keys.admit(created.secret);
        yield* keys.finalize(b, { status: "error" });
        const summary = yield* keys.usageSummary({ keyId: created.key.id });
        assert.equal(summary.successCount, 1);
        assert.equal(summary.errorCount, 1);
        assert.equal(summary.promptTokens, 5);
        assert.equal(summary.missingUsageCount, 1);
        assert.equal(summary.zeroApiPriceMissingLocalCogsCount, 1);
      }),
    );
    await runtime.dispose();
  });
});
