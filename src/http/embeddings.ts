import { Cause, Effect, Exit, Predicate } from "effect";
import { createDeadline } from "../deadline.ts";
import { LOCAL_WAIT_MS } from "../router/capacity.ts";
import type { AuxiliaryDeps } from "./auxiliary.ts";
import { readBoundedBody, rejectCompressedBody } from "./body.ts";
import type { Admission, FinalizeOutcome } from "./contracts.ts";
import { failureResponse, HttpFailure, InvalidInput, jsonResponse } from "./errors.ts";
import { bearerToken } from "./security.ts";
import { parseCorrelationId } from "./status.ts";

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0d]);

/**
 * Finds the top-level `"model"` string of a JSON object as its bytes stream past,
 * without building the document: an embeddings body can hold 64 MiB of base64
 * media, which the router never parses or copies. Escapes and non-string values
 * read as an invalid model; the server parses and validates everything else.
 */
export function topLevelModelScanner() {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let expectKey = false;
  let capture: number[] | null = null;
  let capturing: "key" | "model" | null = null;
  let lastKey = "";
  let wantModel = false;
  const models: string[] = [];
  return {
    models,
    push(chunk: Uint8Array) {
      for (const byte of chunk) {
        if (inString) {
          if (escaped) escaped = false;
          else if (byte === BACKSLASH) {
            escaped = true;
            if (capturing === "model") capture = null;
          } else if (byte === QUOTE) {
            inString = false;
            const text = capture === null ? null : Buffer.from(capture).toString("utf8");
            if (capturing === "key") lastKey = text ?? "";
            if (capturing === "model") models.push(text ?? "\\");
            capturing = null;
            capture = null;
          } else if (capture !== null && capture.length < 256) capture.push(byte);
          continue;
        }
        if (WHITESPACE.has(byte)) continue;
        if (wantModel) {
          wantModel = false;
          if (byte !== QUOTE) models.push("");
          else capturing = "model";
        }
        if (byte === QUOTE) {
          inString = true;
          if (depth === 1 && expectKey) capturing = "key";
          if (capturing !== null) capture = [];
        } else if (byte === 0x7b || byte === 0x5b) {
          depth++;
          expectKey = byte === 0x7b && depth === 1;
        } else if (byte === 0x7d || byte === 0x5d) depth--;
        else if (depth === 1 && byte === 0x2c) expectKey = true;
        else if (depth === 1 && byte === 0x3a) {
          expectKey = false;
          wantModel = lastKey === "model";
        }
      }
    },
  };
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * OpenAI `POST /v1/embeddings` on the one local embeddings deployment. The body
 * streams to the server unchanged (it needs Content-Length, and media can be
 * large); the router only checks the top-level `model` on the way, holding back
 * the last chunk until it has. Never falls back to cloud: when the server cannot
 * be reached the answer is 503.
 */
export async function handleEmbeddings(request: Request, deps: AuxiliaryDeps): Promise<Response> {
  let admission: Admission | undefined;
  let claimed = false;
  let persisted = false;
  let correlationId = "";
  let metadata: Omit<FinalizeOutcome, "status"> = {};
  const deadline = createDeadline(11 * 60_000, [request.signal]);
  const signal = deadline.signal;
  try {
    correlationId = parseCorrelationId(request.headers.get("x-request-id")) ?? crypto.randomUUID();
    const rawKey = bearerToken(request);
    await deps.keys.authenticate(rawKey);
    const deployment = deps.deployments.find((item) => item.modality === "embeddings");
    if (deployment === undefined)
      throw new HttpFailure(404, "not_found", "No embeddings deployment is configured");
    rejectCompressedBody(request);
    const length = Number(request.headers.get("content-length") ?? Number.NaN);
    if (!Number.isSafeInteger(length) || length <= 0 || request.body === null)
      throw new HttpFailure(411, "invalid", "A JSON body with Content-Length is required");
    if (length > deployment.maxBodyBytes)
      throw new HttpFailure(
        413,
        "invalid",
        `Request body is larger than ${deployment.maxBodyBytes} bytes`,
      );
    admission = await deps.keys.admit(rawKey);
    const lease = admission;
    deps.status.claim({
      id: lease.requestId,
      keyId: lease.keyId,
      correlationId,
      priority: lease.policy.priority,
    });
    claimed = true;
    metadata = {
      deploymentId: deployment.id,
      location: "local",
      transport: deployment.transport,
      taskKind: "embeddings",
      decisionReason: "explicit-model",
      selectionReasonCode: "explicit-model",
      priceVersion: deployment.priceVersion,
      classifierInputTokens: 0,
      classifierElapsedMs: 0,
      cacheObservation: "unknown",
    };
    const started = Date.now();
    let rejection: HttpFailure | undefined;
    const effect = Effect.acquireUseRelease(
      deps.pool.acquire(
        [{ id: deployment.resourceId, capacity: deployment.capacity }],
        lease.policy.priority,
        {
          requestId: lease.requestId,
          waitMs: LOCAL_WAIT_MS[lease.policy.priority === "high" ? "high" : "medium"],
          onQueue: (event) =>
            deps.status.update(lease.keyId, correlationId, {
              state: event.state,
              waitedMs: event.waitedMs,
            }),
        },
      ),
      () =>
        Effect.tryPromise({
          try: async () => {
            await deps.keys.recheck(lease);
            signal.throwIfAborted();
            const waitedMs = Date.now() - started;
            metadata = { ...metadata, queueWaitMs: waitedMs };
            deps.status.update(lease.keyId, correlationId, { state: "dispatched", waitedMs });
            const scanner = topLevelModelScanner();
            let held: Uint8Array | undefined;
            let received = 0;
            const reject = (failure: HttpFailure, controller: TransformStreamDefaultController) => {
              rejection = failure;
              controller.error(failure);
            };
            const checked = request.body!.pipeThrough(
              new TransformStream<Uint8Array, Uint8Array>({
                transform(chunk, controller) {
                  received += chunk.byteLength;
                  if (received > length)
                    return reject(new InvalidInput("body longer than Content-Length"), controller);
                  scanner.push(chunk);
                  if (scanner.models.some((model) => model !== deployment.id))
                    return reject(
                      new HttpFailure(404, "not_found", `model must be ${deployment.id}`),
                      controller,
                    );
                  if (held !== undefined) controller.enqueue(held);
                  held = chunk;
                },
                flush(controller) {
                  if (scanner.models.length === 0)
                    return reject(new InvalidInput("model is required"), controller);
                  if (held !== undefined) controller.enqueue(held);
                },
              }),
            );
            const headers: Record<string, string> = {
              "content-type": "application/json",
              "content-length": String(length),
            };
            const credential =
              deployment.credentialEnvVar === undefined
                ? undefined
                : process.env[deployment.credentialEnvVar];
            if (credential) headers.authorization = `Bearer ${credential}`;
            const generatedAt = Date.now();
            // Like System One, the permit is held until the server answers, even if the client
            // leaves after its upload: the NPU keeps working on it.
            const upstreamDeadline = createDeadline(10 * 60_000);
            let response: Response;
            let bytes: Uint8Array;
            try {
              try {
                response = await (deps.fetch ?? fetch)(
                  `${deployment.endpoint.replace(/\/$/, "")}/embeddings`,
                  {
                    method: "POST",
                    redirect: "error",
                    signal: upstreamDeadline.signal,
                    headers,
                    body: checked,
                    duplex: "half",
                  } as RequestInit,
                );
              } catch (error) {
                if (rejection !== undefined) throw rejection;
                signal.throwIfAborted();
                if (upstreamDeadline.signal.aborted)
                  throw new HttpFailure(504, "timeout", "Embeddings timed out");
                throw new HttpFailure(
                  503,
                  "unavailable",
                  "The embeddings deployment is unavailable; embeddings never fall back to cloud",
                  5,
                );
              }
              bytes = await readBoundedBody(
                new Request("http://response.local", {
                  method: "POST",
                  body: response.body,
                  duplex: "half",
                } as RequestInit),
                { maxBytes: 32 * 1024 * 1024, timeoutMs: 60_000 },
              );
            } finally {
              upstreamDeadline.clear();
            }
            let body: unknown;
            try {
              body = JSON.parse(new TextDecoder().decode(bytes));
            } catch {
              throw new HttpFailure(502, "provider_failure", "Embeddings returned invalid JSON");
            }
            if (!response.ok) throw embeddingsRejection(response.status, body);
            if (!Predicate.isObject(body) || !Array.isArray(body.data))
              throw new HttpFailure(502, "provider_failure", "Embeddings returned no data");
            const usage = Predicate.isObject(body.usage) ? body.usage : {};
            const inputTokens = count(usage.prompt_tokens);
            const cost =
              deployment.requestUsd ??
              (inputTokens === null || deployment.inputUsdPerMillion === null
                ? null
                : (inputTokens * deployment.inputUsdPerMillion) / 1_000_000);
            metadata = {
              ...metadata,
              promptTokens: inputTokens,
              completionTokens: 0,
              generationElapsedMs: Date.now() - generatedAt,
              estimatedCostUsd: cost,
              localComputeEstimatedUsd: cost,
              costSource: cost === null ? null : "local-rate-card",
              decisionTraceJson: JSON.stringify({
                modality: "embeddings",
                items: body.data.length,
                bytes: length,
                keyPolicyVersion: lease.version,
                priority: lease.policy.priority,
                resourceId: deployment.resourceId,
              }),
            };
            return body;
          },
          catch: (error) => error,
        }).pipe(Effect.uninterruptible),
      (permit) => Effect.sync(permit.release),
    );
    const exit = await Effect.runPromiseExit(effect, { signal });
    if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
    signal.throwIfAborted();
    await deps.keys.finalize(lease, { ...metadata, status: "success" });
    persisted = true;
    deps.status.update(lease.keyId, correlationId, { state: "completed" });
    return jsonResponse(200, exit.value, {
      "x-request-id": correlationId,
      "x-deployment-id": deployment.id,
      "x-queue-wait-ms": String(metadata.queueWaitMs ?? 0),
    });
  } catch (error) {
    if (admission !== undefined && !persisted) {
      try {
        await deps.keys.finalize(admission, {
          ...metadata,
          status: signal.aborted ? "abandoned" : "error",
          errorCode: signal.aborted ? "Cancelled" : "EmbeddingsFailure",
        });
      } catch {
        return failureResponse(
          Object.assign(new Error("persistence unavailable"), { _tag: "DatabaseError" }),
        );
      }
      if (claimed)
        deps.status.update(admission.keyId, correlationId, {
          state: signal.aborted ? "cancelled" : "error",
        });
    }
    return signal.aborted
      ? failureResponse(new HttpFailure(400, "cancelled", "Request cancelled"))
      : failureResponse(error);
  } finally {
    deadline.clear();
  }
}

/** The server's 400/413 are the client's to fix; anything else is the provider's failure. */
function embeddingsRejection(status: number, body: unknown): HttpFailure {
  const error = Predicate.isObject(body) && Predicate.isObject(body.error) ? body.error : {};
  const message = typeof error.message === "string" ? error.message.slice(0, 500) : "";
  if (status === 400 || status === 413)
    return new HttpFailure(status, "invalid", message || "invalid embeddings request");
  return new HttpFailure(502, "provider_failure", "Embeddings upstream failed");
}
