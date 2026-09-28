import { Cause, Effect, Exit, Predicate } from "effect";
import type { AuxiliaryDeployment } from "../auxiliary.ts";
import { createDeadline } from "../deadline.ts";
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
    // TypeSafe SDKs list models from `models`; OpenAI SDKs read `data`.
    const cards = deps.deployments
      .filter((item) => item.modality === "systemone" && permitted(policy.allowedModels, item.id))
      .map((item) => ({
        name: item.id,
        description: `System One classification (${item.transport ?? "gufo"}: ${item.modelId})`,
        release_date: "",
      }));
    return jsonResponse(200, {
      object: "list",
      data: ids.map((id) => ({ id, object: "model", created: 0, owned_by: "llm-router" })),
      ...(cards.length > 0 ? { models: cards } : {}),
    });
  } catch (error) {
    return failureResponse(error);
  }
}

type ParsedInput = {
  model: string;
  upstream: Record<string, unknown>;
  inputCount: number;
  bytes: number;
};

/** Questions one System One request may ask (Gufo enforces the same bound). */
export const MAX_SYSTEMONE_QUESTIONS = 128;

// The envelope only: the backend owns the TypeSafe question grammar, so Kev
// and Jev keep one definition of what is valid.
async function decodeInput(request: Request): Promise<ParsedInput> {
  const body = await readJsonObject(request, { maxBytes: 8 * 1024 * 1024, timeoutMs: 30_000 });
  if (!("state" in body)) throw new InvalidInput("state is required");
  const questions = body.questions;
  if (!Predicate.isObject(questions) || Array.isArray(questions))
    throw new InvalidInput("questions must be an object");
  const count = Object.keys(questions).length;
  if (count === 0 || count > MAX_SYSTEMONE_QUESTIONS)
    throw new InvalidInput(`questions must hold 1..${MAX_SYSTEMONE_QUESTIONS} entries`);
  if (body.model !== undefined && (typeof body.model !== "string" || !body.model))
    throw new InvalidInput("model must be a nonempty string");
  return {
    model: typeof body.model === "string" ? body.model : "kev-latest",
    upstream: body,
    inputCount: count,
    bytes: Buffer.byteLength(JSON.stringify(body), "utf8"),
  };
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** TypeSafe System One (`POST /v1/systemone`): Kev on Gufo or TypeSafe's Jev. */
export async function handleSystemOne(request: Request, deps: AuxiliaryDeps): Promise<Response> {
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
    const input = await decodeInput(request);
    const deployment = resolveDeployment(deps.deployments, input.model);
    if (deployment === undefined)
      throw new HttpFailure(404, "not_found", "Model is not configured for this endpoint");
    admission = await deps.keys.admit(rawKey);
    const lease = admission;
    if (!permitted(lease.policy.allowedModels, deployment.id))
      throw new HttpFailure(403, "forbidden", "Model is not allowed for this key");
    if (input.bytes > deployment.maxBodyBytes || input.inputCount > deployment.maxBatchSize) {
      throw new HttpFailure(
        422,
        "invalid",
        "Input exceeds deployment or key limits; split it into smaller chunks",
      );
    }
    // Bytes bound tokens from above, so a per-token rate never under-estimates.
    const estimate =
      deployment.requestUsd ??
      (deployment.inputUsdPerMillion === null
        ? null
        : (input.bytes * deployment.inputUsdPerMillion) / 1_000_000);
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
    const transport = deployment.transport;
    const typesafeRequestId = typesafeRequestIdOf(request) ?? correlationId;
    metadata = {
      deploymentId: deployment.id,
      location: deployment.location ?? "local",
      transport,
      taskKind: "systemone",
      decisionReason: "explicit-model",
      selectionReasonCode: "explicit-model",
      priceVersion: deployment.priceVersion,
      classifierInputTokens: 0,
      classifierElapsedMs: 0,
      cacheObservation: "unknown",
      decisionTraceJson: JSON.stringify({
        modality: "systemone",
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
            input.upstream.model = deployment.modelId;
            const base = deployment.endpoint.replace(/\/$/, "");
            const headers: Record<string, string> = {
              "content-type": "application/json",
              "x-typesafe-request-id": typesafeRequestId,
            };
            const credential =
              deployment.credentialEnvVar === undefined
                ? undefined
                : process.env[deployment.credentialEnvVar];
            if (credential) headers.authorization = `Bearer ${credential}`;
            // The permit stays held until the upstream answers or the deadline passes, even if the
            // client disconnects: the upstream keeps working on it.
            const upstreamDeadline = createDeadline(10 * 60_000);
            const generatedAt = Date.now();
            let bytes: Uint8Array;
            try {
              const response = await (deps.fetch ?? fetch)(`${base}/systemone`, {
                method: "POST",
                redirect: "error",
                signal: upstreamDeadline.signal,
                headers,
                body: JSON.stringify(input.upstream),
              });
              if (!response.ok) throw await systemOneRejection(response);
              bytes = await readBoundedBody(
                new Request("http://response.local", {
                  method: "POST",
                  body: response.body,
                  duplex: "half",
                } as RequestInit),
                { maxBytes: 16 * 1024 * 1024, timeoutMs: 60_000 },
              );
            } finally {
              upstreamDeadline.clear();
            }
            let body: unknown;
            try {
              body = JSON.parse(new TextDecoder().decode(bytes));
            } catch {
              throw new HttpFailure(502, "provider_failure", "System One returned invalid JSON");
            }
            if (!Predicate.isObject(body) || body.error !== undefined)
              throw new HttpFailure(502, "provider_failure", "System One failed");
            const usage = Predicate.isObject(body.usage) ? body.usage : {};
            {
              if (!Predicate.isObject(body.answers))
                throw new HttpFailure(502, "provider_failure", "System One returned no answers");
              const inputTokens = count(usage.input_tokens);
              const outputTokens = count(usage.output_tokens);
              const cost =
                deployment.requestUsd ??
                (inputTokens === null || deployment.inputUsdPerMillion === null
                  ? null
                  : (inputTokens * deployment.inputUsdPerMillion) / 1_000_000);
              metadata = {
                ...metadata,
                promptTokens: inputTokens,
                completionTokens: outputTokens,
                generationElapsedMs: Date.now() - generatedAt,
                estimatedCostUsd: cost,
                localComputeEstimatedUsd: deployment.location === "cloud" ? null : cost,
                costSource: cost === null ? null : "local-rate-card",
              };
              // TypeSafe echoes the model the client asked for.
              return { ...body, model: input.model };
            }
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
    const headers: Record<string, string> = {
      "x-request-id": correlationId,
      "x-deployment-id": deployment.id,
      "x-queue-wait-ms": String(metadata.queueWaitMs ?? 0),
    };
    headers["x-typesafe-request-id"] = typesafeRequestId;
    return jsonResponse(200, exit.value, headers);
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
    const failure = signal.aborted
      ? failureResponse(new HttpFailure(400, "cancelled", "Request cancelled"))
      : failureResponse(error);
    return withDetail(failure);
  } finally {
    deadline.clear();
  }
}

/** TypeSafe request ids are opaque tokens; echo only plain ones. */
function typesafeRequestIdOf(request: Request): string | null {
  const value = request.headers.get("x-typesafe-request-id");
  return value !== null && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : null;
}

/**
 * The deployment a request names. `kev-latest` and `jev-latest` (the TypeSafe
 * SDK default) name the first Kev (gufo) or Jev (typesafe) deployment; they
 * never stand in for each other.
 */
function resolveDeployment(
  deployments: readonly AuxiliaryDeployment[],
  model: string,
): AuxiliaryDeployment | undefined {
  const exact = deployments.find((item) => item.id === model);
  if (exact !== undefined) return exact;
  const transport = model === "kev-latest" ? "gufo" : model === "jev-latest" ? "typesafe" : null;
  return transport === null ? undefined : deployments.find((item) => item.transport === transport);
}

/**
 * A System One upstream refusal: 429 stays retryable with its Retry-After,
 * 422 keeps its detail (the request is invalid), anything else is the
 * provider's failure.
 */
async function systemOneRejection(response: Response): Promise<HttpFailure> {
  let detail = "";
  try {
    const body: unknown = await response.json();
    if (Predicate.isObject(body) && typeof body.detail === "string") detail = body.detail;
  } catch {
    // Keep the generic message.
  }
  if (response.status === 429) {
    const retry = Number(response.headers.get("retry-after"));
    return new HttpFailure(
      429,
      "resource_unavailable",
      "System One is busy",
      Number.isSafeInteger(retry) && retry >= 0 ? retry : 1,
    );
  }
  if (response.status === 422)
    return new HttpFailure(422, "invalid", detail.slice(0, 500) || "invalid System One request");
  return new HttpFailure(502, "provider_failure", "System One upstream failed");
}

/** TypeSafe clients read `detail`; router clients keep `error`. */
async function withDetail(response: Response): Promise<Response> {
  const body = (await response.json()) as { error?: { message?: string } };
  return jsonResponse(
    response.status,
    { detail: body.error?.message ?? "error", ...body },
    response.headers,
  );
}
