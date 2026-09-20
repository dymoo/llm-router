import { InvalidInput } from "./errors.ts";
import { BODY_READ_TIMEOUT_MS, type BodyReadOptions } from "./limits.ts";

const IDENTITY_ENCODINGS = new Set(["", "identity"]);

export function rejectCompressedBody(request: Request): void {
  const encoding = request.headers.get("content-encoding");
  if (encoding === null) {
    return;
  }
  const tokens = encoding
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
  if (tokens.some((token) => !IDENTITY_ENCODINGS.has(token))) {
    throw new InvalidInput("compressed request bodies are not accepted");
  }
}

export async function readBoundedBody(
  request: Request,
  options: BodyReadOptions,
): Promise<Uint8Array> {
  rejectCompressedBody(request);
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isInteger(length) || length < 0) {
      throw new InvalidInput("invalid content-length");
    }
    if (length > options.maxBytes) {
      throw new InvalidInput("request body too large");
    }
  }
  if (request.body === null) {
    return new Uint8Array(0);
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  const timeoutMs = options.timeoutMs > 0 ? options.timeoutMs : BODY_READ_TIMEOUT_MS;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel("body-read-timeout");
  }, timeoutMs);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (timedOut) {
        throw new InvalidInput("request body read timed out");
      }
      if (done) {
        break;
      }
      if (value.byteLength === 0) {
        continue;
      }
      received += value.byteLength;
      if (received > options.maxBytes) {
        await reader.cancel("body-too-large");
        throw new InvalidInput("request body too large");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof InvalidInput) {
      throw error;
    }
    if (timedOut) {
      throw new InvalidInput("request body read timed out");
    }
    throw new InvalidInput("failed to read request body");
  } finally {
    clearTimeout(timer);
  }
  if (chunks.length === 0) {
    return new Uint8Array(0);
  }
  if (chunks.length === 1) {
    return chunks[0]!;
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export async function readJsonObject(
  request: Request,
  options: BodyReadOptions,
): Promise<Record<string, unknown>> {
  const bytes = await readBoundedBody(request, options);
  if (bytes.byteLength === 0) {
    throw new InvalidInput("request body is required");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new InvalidInput("request body is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InvalidInput("request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}
