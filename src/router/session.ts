import { Deferred, Effect, Exit } from "effect";
import type { SessionPin } from "../domain.ts";
import { LockTimeout } from "./failures.ts";

export const DEFAULT_SESSION_CAPACITY = 2048;
export const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;
export const SESSION_STRIPES = 128;
export const DEFAULT_LOCK_WAIT_MS = 10_000;
export const CHECKPOINT_SCORE_MARGIN = 0.08;

export interface SessionStore {
  readonly get: (keyId: string, sessionId: string, nowMs: number) => SessionPin | undefined;
  readonly set: (keyId: string, sessionId: string, pin: SessionPin) => void;
  readonly withLock: <A, E, R>(
    keyId: string,
    sessionId: string,
    lockWaitMs: number,
    use: Effect.Effect<A, E, R>,
    releaseAfter?: (value: A, release: () => void) => void,
  ) => Effect.Effect<A, E | LockTimeout, R>;
}

export function createSessionStore(options?: {
  readonly capacity?: number;
  readonly ttlMs?: number;
}): SessionStore {
  const capacity = options?.capacity ?? DEFAULT_SESSION_CAPACITY;
  const ttlMs = options?.ttlMs ?? DEFAULT_SESSION_TTL_MS;
  const entries = new Map<string, SessionPin>();
  const stripes: StripeLock[] = [];
  for (let i = 0; i < SESSION_STRIPES; i++) {
    stripes.push(new StripeLock());
  }

  return {
    get(keyId, sessionId, nowMs) {
      const id = sessionKey(keyId, sessionId);
      const pin = entries.get(id);
      if (pin === undefined) {
        return undefined;
      }
      if (nowMs - pin.createdAt > ttlMs) {
        entries.delete(id);
        return undefined;
      }
      entries.delete(id);
      entries.set(id, pin);
      return pin;
    },
    set(keyId, sessionId, pin) {
      const id = sessionKey(keyId, sessionId);
      if (entries.has(id)) {
        entries.delete(id);
      }
      entries.set(id, pin);
      while (entries.size > capacity) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        entries.delete(oldest);
      }
    },
    withLock(keyId, sessionId, lockWaitMs, use, releaseAfter) {
      const stripe = stripes[stripeIndex(keyId, sessionId)]!;
      return stripe.withLock(lockWaitMs, sessionId, use, releaseAfter);
    },
  };
}

function sessionKey(keyId: string, sessionId: string): string {
  return `${keyId}\0${sessionId}`;
}

function stripeIndex(keyId: string, sessionId: string): number {
  const text = sessionKey(keyId, sessionId);
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (Math.imul(hash, 31) + text.charCodeAt(i)) | 0;
  }
  return (hash >>> 0) % SESSION_STRIPES;
}

interface StripeWaiter {
  readonly deferred: Deferred.Deferred<void, LockTimeout>;
  abandoned: boolean;
}

class StripeLock {
  private taken = false;
  private readonly waiters: StripeWaiter[] = [];

  withLock<A, E, R>(
    lockWaitMs: number,
    sessionId: string,
    use: Effect.Effect<A, E, R>,
    releaseAfter?: (value: A, release: () => void) => void,
  ): Effect.Effect<A, E | LockTimeout, R> {
    return Effect.uninterruptibleMask((restore) =>
      Effect.flatMap(this.acquire(lockWaitMs, sessionId, restore), () =>
        Effect.onExit(restore(use), (exit) => {
          if (!Exit.isSuccess(exit) || releaseAfter === undefined) return this.release();
          return Effect.sync(() => {
            let released = false;
            const release = () => {
              if (!released) {
                released = true;
                this.transferOrFree();
              }
            };
            try {
              releaseAfter(exit.value, release);
            } catch (error) {
              release();
              throw error;
            }
          });
        }),
      ),
    );
  }

  private acquire(
    lockWaitMs: number,
    sessionId: string,
    restore: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
  ): Effect.Effect<void, LockTimeout> {
    return Effect.suspend(() => {
      if (!this.taken) {
        this.taken = true;
        return Effect.void;
      }
      return Effect.flatMap(Deferred.make<void, LockTimeout>(), (deferred) => {
        const waiter: StripeWaiter = { deferred, abandoned: false };
        this.waiters.push(waiter);
        return Effect.onExit(
          restore(
            Effect.raceFirst(
              Deferred.await(deferred),
              Effect.andThen(
                Effect.sleep(`${lockWaitMs} millis`),
                Effect.fail(new LockTimeout({ sessionId })),
              ),
            ),
          ),
          (exit) =>
            Effect.sync(() => {
              if (!Exit.isSuccess(exit)) {
                this.abandon(waiter, sessionId);
              }
            }),
        );
      });
    });
  }

  private abandon(waiter: StripeWaiter, sessionId: string): void {
    waiter.abandoned = true;
    const index = this.waiters.indexOf(waiter);
    if (index >= 0) {
      this.waiters.splice(index, 1);
    }
    const closed = Deferred.doneUnsafe(
      waiter.deferred,
      Effect.fail(new LockTimeout({ sessionId })),
    );
    if (!closed) {
      this.transferOrFree();
    }
  }

  private release(): Effect.Effect<void> {
    return Effect.sync(() => {
      this.transferOrFree();
    });
  }

  private transferOrFree(): void {
    while (this.waiters.length > 0) {
      const next = this.waiters.shift()!;
      if (next.abandoned) {
        continue;
      }
      if (Deferred.doneUnsafe(next.deferred, Effect.void)) {
        return;
      }
    }
    this.taken = false;
  }
}
