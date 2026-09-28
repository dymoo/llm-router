import assert from "node:assert/strict";
import { it } from "node:test";
import { Effect, Fiber } from "effect";
import { createFlexQueue } from "../../src/router/flex.ts";

it("grants flex slots FIFO up to the limit and hands a released slot to the next waiter", async () => {
  const queue = createFlexQueue();
  const order: string[] = [];
  await Effect.runPromise(
    Effect.gen(function* () {
      const first = yield* queue.acquire("gufo", 1);
      const waiters = yield* Effect.forEach(["b", "c"], (id) =>
        Effect.forkChild(
          queue.acquire("gufo", 1).pipe(Effect.tap(() => Effect.sync(() => order.push(id)))),
        ),
      );
      yield* Effect.yieldNow;
      assert.deepEqual(queue.snapshot("gufo"), { held: 1, waiting: 2 });
      first();
      first(); // idempotent
      const second = yield* Fiber.join(waiters[0]!);
      assert.deepEqual(order, ["b"]);
      second();
      const third = yield* Fiber.join(waiters[1]!);
      assert.deepEqual(order, ["b", "c"]);
      third();
      assert.deepEqual(queue.snapshot("gufo"), { held: 0, waiting: 0 });
    }),
  );
});

it("a waiter that gives up leaves the queue without leaking a slot", async () => {
  const queue = createFlexQueue();
  await Effect.runPromise(
    Effect.gen(function* () {
      const held = yield* queue.acquire("gufo", 1);
      const gaveUp = yield* queue.acquire("gufo", 1).pipe(Effect.timeoutOption("20 millis"));
      assert.equal(gaveUp._tag, "None");
      assert.deepEqual(queue.snapshot("gufo"), { held: 1, waiting: 0 });
      held();
      const next = yield* queue.acquire("gufo", 1);
      next();
      assert.deepEqual(queue.snapshot("gufo"), { held: 0, waiting: 0 });
    }),
  );
});
