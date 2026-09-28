import { Deferred, Effect, Exit } from "effect";

/**
 * The router-side flex queue: per deployment, requests wait FIFO and at most
 * `limit` hold a slot at once. Only a slot holder talks to Gufo, so a queue of
 * waiting flex requests never polls it; the holder retries Gufo's refusals.
 */
export interface FlexQueue {
  /** Wait (interruptibly) for a slot; the returned release is idempotent. */
  readonly acquire: (deploymentId: string, limit: number) => Effect.Effect<() => void>;
  readonly snapshot: (deploymentId: string) => { readonly held: number; readonly waiting: number };
}

interface Lane {
  limit: number;
  held: number;
  readonly waiters: Deferred.Deferred<void>[];
}

export function createFlexQueue(): FlexQueue {
  const lanes = new Map<string, Lane>();

  const wake = (lane: Lane): void => {
    while (lane.held < lane.limit && lane.waiters.length > 0) {
      if (Deferred.doneUnsafe(lane.waiters.shift()!, Effect.void)) lane.held += 1;
    }
  };
  const releaser = (lane: Lane) => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      lane.held -= 1;
      wake(lane);
    };
  };

  return {
    snapshot: (deploymentId) => {
      const lane = lanes.get(deploymentId);
      return { held: lane?.held ?? 0, waiting: lane?.waiters.length ?? 0 };
    },
    acquire: (deploymentId, limit) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          let lane = lanes.get(deploymentId);
          if (lane === undefined) {
            lane = { limit, held: 0, waiters: [] };
            lanes.set(deploymentId, lane);
          }
          const current = lane;
          // ponytail: at least one slot, so a queue always makes progress (and learns a
          // raised limit); with `--flex-sessions 0` that holder just meets Gufo's refusals.
          current.limit = Math.max(1, limit);
          wake(current);
          if (current.waiters.length === 0 && current.held < current.limit) {
            current.held += 1;
            return releaser(current);
          }
          const turn = yield* Deferred.make<void>();
          current.waiters.push(turn);
          yield* Effect.onExit(restore(Deferred.await(turn)), (exit) =>
            Effect.sync(() => {
              if (Exit.isSuccess(exit)) return;
              const index = current.waiters.indexOf(turn);
              if (index >= 0) current.waiters.splice(index, 1);
              // Granted as the waiter gave up: hand the slot straight on.
              else releaser(current)();
            }),
          );
          return releaser(current);
        }),
      ),
  };
}
