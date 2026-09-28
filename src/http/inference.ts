import { createDeadline } from "../deadline.ts";
import { serviceTierFor } from "../domain.ts";
import { GatewayFailure } from "./gateway-failure.ts";
import { readJsonObject } from "./body.ts";
import type {
  Admission,
  FinalizeOutcome,
  InferenceDeps,
  QueueHooks,
  RoutedWork,
  StreamSuccess,
} from "./contracts.ts";
import { decodeAppAttribution, decodeChatCompletion, requestCapabilities } from "./decode.ts";
import { errorBody, failureResponse, jsonResponse, toHttpFailure } from "./errors.ts";
import { sessionResponseHeaders, sseHeaders } from "./headers.ts";
import { BODY_READ_TIMEOUT_MS, GATEWAY_EFFECT_TIMEOUT_MS, INFERENCE_MAX_BYTES } from "./limits.ts";
import { bearerToken } from "./security.ts";
import { encodeKeepalive, encodeQueueEvent, parseCorrelationId } from "./status.ts";
import { assertCompletionBody } from "./stream.ts";
import { estimateInputTokens } from "./tokens.ts";

function errorCode(error: unknown): string {
  if (error instanceof GatewayFailure) return errorCode(error.cause);
  return error !== null &&
    typeof error === "object" &&
    "_tag" in error &&
    typeof error._tag === "string"
    ? error._tag
    : "ProviderFailure";
}

type Finalize = (
  outcome: FinalizeOutcome,
  state: "completed" | "error" | "cancelled",
) => Promise<void>;

