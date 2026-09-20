import { Cause, Effect, Exit, Predicate } from "effect";
import type { AuxiliaryDeployment } from "../auxiliary.ts";
import { createCapacityPool, type CapacityPool } from "../router/capacity.ts";
import { readBoundedBody, readJsonObject } from "./body.ts";
import type { Admission, FinalizeOutcome, KeyService } from "./contracts.ts";
import {
  failureResponse,
  HttpFailure,
  InvalidInput,
  jsonResponse,
  noStoreHeaders,
} from "./errors.ts";
import { bearerToken } from "./security.ts";
import { createStatusStore, parseCorrelationId, type RequestStatusStore } from "./status.ts";

export type AuxiliaryDeps = {
  keys: KeyService;
  deployments: readonly AuxiliaryDeployment[];
  chatDeploymentIds: readonly string[];
  pool: CapacityPool;
  status: RequestStatusStore;
  fetch?: typeof fetch;
};

export function auxiliaryResources() {
  return { pool: createCapacityPool(), status: createStatusStore() };
}

function permitted(allowed: readonly string[] | null, id: string): boolean {
  return allowed === null || allowed.includes(id);
}

export async function handleModels(request: Request, deps: AuxiliaryDeps): Promise<Response> {
  try {
    const { policy } = await deps.keys.authenticate(bearerToken(request));
    const ids = deps.deployments
      .filter((item) => permitted(policy.allowedModels, item.id))
      .map((item) => item.id);
    if (deps.chatDeploymentIds.some((id) => permitted(policy.allowedModels, id)))
      ids.unshift("auto");
    return jsonResponse(200, {
      object: "list",
      data: ids.map((id) => ({ id, object: "model", created: 0, owned_by: "llm-router" })),
    });
  } catch (error) {
    return failureResponse(error);
  }
}

type ParsedInput = {
  model: string;
  upstream: Record<string, unknown> | FormData;
  inputTokenUpperBound: number | null;
  inputCount: number;
  bytes: number;
  responseFormat: "json" | "text";
};

