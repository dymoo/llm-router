import { Effect, Schema } from "effect";
import type { Deployment } from "../../domain.ts";
import { LocalOverloaded, ProviderFailure } from "../../errors.ts";
import type { AdapterRequest, ProviderAdapter } from "./types.ts";
import {
  bearerHeaders,
  fetchResponse,
  joinUrl,
  readBoundedBody,
  readJsonCompletion,
  type FetchImpl,
} from "./http.ts";

const Models = Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) });
const decodeModels = Schema.decodeUnknownEffect(Models);

const GufoChunk = Schema.Struct({ model: Schema.String, choices: Schema.Array(Schema.Unknown) });
const decodeGufoChunk = Schema.decodeUnknownSync(GufoChunk);
const MAX_SSE_EVENT_BYTES = 256 * 1024;
const GUFO_NO_QUEUE = { "X-Gufo-No-Queue": "1" };

const NamedTool = Schema.Struct({
  type: Schema.Literals(["function"]),
  function: Schema.Struct({ name: Schema.NonEmptyString }),
});
const decodeNamedTool = Schema.decodeUnknownSync(NamedTool);

const GufoQueueRefusal = Schema.Struct({
  error: Schema.Struct({ code: Schema.Literals(["queue_full", "client_queue_full"]) }),
});
const decodeGufoQueueRefusal = Schema.decodeUnknownSync(GufoQueueRefusal);

const fetchGufoResponse = Effect.fn("Gufo.fetchResponse")(function* (
  fetchImpl: FetchImpl,
  url: string,
  init: RequestInit,
) {
  const response = yield* Effect.tryPromise({
    try: (signal) => fetchImpl(url, { ...init, signal, redirect: "error" }),
    catch: (cause) =>
      new ProviderFailure({
        message:
          cause instanceof Error && cause.name === "AbortError"
            ? "provider request cancelled"
            : "provider request failed",
      }),
  });
  if (response.ok) return response;
  if (response.status === 429) {
    const zeroLength = response.headers.get("content-length") === "0";
    const body = response.body;
    const text =
      body === null || zeroLength
        ? ""
        : yield* readBoundedBody(response, true).pipe(Effect.catch(() => Effect.succeed(null)));
    if (zeroLength && body !== null) {
      yield* Effect.promise(() => body.cancel().catch(() => undefined));
    }
    if (text !== null) {
      let queueRefusal = text === "" && new Headers(init.headers).get("X-Gufo-No-Queue") === "1";
      if (!queueRefusal) {
        try {
          const parsed: unknown = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
          decodeGufoQueueRefusal(parsed);
          queueRefusal = true;
        } catch {
          // An ambiguous 429 is a provider failure, not proof that Gufo refused admission.
        }
      }
      if (queueRefusal) {
        const header = response.headers.get("retry-after")?.trim();
        const seconds = header !== undefined && /^\d+$/.test(header) ? Number(header) : NaN;
        return yield* new LocalOverloaded({
          message: "Gufo declined admission before enqueue",
          retryAfterSeconds: Number.isSafeInteger(seconds) ? seconds : null,
        });
      }
    }
  } else {
    yield* Effect.promise(
      () => response.body?.cancel().catch(() => undefined) ?? Promise.resolve(),
    );
  }
  return yield* new ProviderFailure({ message: `provider HTTP ${response.status}` });
});

function checkedEvent(event: string, modelId: string): "data" | "done" | "comment" {
  const data = event
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (data.length === 0) return "comment";
  if (data === "[DONE]") return "done";
  try {
    const parsed: unknown = JSON.parse(data);
    const chunk = decodeGufoChunk(parsed);
    if (chunk.model !== modelId) {
      throw new ProviderFailure({ message: "Gufo SSE model does not match deployment" });
    }
    return "data";
  } catch (cause) {
    if (cause instanceof ProviderFailure) throw cause;
    throw new ProviderFailure({ message: "Gufo SSE frame is invalid or missing model" });
  }
}

