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

  it("serializes striped locks without mixing session state", async () => {
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

  it("lets the next lock succeed after a waiter times out", async () => {
    const store = createSessionStore();
    const hold = await Effect.runPromise(Deferred.make<void>());
    const holder = Effect.runFork(store.withLock("k", "s", 1_000, Deferred.await(hold)));
    await Effect.runPromise(Effect.sleep("20 millis"));
    const timedOut = await Effect.runPromise(
      store.withLock("k", "s", 20, Effect.void).pipe(Effect.result),
    );
    assert.equal(timedOut._tag, "Failure");
    if (timedOut._tag === "Failure") {
      assert.ok(timedOut.failure instanceof LockTimeout);
    }
    await Effect.runPromise(Deferred.succeed(hold, undefined));
    await Effect.runPromise(Fiber.join(holder));
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
    await Effect.runPromise(Deferred.succeed(hold, undefined));
    await Effect.runPromise(Fiber.join(holder));
    const acquired = await Effect.runPromise(
      store.withLock("k", "s", 50, Effect.succeed("acquired")),
    );
    assert.equal(acquired, "acquired");
  });
});
