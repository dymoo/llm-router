import type { Priority } from "./contracts.ts";
import { HttpFailure } from "./errors.ts";

export type LiveRequestState =
  | "admitted"
  | "queued"
  | "dispatched"
  | "completed"
  | "error"
  | "cancelled";

export type LiveRequest = {
  id: string;
  keyId: string;
  correlationId: string;
  state: LiveRequestState;
  priority: Priority;
  waitedMs: number;
  updatedAt: number;
};

export type QueueHooks = {
  onQueued: (waitedMs: number) => void;
  onDispatched: (waitedMs: number) => void;
};

const STATUS_TTL_MS = 12 * 60 * 1000;
const STATUS_MAX_ENTRIES = 2048;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseCorrelationId(header: string | null): string | undefined {
  if (header === null || header.length === 0) {
    return undefined;
  }
  if (!UUID_RE.test(header)) {
    throw new HttpFailure(400, "invalid", "X-Request-ID must be a UUID");
  }
  return header;
}

export function createStatusStore(options?: {
  now?: () => number;
  ttlMs?: number;
  max?: number;
}): RequestStatusStore {
  const now = options?.now ?? Date.now;
  const ttlMs = options?.ttlMs ?? STATUS_TTL_MS;
  const max = options?.max ?? STATUS_MAX_ENTRIES;
  const records = new Map<string, LiveRequest>();

  const internalKey = (keyId: string, correlationId: string): string => `${keyId}:${correlationId}`;

  const prune = (): void => {
    const cutoff = now() - ttlMs;
    for (const [key, record] of records) {
      if (record.updatedAt < cutoff) {
        records.delete(key);
      }
    }
    for (const [key, record] of records) {
      if (records.size < max) break;
      if (record.state === "completed" || record.state === "error" || record.state === "cancelled")
        records.delete(key);
    }
  };

  return {
    claim(input: {
      id: string;
      keyId: string;
      correlationId: string;
      priority: Priority;
    }): LiveRequest {
      prune();
      const key = internalKey(input.keyId, input.correlationId);
      const existing = records.get(key);
      if (
        existing !== undefined &&
        existing.state !== "completed" &&
        existing.state !== "error" &&
        existing.state !== "cancelled"
      ) {
        throw new HttpFailure(409, "conflict", "request id is already in flight");
      }
      if (existing === undefined && records.size >= max) {
        throw new HttpFailure(503, "unavailable", "request status capacity is full");
      }
      const record: LiveRequest = {
        id: input.id,
        keyId: input.keyId,
        correlationId: input.correlationId,
        state: "admitted",
        priority: input.priority,
        waitedMs: 0,
        updatedAt: now(),
      };
      records.set(key, record);
      return record;
    },
    update(
      keyId: string,
      correlationId: string,
      patch: Partial<Pick<LiveRequest, "state" | "waitedMs">>,
    ): void {
      const key = internalKey(keyId, correlationId);
      const existing = records.get(key);
      if (existing === undefined) {
        return;
      }
      records.set(key, { ...existing, ...patch, updatedAt: now() });
    },
    get(keyId: string, correlationId: string): LiveRequest | undefined {
      prune();
      return records.get(internalKey(keyId, correlationId));
    },
    release(keyId: string, correlationId: string): void {
      records.delete(internalKey(keyId, correlationId));
    },
  };
}

export interface RequestStatusStore {
  claim(input: {
    id: string;
    keyId: string;
    correlationId: string;
    priority: Priority;
  }): LiveRequest;
  update(
    keyId: string,
    correlationId: string,
    patch: Partial<Pick<LiveRequest, "state" | "waitedMs">>,
  ): void;
  get(keyId: string, correlationId: string): LiveRequest | undefined;
  release(keyId: string, correlationId: string): void;
}

export function encodeQueueEvent(event: {
  request_id: string;
  state: "queued" | "dispatched";
  priority: Priority;
  waited_ms: number;
}): Uint8Array {
  return new TextEncoder().encode(`event: router.queue\ndata: ${JSON.stringify(event)}\n\n`);
}

export function encodeKeepalive(): Uint8Array {
  return new TextEncoder().encode(": keepalive\n\n");
}
