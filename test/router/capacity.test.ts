import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Effect, Fiber } from "effect";
import { createCapacityPool } from "../../src/router/capacity.ts";
import { QueueFull } from "../../src/router/failures.ts";
import { localQwen, cloudGlm } from "./fixtures.ts";

describe("capacity", () => {
  it("returns retryable all-busy rather than no-eligible", async () => {
    const pool = createCapacityPool();
    const first = pool.tryAcquire(localQwen, "high");
    const second = pool.tryAcquire(localQwen, "high");
    assert.ok(first);
    assert.ok(second);
    await Effect.runPromise(
      pool.acquire([localQwen], "high", { requestId: "r1", waitMs: 0 }).pipe(
        Effect.match({
          onFailure: (error) => {
            assert.equal(error._tag, "CapacityBusy");
            assert.match(error.message, /all-busy/);
          },
          onSuccess: () => {
            throw new Error("expected all-busy");
          },
        }),
      ),
    );
    first.release();
    second.release();
  });

  it("does not let low work occupy the high reserve", () => {
    const tight = { ...localQwen, capacity: { maxParallel: 2, reservedInteractiveSlots: 1 } };
    const pool = createCapacityPool();
    const high = pool.tryAcquire(tight, "high");
    const low = pool.tryAcquire(tight, "low");
    const low2 = pool.tryAcquire(tight, "low");
    assert.ok(high);
    assert.ok(low);
    assert.equal(low2, undefined);
    const snap = pool.snapshot(tight.id);
    assert.equal(snap.runningHigh, 1);
    assert.equal(snap.runningLow, 1);
    high.release();
    low.release();
  });

  it("separates waiting from running and distinguishes queue-full", async () => {
    const pool = createCapacityPool({ queueSlots: 1 });
    const held = pool.tryAcquire(localQwen, "high");
    const held2 = pool.tryAcquire(localQwen, "high");
    assert.ok(held);
    assert.ok(held2);
    const waiter = Effect.runPromise(
      pool.acquire([localQwen], "medium", { requestId: "wait", waitMs: 5_000 }).pipe(Effect.result),
    );
    await Effect.runPromise(Effect.sleep("20 millis"));
    assert.equal(pool.snapshot(localQwen.id).waiting, 1);
    await Effect.runPromise(
      pool.acquire([localQwen], "low", { requestId: "full", waitMs: 5_000 }).pipe(
        Effect.match({
          onFailure: (error) => {
            assert.equal(error._tag, "QueueFull");
            assert.ok(error instanceof QueueFull);
          },
          onSuccess: () => {
            throw new Error("expected queue full");
          },
        }),
      ),
    );
    held.release();
    held2.release();
    await waiter;
  });

  it("releases permits on interruption", async () => {
    const pool = createCapacityPool();
    const held = pool.tryAcquire(localQwen, "high");
    const held2 = pool.tryAcquire(localQwen, "high");
    assert.ok(held);
    assert.ok(held2);
    const fiber = Effect.runFork(
      pool.acquire([localQwen], "high", { requestId: "int", waitMs: 30_000 }),
    );
    await Effect.runPromise(Effect.sleep("20 millis"));
    assert.equal(pool.snapshot(localQwen.id).waiting, 1);
    await Effect.runPromise(Fiber.interrupt(fiber));
    await Effect.runPromise(Effect.sleep("20 millis"));
    assert.equal(pool.snapshot(localQwen.id).waiting, 0);
    assert.equal(pool.snapshot(localQwen.id).runningHigh, 2);
    held.release();
    held2.release();
    assert.equal(pool.snapshot(localQwen.id).runningHigh, 0);
    const next = pool.tryAcquire(localQwen, "high");
    assert.ok(next);
    next.release();
  });

  it("does not leak a permit when a queued waiter times out", async () => {
    const pool = createCapacityPool();
    const held = pool.tryAcquire(localQwen, "high");
    const held2 = pool.tryAcquire(localQwen, "high");
    assert.ok(held);
    assert.ok(held2);
    const result = await Effect.runPromise(
      pool.acquire([localQwen], "high", { requestId: "timeout", waitMs: 25 }).pipe(Effect.result),
    );
    assert.equal(result._tag, "Failure");
    assert.equal(pool.snapshot(localQwen.id).waiting, 0);
    assert.equal(pool.snapshot(localQwen.id).runningHigh, 2);
    held.release();
    held2.release();
    assert.equal(pool.snapshot(localQwen.id).runningHigh, 0);
    const next = pool.tryAcquire(localQwen, "high");
    assert.ok(next);
    next.release();
  });

  it("reclaims a permit if wake races with waiter cancellation", async () => {
    const pool = createCapacityPool();
    const held = pool.tryAcquire(localQwen, "high");
    const held2 = pool.tryAcquire(localQwen, "high");
    assert.ok(held);
    assert.ok(held2);
    const fiber = Effect.runFork(
      pool.acquire([localQwen], "high", { requestId: "handoff", waitMs: 30_000 }),
    );
    await Effect.runPromise(Effect.sleep("20 millis"));
    assert.equal(pool.snapshot(localQwen.id).waiting, 1);
    held.release();
    held2.release();
    await Effect.runPromise(Fiber.interrupt(fiber));
    const exit = await Effect.runPromise(Fiber.await(fiber));
    if (exit._tag === "Success") {
      exit.value.release();
    }
    assert.equal(pool.snapshot(localQwen.id).waiting, 0);
    assert.equal(pool.snapshot(localQwen.id).runningHigh, 0);
    const next = pool.tryAcquire(localQwen, "high");
    assert.ok(next);
    next.release();
  });

  it("spills to another eligible deployment only when allowed", async () => {
    const pool = createCapacityPool();
    const a = pool.tryAcquire(localQwen, "high");
    const b = pool.tryAcquire(localQwen, "high");
    assert.ok(a);
    assert.ok(b);
    const permit = await Effect.runPromise(
      pool.acquire([localQwen, cloudGlm], "high", { requestId: "spill", waitMs: 0 }),
    );
    assert.equal(permit.deploymentId, "cloud-glm");
    permit.release();
    a.release();
    b.release();
  });

  it("atomically refuses idle-only acquisition when foreground work appears", () => {
    const pool = createCapacityPool();
    let checks = 0;
    const permit = pool.tryAcquireIdleOnly([localQwen], "low", () => {
      checks += 1;
      return checks === 1;
    });
    assert.equal(permit, undefined);
    assert.equal(checks, 2);
    assert.equal(pool.snapshot(localQwen.id).runningLow, 0);
    assert.equal(pool.snapshot(localQwen.id).waiting, 0);
  });

  it("keeps reserved interactive slots out of the deferred lane", () => {
    const tight = {
      ...localQwen,
      capacity: { maxParallel: 2, reservedInteractiveSlots: 1 },
    };
    const pool = createCapacityPool();
    const deferred = pool.tryAcquireIdleOnly([tight], "high", () => true);
    assert.ok(deferred);
    assert.equal(pool.snapshot(tight.id).runningLow, 1);
    assert.equal(pool.snapshot(tight.id).runningHigh, 0);
    assert.equal(
      pool.tryAcquireIdleOnly([tight], "high", () => true),
      undefined,
    );
    const interactive = pool.tryAcquire(tight, "high");
    assert.ok(interactive);
    deferred.release();
    interactive.release();
  });
});