async function decodeInput(
  request: Request,
  modality: AuxiliaryDeployment["modality"],
): Promise<ParsedInput> {
  if (modality === "embeddings") {
    const body = await readJsonObject(request, { maxBytes: 512 * 1024, timeoutMs: 15_000 });
    for (const key of Object.keys(body)) {
      if (!["model", "input", "encoding_format", "user"].includes(key))
        throw new InvalidInput(`Unsupported embedding field: ${key}`);
    }
    if (typeof body.model !== "string" || !body.model) throw new InvalidInput("model is required");
    const inputs = typeof body.input === "string" ? [body.input] : body.input;
    if (
      !Array.isArray(inputs) ||
      inputs.length === 0 ||
      inputs.length > 128 ||
      inputs.some((item) => typeof item !== "string" || item.length === 0)
    )
      throw new InvalidInput("input must be a string or nonempty string array");
    if (body.encoding_format !== undefined && body.encoding_format !== "float")
      throw new InvalidInput("Only float embeddings are supported");
    const sizes = inputs.map((item) => Buffer.byteLength(item as string, "utf8") + 8);
    return {
      model: body.model,
      upstream: { input: inputs, encoding_format: "float" },
      inputTokenUpperBound: Math.max(...sizes),
      inputCount: inputs.length,
      bytes: sizes.reduce((sum, size) => sum + size, 0),
      responseFormat: "json",
    };
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.startsWith("multipart/form-data;"))
    throw new InvalidInput("Audio requires multipart/form-data");
  const bytes = await readBoundedBody(request, { maxBytes: 25 * 1024 * 1024, timeoutMs: 30_000 });
  let form: FormData;
  try {
    form = await new Response(Buffer.from(bytes), {
      headers: { "content-type": contentType },
    }).formData();
  } catch {
    throw new InvalidInput("Invalid multipart body");
  }
  for (const key of form.keys()) {
    if (!["model", "file", "response_format", "language"].includes(key))
      throw new InvalidInput(`Unsupported transcription field: ${key}`);
    if (form.getAll(key).length !== 1)
      throw new InvalidInput(`Duplicate transcription field: ${key}`);
  }
  const model = form.get("model");
  const file = form.get("file");
  if (typeof model !== "string" || !model || !(file instanceof Blob) || file.size === 0)
    throw new InvalidInput("model and nonempty audio file are required");
  const language = form.get("language");
  if (language !== null && language !== "" && language !== "auto")
    throw new InvalidInput(
      "FastFlowLM transcription currently auto-detects language; forced language is unsupported",
    );
  const format = form.get("response_format") ?? "json";
  if (format !== "json" && format !== "text")
    throw new InvalidInput("Only json and text transcription responses are supported");
  const upstream = new FormData();
  upstream.set(
    "file",
    file,
    file instanceof File ? file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-128) : "audio.wav",
  );
  return {
    model,
    upstream,
    inputTokenUpperBound: null,
    inputCount: 1,
    bytes: bytes.byteLength,
    responseFormat: format,
  };
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export async function handleAuxiliary(
  request: Request,
  deps: AuxiliaryDeps,
  modality: AuxiliaryDeployment["modality"],
): Promise<Response> {
  let admission: Admission | undefined;
  let claimed = false;
  let persisted = false;
  let correlationId = "";
  let metadata: Omit<FinalizeOutcome, "status"> = {};
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(11 * 60_000)]);
  try {
    correlationId = parseCorrelationId(request.headers.get("x-request-id")) ?? crypto.randomUUID();
    const rawKey = bearerToken(request);
    await deps.keys.authenticate(rawKey);
    const input = await decodeInput(request, modality);
    const deployment = deps.deployments.find(
      (item) => item.id === input.model && item.modality === modality,
    );
    if (deployment === undefined)
      throw new HttpFailure(404, "not_found", "Model is not configured for this endpoint");
    admission = await deps.keys.admit(rawKey);
    const lease = admission;
    if (!permitted(lease.policy.allowedModels, deployment.id))
      throw new HttpFailure(403, "forbidden", "Model is not allowed for this key");
    if (
      input.bytes > deployment.maxBodyBytes ||
      input.inputCount > deployment.maxBatchSize ||
      (input.inputTokenUpperBound !== null &&
        input.inputTokenUpperBound >
          Math.min(deployment.maxInputTokens, lease.policy.contextLimitTokens))
    ) {
      throw new HttpFailure(
        422,
        "invalid",
        "Input exceeds deployment or key limits; split it into smaller chunks",
      );
    }
    const estimate =
      modality === "embeddings"
        ? deployment.inputUsdPerMillion === null
          ? null
          : (input.bytes * deployment.inputUsdPerMillion) / 1_000_000
        : deployment.requestUsd;
    if (
      lease.policy.maxEstimatedUsd !== null &&
      (estimate === null || estimate > lease.policy.maxEstimatedUsd)
    )
      throw new HttpFailure(422, "invalid", "Configured cost ceiling cannot be satisfied");
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
      transport: "fastflowlm",
      taskKind: modality,
      decisionReason: "explicit-model",
      selectionReasonCode: "explicit-model",
      priceVersion: deployment.priceVersion,
      classifierInputTokens: 0,
      classifierElapsedMs: 0,
      cacheObservation: "unknown",
      decisionTraceJson: JSON.stringify({
        modality,
        keyPolicyVersion: lease.version,
        priority: lease.policy.priority,
        resourceId: deployment.resourceId,
        classifier: "not-required",
      }),
    };
    const started = Date.now();
    const effect = Effect.acquireUseRelease(
      deps.pool.acquire(
        [{ id: deployment.resourceId, capacity: deployment.capacity }],
        lease.policy.priority,
        {
          requestId: lease.requestId,
          waitMs: lease.policy.maxWaitMs,
          spill: false,
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
            if (input.upstream instanceof FormData) input.upstream.set("model", deployment.modelId);
            else input.upstream.model = deployment.modelId;
            const base = deployment.endpoint.replace(/\/$/, "");
            const path = modality === "embeddings" ? "embeddings" : "audio/transcriptions";
            // FLM v1.0.6 ASR does not observe cancellation. Retain its permit until the response/deadline,
            // rather than admitting another NPU task while the disconnected request is still executing.
            const upstreamSignal = AbortSignal.timeout(10 * 60_000);
            const generatedAt = Date.now();
            const response = await (deps.fetch ?? fetch)(`${base}/${path}`, {
              method: "POST",
              redirect: "error",
              signal: upstreamSignal,
              headers:
                input.upstream instanceof FormData
                  ? undefined
                  : { "content-type": "application/json" },
              body:
                input.upstream instanceof FormData
                  ? input.upstream
                  : JSON.stringify(input.upstream),
            });
            if (!response.ok) {
              await response.body?.cancel();
              throw new HttpFailure(502, "provider_failure", "NPU runtime rejected the request");
            }
            const bytes = await readBoundedBody(
              new Request("http://response.local", {
                method: "POST",
                body: response.body,
                duplex: "half",
              } as RequestInit),
              { maxBytes: 16 * 1024 * 1024, timeoutMs: 60_000 },
            );
            let body: unknown;
            try {
              body = JSON.parse(new TextDecoder().decode(bytes));
            } catch {
              throw new HttpFailure(502, "provider_failure", "NPU runtime returned invalid JSON");
            }
            if (!Predicate.isObject(body) || body.error !== undefined)
              throw new HttpFailure(502, "provider_failure", "NPU runtime failed");
            const usage = Predicate.isObject(body.usage) ? body.usage : {};
            // FLM v1.0.6 hardcodes zero here even for nonempty input; it is not measured usage.
            const reportedTokens = count(usage.prompt_tokens);
            const promptTokens = reportedTokens === 0 ? null : reportedTokens;
            if (modality === "embeddings") {
              if (
                !Array.isArray(body.data) ||
                body.data.length !== input.inputCount ||
                body.data.some(
                  (item, index) =>
                    !Predicate.isObject(item) ||
                    item.index !== index ||
                    !Array.isArray(item.embedding) ||
                    item.embedding.length === 0 ||
                    item.embedding.some(
                      (value) => typeof value !== "number" || !Number.isFinite(value),
                    ),
                )
              )
                throw new HttpFailure(
                  502,
                  "provider_failure",
                  "NPU runtime returned invalid embeddings",
                );
            } else if (typeof body.text !== "string")
              throw new HttpFailure(
                502,
                "provider_failure",
                "NPU runtime returned no transcription",
              );
            const cost =
              modality === "embeddings"
                ? promptTokens === null || deployment.inputUsdPerMillion === null
                  ? null
                  : (promptTokens * deployment.inputUsdPerMillion) / 1_000_000
                : deployment.requestUsd;
            metadata = {
              ...metadata,
              promptTokens,
              completionTokens: modality === "embeddings" ? 0 : null,
              generationElapsedMs: Date.now() - generatedAt,
              estimatedCostUsd: cost,
              localComputeEstimatedUsd: cost,
              costSource: cost === null ? null : "local-rate-card",
            };
            const normalized = {
              ...body,
              model: deployment.id,
              usage: { ...usage, prompt_tokens: promptTokens, total_tokens: promptTokens, cost },
            };
            return input.responseFormat === "text" ? String(body.text) : normalized;
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
    const headers = {
      "x-request-id": correlationId,
      "x-deployment-id": deployment.id,
      "x-queue-wait-ms": String(metadata.queueWaitMs ?? 0),
    };
    return typeof exit.value === "string"
      ? new Response(exit.value, {
          headers: noStoreHeaders({ ...headers, "content-type": "text/plain; charset=utf-8" }),
        })
      : jsonResponse(200, exit.value, headers);
  } catch (error) {
    if (admission !== undefined && !persisted) {
      try {
        await deps.keys.finalize(admission, {
          ...metadata,
          status: signal.aborted ? "abandoned" : "error",
          errorCode: signal.aborted ? "Cancelled" : "AuxiliaryFailure",
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
  }
}
