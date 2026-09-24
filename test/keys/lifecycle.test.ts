import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import { Effect, Layer, ManagedRuntime } from "effect";
import { POLICY_SUGGESTIONS } from "../../src/domain.ts";
import { KeyNotFound, KeyRevoked, PepperMismatch, StaleVersion } from "../../src/errors.ts";
import { sqliteDatabaseLayer } from "../../src/db/sqlite.ts";
import { ApiKeys, apiKeysLayer } from "../../src/keys/api-keys.ts";
import { keyRepositoryLayer } from "../../src/keys/repository.ts";
import { parseApiKey } from "../../src/keys/crypto.ts";

const dirs: string[] = [];

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "llm-router-keys-"));
  dirs.push(dir);
  return join(dir, "control.sqlite");
}

after(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function live(path: string, pepper: string) {
  return apiKeysLayer.pipe(
    Layer.provideMerge(keyRepositoryLayer({ pepper })),
    Layer.provide(sqliteDatabaseLayer(path)),
  );
}

describe("key lifecycle", () => {
  it("creates, lists without the secret, updates, rotates, and revokes", async () => {
    const path = tempDb();
    const runtime = ManagedRuntime.make(live(path, "pepper-a"));
    await runtime.runPromise(
      Effect.gen(function* () {
        const keys = yield* ApiKeys;
        const created = yield* keys.createKey({
          name: "agent",
          expiresAt: null,
          policy: POLICY_SUGGESTIONS.Balanced,
        });
        assert.ok(parseApiKey(created.secret));
        assert.equal(created.key.policy.localityBias, POLICY_SUGGESTIONS.Balanced.localityBias);
        const listed = yield* keys.listKeys({});
        assert.equal(listed.items.length, 1);
        assert.equal("secret" in listed.items[0]!, false);
        assert.equal(listed.items[0]?.prefix, created.key.prefix);

        const updated = yield* keys.updateKey({
          id: created.key.id,
          expectedVersion: created.key.version,
          name: "agent-2",
          expiresAt: null,
          policy: POLICY_SUGGESTIONS.Dylan,
        });
        assert.equal(updated.policy.priority, "high");
        assert.equal(updated.policy.localityBias, POLICY_SUGGESTIONS.Dylan.localityBias);
        assert.equal(updated.version, created.key.version + 1);

        const rotated = yield* keys.rotateKey({
          id: created.key.id,
          expectedVersion: updated.version,
        });
        assert.notEqual(rotated.secret, created.secret);
        const old = yield* keys.getKey(created.key.id);
        assert.notEqual(old.revokedAt, null);

        const revoked = yield* keys.revokeKey(rotated.key.id);
        assert.notEqual(revoked.revokedAt, null);
        const again = yield* keys.revokeKey(rotated.key.id);
        assert.equal(again.revokedAt, revoked.revokedAt);
      }),
    );
    await runtime.dispose();
  });

  it("persists failover, defaults historical rows, and preserves action on legacy full-policy edits", async () => {
    const path = tempDb();
    const runtime = ManagedRuntime.make(live(path, "pepper-a"));
    await runtime.runPromise(
      Effect.gen(function* () {
        const keys = yield* ApiKeys;
        const created = yield* keys.createKey({
          name: "policy",
          expiresAt: null,
          policy: { ...POLICY_SUGGESTIONS.Balanced, overloadAction: "failover" },
        });
        assert.equal((yield* keys.getKey(created.key.id)).policy.overloadAction, "failover");

        const { overloadAction: _omitted, ...oldClientPolicy } = POLICY_SUGGESTIONS.Dylan;
        const updated = yield* keys.updateKey({
          id: created.key.id,
          expectedVersion: created.key.version,
          name: "edited",
          expiresAt: null,
          policy: oldClientPolicy,
        });
        assert.equal(updated.policy.overloadAction, "failover");
        assert.equal(updated.policy.priority, "high");

        const database = new DatabaseSync(path);
        database
          .prepare("UPDATE api_keys SET policy_json = ? WHERE id = ?")
          .run(JSON.stringify(oldClientPolicy), created.key.id);
        database.close();
        const historical = yield* keys.getKey(created.key.id);
        assert.equal(historical.policy.overloadAction, "report");
        const optedIn = yield* keys.updateKey({
          id: created.key.id,
          expectedVersion: historical.version,
          name: "opted in",
          expiresAt: null,
          policy: { ...oldClientPolicy, overloadAction: "failover" },
        });
        assert.equal((yield* keys.getKey(created.key.id)).policy.overloadAction, "failover");
        assert.equal(optedIn.policy.overloadAction, "failover");
      }),
    );
    await runtime.dispose();
  });
  it("rejects stale version updates and rolls the transaction back", async () => {
    const path = tempDb();
    const runtime = ManagedRuntime.make(live(path, "pepper-a"));
    await runtime.runPromise(
      Effect.gen(function* () {
        const keys = yield* ApiKeys;
        const created = yield* keys.createKey({
          name: "stale",
          expiresAt: null,
          policy: POLICY_SUGGESTIONS.Balanced,
        });
        const first = yield* keys.updateKey({
          id: created.key.id,
          expectedVersion: created.key.version,
          name: "stale-1",
          expiresAt: null,
          policy: POLICY_SUGGESTIONS.Dylan,
        });
        const stale = yield* keys
          .updateKey({
            id: created.key.id,
            expectedVersion: created.key.version,
            name: "should-not-stick",
            expiresAt: null,
            policy: POLICY_SUGGESTIONS["Free Vibecode"],
          })
          .pipe(Effect.result);
        assert.equal(stale._tag, "Failure");
        if (stale._tag === "Failure") {
          assert.ok(stale.failure instanceof StaleVersion);
        }
        const current = yield* keys.getKey(created.key.id);
        assert.equal(current.name, "stale-1");
        assert.equal(current.version, first.version);
        assert.equal(current.policy.priority, "high");
      }),
    );
    await runtime.dispose();
  });

  it("fails closed on a pepper mismatch", async () => {
    const path = tempDb();
    const first = ManagedRuntime.make(live(path, "pepper-a"));
    await first.runPromise(
      Effect.gen(function* () {
        const keys = yield* ApiKeys;
        yield* keys.createKey({
          name: "keep",
          expiresAt: null,
          policy: POLICY_SUGGESTIONS.Balanced,
        });
      }),
    );
    await first.dispose();
    const second = ManagedRuntime.make(live(path, "pepper-b"));
    await assert.rejects(
      () => second.runPromise(Effect.void),
      (error: unknown) => error instanceof PepperMismatch,
    );
    await second.dispose();
  });

  it("does not reactivate a revoked key", async () => {
    const path = tempDb();
    const runtime = ManagedRuntime.make(live(path, "pepper-a"));
    await runtime.runPromise(
      Effect.gen(function* () {
        const keys = yield* ApiKeys;
        const created = yield* keys.createKey({
          name: "gone",
          expiresAt: null,
          policy: POLICY_SUGGESTIONS.Balanced,
        });
        yield* keys.revokeKey(created.key.id);
        const update = yield* keys
          .updateKey({
            id: created.key.id,
            expectedVersion: created.key.version + 1,
            name: "resurrect",
            expiresAt: null,
            policy: POLICY_SUGGESTIONS.Dylan,
          })
          .pipe(Effect.result);
        assert.equal(update._tag, "Failure");
        if (update._tag === "Failure") {
          assert.ok(update.failure instanceof KeyRevoked);
        }
      }),
    );
    await runtime.dispose();
  });

  it("returns KeyNotFound for unknown ids", async () => {
    const path = tempDb();
    const runtime = ManagedRuntime.make(live(path, "pepper-a"));
    await runtime.runPromise(
      Effect.gen(function* () {
        const keys = yield* ApiKeys;
        const missing = yield* keys.getKey("missing").pipe(Effect.result);
        assert.equal(missing._tag, "Failure");
        if (missing._tag === "Failure") {
          assert.ok(missing.failure instanceof KeyNotFound);
        }
      }),
    );
    await runtime.dispose();
  });
});