export async function handleChatCompletions(
  request: Request,
  deps: InferenceDeps,
): Promise<Response> {
  const newId = deps.newId ?? (() => crypto.randomUUID());
  let correlationId = "";
  let admission: Admission | undefined;
  let claimed = false;
  let admissionAttempted = false;
  let finalization: Promise<void> | undefined;
  const cancellation = new AbortController();
  const deadline = createDeadline(GATEWAY_EFFECT_TIMEOUT_MS, [request.signal, cancellation.signal]);
  const signal = deadline.signal;
  let streaming = false;
  const app = decodeAppAttribution(request.headers);
  const finalize: Finalize = (outcome, state) => {
    if (admission === undefined) return Promise.resolve();
    if (finalization !== undefined) return finalization;
    const lease = admission;
    finalization = deps.keys
      .finalize(
        lease,
        app === undefined
          ? outcome
          : { ...outcome, appUrl: app.url ?? null, appTitle: app.title ?? null },
      )
      .then(() => {
        if (claimed) deps.status.update(lease.keyId, correlationId, { state });
      })
      .catch((error) => {
        finalization = undefined;
        if (claimed) deps.status.update(lease.keyId, correlationId, { state: "error" });
        throw error;
      });
    return finalization;
  };
  try {
    correlationId = parseCorrelationId(request.headers.get("x-request-id")) ?? newId();
    const rawKey = bearerToken(request);
    const body = await readJsonObject(request, {
      maxBytes: INFERENCE_MAX_BYTES,
      timeoutMs: BODY_READ_TIMEOUT_MS,
    });
    const decoded = decodeChatCompletion(body);
    // Open WebUI's chat id is a stickiness hint, never identity or authorization: an
    // explicit routing object wins, a malformed id is ignored, and the router
    // namespaces sessions by the authenticated key.
    const webuiChat = request.headers.get("x-openwebui-chat-id");
    if (
      body.routing === undefined &&
      webuiChat !== null &&
      /^[a-zA-Z0-9_-]{1,128}$/.test(webuiChat)
    )
      decoded.sessionId = `webui:${webuiChat}`;
    const capabilities = requestCapabilities(decoded);
    const inputTokens = estimateInputTokens(decoded);
    signal.throwIfAborted();
    admissionAttempted = true;
    admission = await deps.keys.admit(rawKey);
    deps.status.claim({
      id: admission.requestId,
      keyId: admission.keyId,
      correlationId,
      priority: admission.policy.priority,
    });
    claimed = true;
    admission = await deps.keys.recheck(admission);
    const serviceTier = serviceTierFor(admission.policy.priority, decoded.serviceTier);
    const work: RoutedWork = {
      requestId: admission.requestId,
      keyId: admission.keyId,
      policy: admission.policy,
      keyPolicyVersion: admission.version,
      messages: decoded.messages,
      tools: decoded.tools,
      parallelToolCalls: decoded.parallelToolCalls,
      toolChoice: decoded.tool_choice,
      responseFormat: decoded.response_format,
      sampling: decoded.sampling,
      maxCompletionTokens: decoded.maxCompletionTokens,
      ...(decoded.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: decoded.reasoningEffort }),
      inputTokens,
      ...(decoded.sessionId === undefined ? {} : { sessionId: decoded.sessionId }),
      capabilities,
      stream: decoded.stream,
      ...(serviceTier === undefined ? {} : { serviceTier }),
      ...(app === undefined ? {} : { appAttribution: app }),
    };
    if (decoded.stream) {
      const response = streamCompletion(
        deps,
        work,
        admission,
        correlationId,
        finalize,
        cancellation,
        signal,
        deadline.clear,
      );
      streaming = true;
      return response;
    }
    const hooks: QueueHooks = {
      onQueued: (waitedMs) =>
        deps.status.update(work.keyId, correlationId, { state: "queued", waitedMs }),
      onDispatched: (waitedMs) =>
        deps.status.update(work.keyId, correlationId, { state: "dispatched", waitedMs }),
    };
    const result = await deps.gateway.complete(work, hooks, signal);
    assertCompletionBody(result.body);
    await finalize({ ...result.metadata(), status: "success" }, "completed");
    return jsonResponse(
      200,
      result.body,
      sessionResponseHeaders({
        ...result.headers,
        requestId: correlationId,
        priority: admission.policy.priority,
      }),
    );
  } catch (error) {
    if (!admissionAttempted) {
      const code = toHttpFailure(error).code;
      deps.onAdmissionRejected?.(
        code === "unauthorized" ? "unauthorized" : code === "invalid" ? "invalid" : "other",
      );
    }
    try {
      await finalize(
        {
          ...(error instanceof GatewayFailure ? error.metadata : {}),
          status: signal.aborted ? "abandoned" : "error",
          errorCode: signal.aborted ? "Cancelled" : errorCode(error),
        },
        signal.aborted ? "cancelled" : "error",
      );
    } catch {
      // Never claim completion when persistence failed. The durable lease expires as abandoned.
      return failureResponse(
        Object.assign(new Error("persistence unavailable"), { _tag: "DatabaseError" }),
      );
    }
    return failureResponse(error);
  } finally {
    if (!streaming) deadline.clear();
  }
}

