import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Deferred, Effect, Fiber } from "effect";
import { continuityKey } from "../../src/router/continuity.ts";
import { LockTimeout } from "../../src/router/failures.ts";
import { createSessionStore } from "../../src/router/session.ts";
import { greeting } from "./fixtures.ts";

describe("session pins", () => {
  it("isolates pins by key and session", () => {
    const store = createSessionStore();
    store.set("key-a", "sess-1", {
      deploymentId: "local-qwen",
      requestedEffort: "low",
      appliedEffort: "low",
      continuityKey: "aaa",
      assessment: greeting,
      createdAt: 1,
    });
    store.set("key-b", "sess-1", {
      deploymentId: "cloud-glm",
      requestedEffort: "high",
      appliedEffort: "high",
      continuityKey: "bbb",
      assessment: greeting,
      createdAt: 1,
    });
    assert.equal(store.get("key-a", "sess-1", 1)?.deploymentId, "local-qwen");
    assert.equal(store.get("key-b", "sess-1", 1)?.deploymentId, "cloud-glm");
    assert.equal(store.get("key-a", "sess-2", 1), undefined);
  });

  it("expires pins rather than inventing continuity", () => {
    const store = createSessionStore({ ttlMs: 10 });
    store.set("key-a", "sess-1", {
      deploymentId: "local-qwen",
      requestedEffort: "low",
      appliedEffort: "low",
      continuityKey: "aaa",
      assessment: greeting,
      createdAt: 0,
    });
    assert.equal(store.get("key-a", "sess-1", 11), undefined);
  });

  it("changes continuity when tools change", () => {
    const messages = [{ role: "system", content: "You are a coding agent." }];
    const first = continuityKey({
      messages,
      tools: [{ name: "read" }],
      toolChoice: "auto",
      responseFormat: null,
    });
    const second = continuityKey({
      messages,
      tools: [{ name: "write" }],
      toolChoice: "auto",
      responseFormat: null,
    });
    assert.notEqual(first, second);
  });

  it("serializes requests for the same session without mixing state", async () => {
    const store = createSessionStore();
    const seen: string[] = [];
    await Effect.runPromise(
      Effect.all(
        [
          store.withLock(
            "k",
            "s",
            1000,
            Effect.sync(() => seen.push("a")),
          ),
          store.withLock(
            "k",
            "s",
            1000,
            Effect.sync(() => seen.push("b")),
          ),
        ],
        { concurrency: 2 },
      ),
    );
    assert.deepEqual(seen.sort(), ["a", "b"]);
  });

  it("does not wait behind a different session that formerly shared a stripe", async () => {
    const oldStripe = (keyId: string, sessionId: string): number => {
      const text = keyId + "\0" + sessionId;
      let hash = 0;
      for (let i = 0; i < text.length; i++) {
        hash = (Math.imul(hash, 31) + text.charCodeAt(i)) | 0;
      }
      return (hash >>> 0) % 128;
    };
    const first = "session-0";
    const second = Array.from({ length: 1000 }, (_, i) => "session-" + (i + 1)).find(
      (id) => oldStripe("k", id) === oldStripe("k", first),
    );
    assert.ok(second, "expected two distinct sessions with the old striped hash");

    const store = createSessionStore();
    const entered = await Effect.runPromise(Deferred.make<void>());
    const hold = await Effect.runPromise(Deferred.make<void>());
    const holder = Effect.runFork(
      store.withLock(
        "k",
        first,
        1_000,
        Effect.andThen(Deferred.succeed(entered, undefined), Deferred.await(hold)),
      ),
    );
    try {
      await Effect.runPromise(Deferred.await(entered));
      const result = await Effect.runPromise(
        store.withLock("k", second, 50, Effect.succeed("unrelated request completed")),
      );
      assert.equal(result, "unrelated request completed");
    } finally {
      await Effect.runPromise(Deferred.succeed(hold, undefined));
      await Effect.runPromise(Fiber.join(holder));
    }
  });

  it("lets the next lock succeed after a waiter times out", async () => {
    const store = createSessionStore();
    const hold = await Effect.runPromise(Deferred.make<void>());
    const holder = Effect.runFork(store.withLock("k", "s", 1_000, Deferred.await(hold)));
    await Effect.runPromise(Effect.sleep("20 millis"));
    const timedOut = await Effect.runPromise(
      store.withLock("k", "s", 20, Effect.void).pipe(Effect.result),
    );
    assert.equal(timedOut._tag, "Failure");
    assert.equal(store.activeLockCount(), 1);
    if (timedOut._tag === "Failure") {
      assert.ok(timedOut.failure instanceof LockTimeout);
    }
    await Effect.runPromise(Deferred.succeed(hold, undefined));
    await Effect.runPromise(Fiber.join(holder));
    assert.equal(store.activeLockCount(), 0);
    const acquired = await Effect.runPromise(
      store.withLock("k", "s", 50, Effect.succeed("acquired")),
    );
    assert.equal(acquired, "acquired");
  });

  it("lets the next lock succeed after an abandoned waiter is interrupted", async () => {
    const store = createSessionStore();
    const hold = await Effect.runPromise(Deferred.make<void>());
    const holder = Effect.runFork(store.withLock("k", "s", 5_000, Deferred.await(hold)));
    await Effect.runPromise(Effect.sleep("20 millis"));
    const waiter = Effect.runFork(store.withLock("k", "s", 5_000, Effect.void));
    await Effect.runPromise(Effect.sleep("20 millis"));
    await Effect.runPromise(Fiber.interrupt(waiter));
    assert.equal(store.activeLockCount(), 1);
    await Effect.runPromise(Deferred.succeed(hold, undefined));
    await Effect.runPromise(Fiber.join(holder));
    assert.equal(store.activeLockCount(), 0);
    const acquired = await Effect.runPromise(
      store.withLock("k", "s", 50, Effect.succeed("acquired")),
    );
    assert.equal(acquired, "acquired");
  });

  it("retains a streamed owner until its release callback runs", async () => {
    const store = createSessionStore();
    let releaseStream: () => void = () => assert.fail("missing stream release callback");
    await Effect.runPromise(
      store.withLock("k", "s", 100, Effect.succeed("stream"), (_value, release) => {
        releaseStream = release;
      }),
    );
    assert.equal(store.activeLockCount(), 1);
    const blocked = await Effect.runPromise(
      store.withLock("k", "s", 5, Effect.succeed("wrong owner")).pipe(Effect.result),
    );
    assert.equal(blocked._tag, "Failure");
    if (blocked._tag === "Failure") assert.ok(blocked.failure instanceof LockTimeout);
    assert.equal(store.activeLockCount(), 1);
    releaseStream();
    assert.equal(store.activeLockCount(), 0);
    assert.equal(
      await Effect.runPromise(store.withLock("k", "s", 5, Effect.succeed("next owner"))),
      "next owner",
    );
  });

  it("removes locks when owners fail or are interrupted", async () => {
    const store = createSessionStore();
    const failed = await Effect.runPromise(
      store.withLock("k", "failed", 100, Effect.fail("upstream failure")).pipe(Effect.result),
    );
    assert.equal(failed._tag, "Failure");
    assert.equal(store.activeLockCount(), 0);

    await assert.rejects(
      Effect.runPromise(
        store.withLock("k", "handoff", 100, Effect.succeed("response"), () => {
          throw new Error("handoff failed");
        }),
      ),
      /handoff failed/,
    );
    assert.equal(store.activeLockCount(), 0);

    const entered = await Effect.runPromise(Deferred.make<void>());
    const hold = await Effect.runPromise(Deferred.make<void>());
    const owner = Effect.runFork(
      store.withLock(
        "k",
        "interrupted",
        100,
        Effect.andThen(Deferred.succeed(entered, undefined), Deferred.await(hold)),
      ),
    );
    await Effect.runPromise(Deferred.await(entered));
    assert.equal(store.activeLockCount(), 1);
    await Effect.runPromise(Fiber.interrupt(owner));
    assert.equal(store.activeLockCount(), 0);
  });

  it("reclaims exact locks after unique sessions and interrupted waiters", async () => {
    const store = createSessionStore();
    for (let i = 0; i < 10_000; i++) {
      const id = "session-" + i;
      await Effect.runPromise(store.withLock("k", id, 100, Effect.void));
      assert.equal(store.activeLockCount(), 0);
      if (i % 1000 !== 0) continue;

      const entered = await Effect.runPromise(Deferred.make<void>());
      const hold = await Effect.runPromise(Deferred.make<void>());
      const holder = Effect.runFork(
        store.withLock(
          "k",
          id,
          1000,
          Effect.andThen(Deferred.succeed(entered, undefined), Deferred.await(hold)),
        ),
      );
      await Effect.runPromise(Deferred.await(entered));
      const waiter = Effect.runFork(store.withLock("k", id, 1000, Effect.void));
      await Effect.runPromise(Effect.sleep("1 millis"));
      assert.equal(store.activeLockCount(), 1);
      await Effect.runPromise(Fiber.interrupt(waiter));
      assert.equal(store.activeLockCount(), 1);
      await Effect.runPromise(Deferred.succeed(hold, undefined));
      await Effect.runPromise(Fiber.join(holder));
      assert.equal(store.activeLockCount(), 0);
    }
  });
});
