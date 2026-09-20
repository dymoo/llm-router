import { Effect } from "effect";
import { ProviderFailure } from "../../errors.ts";
import { readProviderUsage, type ProviderUsage } from "../accounting.ts";
import type { AdapterCompletion } from "./types.ts";

export const UPSTREAM_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
export const UPSTREAM_JSON_TIMEOUT_MS = 15_000;

export type FetchImpl = (input: string | URL, init?: RequestInit) => Promise<Response>;

export function joinUrl(endpoint: string, path: string): string {
  const base = endpoint.replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  if (base.endsWith("/v1")) {
    return suffix === "/v1" || suffix.startsWith("/v1/")
      ? `${base}${suffix.slice(3)}`
      : `${base.slice(0, -3)}${suffix}`;
  }
  return `${base}${suffix}`;
}

export function bearerHeaders(
  credential: string | undefined,
  extra?: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...extra,
  };
  if (credential !== undefined && credential.length > 0) {
    headers.authorization = `Bearer ${credential}`;
  }
  return headers;
}

export function fetchResponse(
  fetchImpl: FetchImpl,
  url: string,
  init: RequestInit,
): Effect.Effect<Response, ProviderFailure> {
  return Effect.tryPromise({
    try: (signal) => fetchImpl(url, { ...init, signal }),
    catch: (cause) =>
      new ProviderFailure({
        message:
          cause instanceof Error && cause.name === "AbortError"
            ? "provider request cancelled"
            : "provider request failed",
      }),
  }).pipe(
    Effect.flatMap((response) => {
      if (response.ok) {
        return Effect.succeed(response);
      }
      return Effect.andThen(
        Effect.promise(() => response.body?.cancel().catch(() => undefined) ?? Promise.resolve()),
        Effect.fail(new ProviderFailure({ message: `provider HTTP ${response.status}` })),
      );
    }),
  );
}

export function parseCompletion(value: unknown): AdapterCompletion {
  if (typeof value !== "object" || value === null) {
    throw new ProviderFailure({ message: "provider returned a non-object body" });
  }
  const record = value as Record<string, unknown>;
  if (record.error !== undefined && record.error !== null) {
    throw new ProviderFailure({ message: "provider returned an error object" });
  }
  const choices = record.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new ProviderFailure({ message: "provider returned no choices" });
  }
  return { body: record, usage: readProviderUsage(record) };
}

export function readJsonCompletion(
  response: Response,
): Effect.Effect<AdapterCompletion, ProviderFailure> {
  return Effect.flatMap(readBoundedBody(response), (text) =>
    Effect.try({
      try: () => parseCompletion(JSON.parse(text)),
      catch: (cause) =>
        cause instanceof ProviderFailure
          ? cause
          : new ProviderFailure({ message: "provider response failed validation" }),
    }),
  );
}

function readBoundedBody(response: Response): Effect.Effect<string, ProviderFailure> {
  return Effect.tryPromise({
    try: (signal) =>
      readBytes(response, signal, UPSTREAM_RESPONSE_MAX_BYTES, UPSTREAM_JSON_TIMEOUT_MS),
    catch: (cause) =>
      new ProviderFailure({
        message:
          cause instanceof Error && cause.message === "provider response exceeded byte limit"
            ? "provider response exceeded byte limit"
            : "provider response is not valid JSON",
      }),
  });
}

async function readBytes(
  response: Response,
  signal: AbortSignal,
  maxBytes: number,
  timeoutMs: number,
): Promise<string> {
  if (response.body === null) throw new Error("provider response has no body");
  const reader = response.body.getReader();
  let timedOut = false;
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  const timeout = setTimeout(() => {
    timedOut = true;
    abort();
  }, timeoutMs);
  signal.addEventListener("abort", abort, { once: true });
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0;
    let text = "";
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (timedOut) throw new Error("provider response read timed out");
      signal.throwIfAborted();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) throw new Error("provider response exceeded byte limit");
      text += decoder.decode(next.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function holdReadableStream(
  response: Response,
  onEnd: () => void,
  deadlineMs = 10 * 60 * 1000,
): ReadableStream<Uint8Array> {
  const source = response.body;
  if (source === null) {
    onEnd();
    throw new ProviderFailure({ message: "provider stream has no body" });
  }
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      onEnd();
    }
  };
  const reader = source.getReader();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    release();
    void reader.cancel().catch(() => undefined);
  }, deadlineMs);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (timedOut) throw new ProviderFailure({ message: "provider stream timed out" });
        if (next.done) {
          clearTimeout(timer);
          release();
          controller.close();
          return;
        }
        controller.enqueue(next.value);
      } catch (cause) {
        clearTimeout(timer);
        release();
        controller.error(cause);
      }
    },
    cancel() {
      clearTimeout(timer);
      release();
      return reader.cancel();
    },
  });
}

export type { ProviderUsage };
