import { Clock, Deferred, Effect, Exit } from "effect";
import {
  MAX_CAPACITY_WAIT_MS,
  type Deployment as ModelDeployment,
  type KeyPolicy,
  type Priority,
} from "../domain.ts";
import { CapacityBusy } from "../errors.ts";
import { QueueFull } from "./failures.ts";

export const DEFAULT_QUEUE_SLOTS = 128;
export const DEFAULT_POLL_MS = 50;

type Deployment = Pick<ModelDeployment, "id" | "capacity">;
export type WorkPriority = Priority;

export interface Permit {
  readonly deploymentId: string;
  readonly priority: WorkPriority;
  readonly release: () => void;
}

export interface GateSnapshot {
  readonly deploymentId: string;
  readonly runningHigh: number;
  readonly runningMedium: number;
  readonly runningLow: number;
  readonly waiting: number;
}

export interface QueueEvent {
  readonly requestId: string;
  readonly state: "queued" | "dispatched";
  readonly priority: WorkPriority;
  readonly queuedAt: number;
  readonly waitedMs: number;
}

export interface CapacityPool {
  readonly snapshot: (deploymentId: string) => GateSnapshot;
  readonly tryAcquire: (deployment: Deployment, priority: WorkPriority) => Permit | undefined;
  readonly acquire: (
    ranked: readonly Deployment[],
    priority: WorkPriority,
    options: {
      readonly requestId: string;
      readonly waitMs: number;
      readonly spill: boolean;
      readonly onQueue?: (event: QueueEvent) => void;
    },
  ) => Effect.Effect<Permit, CapacityBusy | QueueFull>;
}

interface Gate {
  readonly deploymentId: string;
  readonly maxParallel: number;
  readonly reservedHigh: number;
  runningHigh: number;
  runningMedium: number;
  runningLow: number;
}

interface Waiter {
  readonly id: number;
  readonly requestId: string;
  readonly priority: WorkPriority;
  readonly deployments: readonly Deployment[];
  readonly deferred: Deferred.Deferred<Permit, CapacityBusy>;
  readonly queuedAt: number;
  abandoned: boolean;
  granted: Permit | undefined;
}

const PRIORITY_RANK: Record<WorkPriority, number> = { high: 0, medium: 1, low: 2 };