function checkedStream(
  response: Response,
  modelId: string,
): Effect.Effect<Response, ProviderFailure> {
  if (response.body === null) {
    return Effect.fail(new ProviderFailure({ message: "Gufo stream has no body" }));
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const encoder = new TextEncoder();
  let pending = "";
  let ended = false;
  const nextEvent = async (): Promise<string | null> => {
    for (;;) {
      const boundary = /\r?\n\r?\n/.exec(pending);
      if (boundary !== null) {
        const event = pending.slice(0, boundary.index);
        pending = pending.slice(boundary.index + boundary[0].length);
        if (encoder.encode(event).byteLength > MAX_SSE_EVENT_BYTES)
          throw new ProviderFailure({ message: "Gufo SSE event exceeds byte limit" });
        return event;
      }
      if (encoder.encode(pending).byteLength > MAX_SSE_EVENT_BYTES)
        throw new ProviderFailure({ message: "Gufo SSE event exceeds byte limit" });
      if (ended) return null;
      const next = await reader.read();
      pending += next.done ? decoder.decode() : decoder.decode(next.value, { stream: true });
      ended = next.done;
    }
  };

  return Effect.tryPromise({
    try: async (signal) => {
      const abort = () => {
        void reader.cancel().catch(() => undefined);
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        let first: string | null;
        do {
          signal.throwIfAborted();
          first = await nextEvent();
          if (first === null) throw new ProviderFailure({ message: "Gufo SSE has no model frame" });
        } while (checkedEvent(first, modelId) === "comment");
        if (checkedEvent(first, modelId) !== "data")
          throw new ProviderFailure({ message: "Gufo SSE has no model frame" });
        signal.throwIfAborted();
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              let event = first;
              first = null;
              if (event === null) event = await nextEvent();
              if (event === null)
                throw new ProviderFailure({ message: "Gufo SSE ended before [DONE]" });
              const kind = checkedEvent(event, modelId);
              if (kind === "done") {
                controller.enqueue(encoder.encode(event + "\n\n"));
                await reader.cancel().catch(() => undefined);
                controller.close();
              } else if (kind === "data") {
                controller.enqueue(encoder.encode(event + "\n\n"));
              }
            } catch (cause) {
              await reader.cancel().catch(() => undefined);
              controller.error(cause);
            }
          },
          cancel(reason) {
            return reader.cancel(reason);
          },
        });
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch (cause) {
        await reader.cancel().catch(() => undefined);
        throw cause;
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
    catch: (cause) =>
      cause instanceof ProviderFailure
        ? cause
        : new ProviderFailure({ message: "Gufo SSE preflight failed" }),
  }).pipe(
    Effect.timeout("15 seconds"),
    Effect.mapError((cause) =>
      cause instanceof ProviderFailure
        ? cause
        : new ProviderFailure({ message: "Gufo SSE preflight timed out" }),
    ),
  );
}

function credentialOrFail(credential: string | undefined): Effect.Effect<string, ProviderFailure> {
  return credential !== undefined && credential.trim().length > 0 && !/[\r\n]/.test(credential)
    ? Effect.succeed(credential)
    : Effect.fail(new ProviderFailure({ message: "Gufo bearer credential is missing or invalid" }));
}

function unsupportedControl(request: AdapterRequest): ProviderFailure | undefined {
  if (request.sampling?.stop !== undefined || request.responseFormat != null) {
    return new ProviderFailure({ message: "Gufo does not support stop or response_format" });
  }
  if (
    request.toolChoice != null &&
    typeof request.toolChoice !== "object" &&
    request.toolChoice !== "auto" &&
    request.toolChoice !== "none" &&
    request.toolChoice !== "required"
  ) {
    return new ProviderFailure({ message: "Gufo does not support this tool_choice" });
  }
  if (request.appliedEffort === "on" || request.appliedEffort === "high") {
    return new ProviderFailure({ message: "Gufo does not support this reasoning_effort" });
  }
  return undefined;
}