function streamCompletion(
  deps: InferenceDeps,
  work: RoutedWork,
  admission: Admission,
  correlationId: string,
  finalize: Finalize,
  cancellation: AbortController,
  signal: AbortSignal,
  clearDeadline: () => void,
): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  let result: StreamSuccess | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let dispatched = false;
  let pendingWrites = 0;
  let writes = Promise.resolve();
  const write = (chunk: Uint8Array): Promise<void> => {
    pendingWrites++;
    writes = writes
      .then(() => writer.write(chunk))
      .finally(() => {
        pendingWrites--;
      });
    void writes.catch(() => cancellation.abort());
    return writes;
  };
  // Readable cancellation rejects writer.closed, even while classification or admission is pending.
  void writer.closed.catch(() => cancellation.abort());
  const abort = (): void => {
    void reader?.cancel(signal.reason).catch(() => undefined);
    void writer.abort(signal.reason).catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  const keepalive = setInterval(() => {
    if (!dispatched && pendingWrites === 0) void write(encodeKeepalive());
  }, 15_000);
  // Keepalives run until the provider stream is established: a flex request can
  // go back to waiting after a dispatch Gufo refused.
  const event = (state: "queued" | "dispatched", waitedMs: number): void => {
    deps.status.update(admission.keyId, correlationId, { state, waitedMs });
    void write(
      encodeQueueEvent({
        request_id: correlationId,
        state,
        priority: admission.policy.priority,
        waited_ms: waitedMs,
      }),
    );
  };
  const pump = async (): Promise<void> => {
    try {
      signal.throwIfAborted();
      await deps.keys.recheck(admission);
      result = await deps.gateway.stream(
        work,
        { onQueued: (ms) => event("queued", ms), onDispatched: (ms) => event("dispatched", ms) },
        signal,
      );
      dispatched = true;
      clearInterval(keepalive);
      reader = result.body.getReader();
      signal.throwIfAborted();
      for (;;) {
        const next = await reader.read();
        signal.throwIfAborted();
        if (next.done) break;
        await write(next.value);
      }
      await writes;
      await finalize({ ...result.metadata(), status: "success" }, "completed");
      await writer.close();
      deps.onStream?.("completed");
    } catch (error) {
      await reader?.cancel(error).catch(() => undefined);
      try {
        await finalize(
          {
            ...(error instanceof GatewayFailure ? error.metadata : result?.metadata()),
            status: signal.aborted ? "abandoned" : "error",
            errorCode: signal.aborted ? "Cancelled" : errorCode(error),
          },
          signal.aborted ? "cancelled" : "error",
        );
      } catch {
        // No prompt, credential, or provider response is logged on a persistence failure.
        console.error("Request accounting could not be persisted", admission.requestId);
      }
      deps.onStream?.(
        signal.aborted ? "cancelled" : result === undefined ? "terminal_error" : "aborted",
      );
      const publicFailure = toHttpFailure(error);
      // The 200 SSE response is committed before routing. Until a provider stream is established,
      // close with a public terminal event; after that, abort so a truncated or unaccounted stream
      // never ends like a complete one.
      if (!signal.aborted && result === undefined) {
        const body = {
          error: {
            ...errorBody(publicFailure).error,
            ...(publicFailure.code === "local_overloaded" ||
            publicFailure.code === "resource_unavailable"
              ? { retry_after_seconds: publicFailure.retryAfterSeconds ?? 1 }
              : {}),
          },
        };
        try {
          await write(
            new TextEncoder().encode("event: router.error\ndata: " + JSON.stringify(body) + "\n\n"),
          );
          await writer.close();
        } catch {
          await writer.abort(error).catch(() => undefined);
        }
      } else {
        await writer.abort(error).catch(() => undefined);
      }
    } finally {
      clearInterval(keepalive);
      signal.removeEventListener("abort", abort);
      reader?.releaseLock();
      clearDeadline();
    }
  };
  // Build the headers first: if they throw, no pump is left running with a
  // held session and capacity.
  const headers = sseHeaders({
    requestId: correlationId,
    deploymentId: "",
    ...(work.sessionId === undefined ? {} : { sessionId: work.sessionId }),
    appliedEffort: "",
    priority: admission.policy.priority,
  });
  void pump();
  return new Response(readable, { status: 200, headers });
}

export async function handleRequestStatus(
  request: Request,
  deps: InferenceDeps,
  id: string,
): Promise<Response> {
  try {
    const { keyId } = await deps.keys.authenticate(bearerToken(request));
    const live = deps.status.get(keyId, id);
    if (live === undefined)
      throw Object.assign(new Error("request not found"), { _tag: "KeyNotFound" });
    return jsonResponse(200, {
      id: live.correlationId,
      state: live.state,
      priority: live.priority,
      waited_ms: live.waitedMs,
    });
  } catch (error) {
    return failureResponse(error);
  }
}