export function createCapacityPool(options?: { readonly queueSlots?: number }): CapacityPool {
  const queueSlots = options?.queueSlots ?? DEFAULT_QUEUE_SLOTS;
  const gates = new Map<string, Gate>();
  const waiters: Waiter[] = [];
  let nextWaiterId = 1;
  let waking = false;

  const gateFor = (deployment: Deployment): Gate => {
    const existing = gates.get(deployment.id);
    if (existing !== undefined) {
      return existing;
    }
    const created: Gate = {
      deploymentId: deployment.id,
      maxParallel: Math.max(0, deployment.capacity.maxParallel),
      reservedHigh: Math.max(0, deployment.capacity.reservedInteractiveSlots),
      runningHigh: 0,
      runningMedium: 0,
      runningLow: 0,
    };
    gates.set(deployment.id, created);
    return created;
  };

  const runningTotal = (gate: Gate): number =>
    gate.runningHigh + gate.runningMedium + gate.runningLow;

  const canStart = (gate: Gate, priority: WorkPriority): boolean => {
    if (runningTotal(gate) >= gate.maxParallel) {
      return false;
    }
    if (priority !== "high") {
      const nonHighCap = Math.max(0, gate.maxParallel - gate.reservedHigh);
      if (gate.runningMedium + gate.runningLow >= nonHighCap) {
        return false;
      }
    }
    return true;
  };

  const start = (gate: Gate, priority: WorkPriority): Permit | undefined => {
    if (!canStart(gate, priority)) {
      return undefined;
    }
    incrementRunning(gate, priority, 1);
    let released = false;
    return {
      deploymentId: gate.deploymentId,
      priority,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        incrementRunning(gate, priority, -1);
        wake();
      },
    };
  };

  const reclaimWaiter = (waiter: Waiter): void => {
    waiter.abandoned = true;
    const index = waiters.findIndex((entry) => entry.id === waiter.id);
    if (index >= 0) {
      waiters.splice(index, 1);
    }
    const closed = Deferred.doneUnsafe(waiter.deferred, Effect.fail(busyError(waiter.deployments)));
    if (!closed) {
      const permit = waiter.granted;
      waiter.granted = undefined;
      permit?.release();
    }
  };

  const wake = (): void => {
    if (waking) {
      return;
    }
    waking = true;
    try {
      waiters.sort((left, right) => {
        const rank = PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority];
        return rank !== 0 ? rank : left.id - right.id;
      });
      for (let i = 0; i < waiters.length;) {
        const waiter = waiters[i]!;
        if (waiter.abandoned) {
          waiters.splice(i, 1);
          continue;
        }
        const permit = tryRanked(waiter.deployments, waiter.priority, start, gateFor);
        if (permit === undefined) {
          i += 1;
          continue;
        }
        waiters.splice(i, 1);
        waiter.granted = permit;
        const accepted = Deferred.doneUnsafe(waiter.deferred, Effect.succeed(permit));
        if (!accepted || waiter.abandoned) {
          waiter.granted = undefined;
          permit.release();
          continue;
        }
        return;
      }
    } finally {
      waking = false;
    }
  };

  return {
    snapshot(deploymentId) {
      const gate = gates.get(deploymentId);
      if (gate === undefined) {
        return {
          deploymentId,
          runningHigh: 0,
          runningMedium: 0,
          runningLow: 0,
          waiting: waiters.length,
        };
      }
      return {
        deploymentId,
        runningHigh: gate.runningHigh,
        runningMedium: gate.runningMedium,
        runningLow: gate.runningLow,
        waiting: waiters.length,
      };
    },
    tryAcquire(deployment, priority) {
      return start(gateFor(deployment), priority);
    },
    acquire(ranked, priority, options) {
      const waitMs = Math.min(Math.max(0, options.waitMs), MAX_CAPACITY_WAIT_MS);
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const immediate = tryRanked(ranked, priority, start, gateFor);
          if (immediate !== undefined) {
            return immediate;
          }
          if (waitMs === 0) {
            return yield* Effect.fail(busyError(ranked));
          }
          if (waiters.length >= queueSlots) {
            return yield* Effect.fail(
              new QueueFull({ waiting: waiters.length, limit: queueSlots }),
            );
          }
          const queuedAt = yield* Clock.currentTimeMillis;
          const deferred = yield* Deferred.make<Permit, CapacityBusy>();
          const waiter: Waiter = {
            id: nextWaiterId++,
            requestId: options.requestId,
            priority,
            deployments: ranked,
            deferred,
            queuedAt,
            abandoned: false,
            granted: undefined,
          };
          waiters.push(waiter);
          options.onQueue?.({
            requestId: options.requestId,
            state: "queued",
            priority,
            queuedAt,
            waitedMs: 0,
          });
          const permit = yield* Effect.onExit(
            restore(
              Effect.raceFirst(
                Deferred.await(deferred),
                Effect.andThen(Effect.sleep(`${waitMs} millis`), Effect.fail(busyError(ranked))),
              ),
            ),
            (exit) =>
              Effect.sync(() => {
                if (!Exit.isSuccess(exit)) {
                  reclaimWaiter(waiter);
                }
              }),
          );
          const now = yield* Clock.currentTimeMillis;
          options.onQueue?.({
            requestId: options.requestId,
            state: "dispatched",
            priority,
            queuedAt,
            waitedMs: Math.max(0, now - queuedAt),
          });
          return permit;
        }),
      );
    },
  };
}

function incrementRunning(gate: Gate, priority: WorkPriority, delta: number): void {
  if (priority === "high") {
    gate.runningHigh += delta;
    return;
  }
  if (priority === "medium") {
    gate.runningMedium += delta;
    return;
  }
  gate.runningLow += delta;
}

function tryRanked(
  ranked: readonly Deployment[],
  priority: WorkPriority,
  start: (gate: Gate, priority: WorkPriority) => Permit | undefined,
  gateFor: (deployment: Deployment) => Gate,
): Permit | undefined {
  for (const deployment of ranked) {
    const permit = start(gateFor(deployment), priority);
    if (permit !== undefined) {
      return permit;
    }
  }
  return undefined;
}

function busyError(ranked: readonly Deployment[]): CapacityBusy {
  const id = ranked[0]?.id;
  return new CapacityBusy({
    message: id === undefined ? "all-busy" : `all-busy:${id}`,
  });
}

export function waitBudgetMs(policy: KeyPolicy): number {
  return Math.min(Math.max(0, policy.maxWaitMs), MAX_CAPACITY_WAIT_MS);
}

export { preferredLocationFromBias as preferredLocation } from "./locality.ts";
export { cloudSpillPermitted as spillAllowed } from "./locality.ts";