export function gufoAdapter(fetchImpl: FetchImpl = fetch): ProviderAdapter {
  const complete = Effect.fn("Gufo.complete")(function* (request: AdapterRequest) {
    const credential = yield* credentialOrFail(request.credential);
    const unsupported = unsupportedControl(request);
    if (unsupported !== undefined) return yield* unsupported;
    const body = yield* Effect.try({
      try: () => JSON.stringify(gufoBody(request, false)),
      catch: (cause) =>
        cause instanceof ProviderFailure
          ? cause
          : new ProviderFailure({ message: "Gufo request could not be encoded" }),
    });
    const response = yield* fetchGufoResponse(
      fetchImpl,
      joinUrl(request.deployment.endpoint, "/v1/chat/completions"),
      {
        method: "POST",
        headers: bearerHeaders(credential, GUFO_NO_QUEUE),
        body,
      },
    );
    const completion = yield* readJsonCompletion(response);
    if (completion.body.model !== request.deployment.modelId) {
      return yield* new ProviderFailure({
        message: "Gufo response model does not match deployment",
      });
    }
    return completion;
  });

  const stream = Effect.fn("Gufo.stream")(function* (request: AdapterRequest) {
    const credential = yield* credentialOrFail(request.credential);
    const unsupported = unsupportedControl(request);
    if (unsupported !== undefined) return yield* unsupported;
    const body = yield* Effect.try({
      try: () => JSON.stringify(gufoBody(request, true)),
      catch: (cause) =>
        cause instanceof ProviderFailure
          ? cause
          : new ProviderFailure({ message: "Gufo request could not be encoded" }),
    });
    const response = yield* fetchGufoResponse(
      fetchImpl,
      joinUrl(request.deployment.endpoint, "/v1/chat/completions"),
      {
        method: "POST",
        headers: bearerHeaders(credential, GUFO_NO_QUEUE),
        body,
      },
    );
    return yield* checkedStream(response, request.deployment.modelId);
  });

  const probeUnavailable = Effect.fn("Gufo.probeUnavailable")(function* (
    deployment: Deployment,
    credential: string | undefined,
  ) {
    if (credential === undefined || credential.trim().length === 0 || /[\r\n]/.test(credential)) {
      return true;
    }
    const available = yield* Effect.gen(function* () {
      const response = yield* fetchResponse(fetchImpl, joinUrl(deployment.endpoint, "/v1/models"), {
        method: "GET",
        headers: bearerHeaders(credential),
        redirect: "error",
      });
      const text = yield* readBoundedBody(response);
      const parsed = yield* Effect.try({
        try: () => JSON.parse(text) as unknown,
        catch: () => new ProviderFailure({ message: "Gufo models response is not JSON" }),
      });
      const models = yield* decodeModels(parsed).pipe(
        Effect.mapError(() => new ProviderFailure({ message: "Gufo models response is invalid" })),
      );
      return models.data.some((model) => model.id === deployment.modelId);
    }).pipe(
      Effect.timeout("1500 millis"),
      Effect.catch(() => Effect.succeed(false)),
    );
    return !available;
  });
  return { complete, stream, probeUnavailable };
}

export function gufoBody(request: AdapterRequest, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.deployment.modelId,
    messages: request.messages,
    max_tokens: request.maxCompletionTokens,
    reasoning_effort: request.appliedEffort === "none" ? "off" : request.appliedEffort,
    stream,
  };
  const sampling = request.sampling;
  if (sampling?.temperature !== undefined) body.temperature = sampling.temperature;
  if (sampling?.top_p !== undefined) body.top_p = sampling.top_p;
  if (sampling?.presence_penalty !== undefined) body.presence_penalty = sampling.presence_penalty;
  if (sampling?.frequency_penalty !== undefined)
    body.frequency_penalty = sampling.frequency_penalty;
  if (sampling?.seed !== undefined) body.seed = sampling.seed;
  if (stream) body.stream_options = { include_usage: true };
  if (request.tools !== undefined && request.tools !== null) body.tools = request.tools;
  if (request.toolChoice !== undefined && request.toolChoice !== null) {
    if (typeof request.toolChoice !== "object") {
      body.tool_choice = request.toolChoice;
    } else {
      let name: string;
      try {
        name = decodeNamedTool(request.toolChoice).function.name;
      } catch {
        throw new ProviderFailure({ message: "Gufo named tool choice is invalid" });
      }
      if (!Array.isArray(request.tools)) {
        throw new ProviderFailure({ message: "Gufo named tool is absent" });
      }
      let selected: unknown;
      for (const tool of request.tools) {
        let candidateName: string;
        try {
          candidateName = decodeNamedTool(tool).function.name;
        } catch {
          continue;
        }
        if (candidateName !== name) continue;
        if (selected !== undefined) {
          throw new ProviderFailure({ message: "Gufo named tool is ambiguous" });
        }
        selected = tool;
      }
      if (selected === undefined) {
        throw new ProviderFailure({ message: "Gufo named tool is absent" });
      }
      body.tools = [selected];
      body.tool_choice = "required";
    }
  }
  return body;
}
