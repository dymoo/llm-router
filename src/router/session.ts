export const DEFAULT_SESSION_CAPACITY = 2048;
export const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;

/**
 * Session stickiness: the deployment a key's session last ran on, so the next
 * turn can try it first (warm prefix cache). Best effort only: a missing,
 * expired or evicted entry just routes normally.
 */
export interface SessionStore {
  readonly get: (keyId: string, sessionId: string, nowMs: number) => string | undefined;
  readonly set: (keyId: string, sessionId: string, deploymentId: string, nowMs: number) => void;
}

export function createSessionStore(options?: {
  readonly capacity?: number;
  readonly ttlMs?: number;
}): SessionStore {
  const capacity = options?.capacity ?? DEFAULT_SESSION_CAPACITY;
  const ttlMs = options?.ttlMs ?? DEFAULT_SESSION_TTL_MS;
  // Map iteration order is insertion order: re-inserting on use makes it an LRU.
  const entries = new Map<string, { readonly deploymentId: string; readonly at: number }>();
  return {
    get(keyId, sessionId, nowMs) {
      const id = `${keyId}\0${sessionId}`;
      const entry = entries.get(id);
      if (entry === undefined) return undefined;
      entries.delete(id);
      if (nowMs - entry.at > ttlMs) return undefined;
      entries.set(id, entry);
      return entry.deploymentId;
    },
    set(keyId, sessionId, deploymentId, nowMs) {
      const id = `${keyId}\0${sessionId}`;
      entries.delete(id);
      entries.set(id, { deploymentId, at: nowMs });
      for (const oldest of entries.keys()) {
        if (entries.size <= capacity) break;
        entries.delete(oldest);
      }
    },
  };
}
