import "server-only";

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { getEnv, getProviderCredentials } from "../env.ts";
import { RouterClassifier } from "../src/classifier.ts";
import { Catalogue, type Deployment } from "../src/domain.ts";
import type {
  FinalizeOutcome,
  InferenceDeps,
  InferenceGateway,
  RoutedWork,
} from "../src/http/contracts.ts";
import { ModelRouter, modelRouterLayer, type RouterWork } from "../src/router/index.ts";
import type { RoutedCompletion, RoutedStream } from "../src/router/model-router.ts";
import { disposeControlPlane, keys, recheckLease } from "./control.ts";
import { GatewayFailure } from "../src/http/gateway-failure.ts";
import { processState, type InferenceRuntime } from "./state.ts";
import { assertAcceptingWork } from "./lifecycle.ts";

const { queueHooks, observed } = processState;
export const statusStore = processState.status;

function loadCatalogue(path: string): {
  catalogue: readonly Deployment[];
  catalogueVersion: string;
} {
  const bytes = readFileSync(path);
  const parsed: unknown = JSON.parse(bytes.toString("utf8"));
  const catalogue = Schema.decodeUnknownSync(Catalogue)(parsed);
  const catalogueVersion = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  return { catalogue, catalogueVersion };
}

function makeInferenceRuntime(): InferenceRuntime {
  const env = getEnv();
  const loaded = loadCatalogue(env.MODEL_CATALOG);
  const classifierLayer = RouterClassifier.layer({
    mode: env.CLASSIFIER_MODE,
    layaUrl: env.LAYA_URL,
    layaModelRevision: env.LAYA_MODEL_REVISION,
    jevModel: env.TYPESAFE_MODEL,
    jevApiKey: env.TYPESAFE_API_KEY,
    jevBaseUrl: env.TYPESAFE_BASE_URL,
  });
  const credentials = getProviderCredentials(
    loaded.catalogue.flatMap((deployment) =>
      deployment.credentialEnvVar === null ? [] : [deployment.credentialEnvVar],
    ),
  );
  const routerLayer = Layer.unwrap(
    Effect.map(RouterClassifier, (classifier) =>
      modelRouterLayer({
        catalogue: loaded.catalogue,
        catalogueVersion: loaded.catalogueVersion,
        classify: (input) => classifier.classify(input),
        credentials: (name) => credentials[name],
        onBeforeDispatch: (work, reservation) => {
          const deployment = loaded.catalogue.find((item) => item.id === reservation.deploymentId)!;
          observed.set(work.requestId, {
            ...observed.get(work.requestId),
            deploymentId: deployment.id,
            location: deployment.location,
            transport: deployment.transport,
          });
          return recheckLease(work.requestId).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                queueHooks
                  .get(work.requestId)
                  ?.onDispatched(observed.get(work.requestId)?.queueWaitMs ?? 0);
              }),
            ),
          );
        },
        onClassified: (work, classified) => {
          observed.set(work.requestId, {
            classifierBackend: classified.backend,
            modelRevision: classified.modelRevision,
            source: classified.source,
            classifierInputTokens:
              classified.reuse === "classified" ? classified.usage.input_tokens : 0,
            classifierElapsedMs: classified.elapsedMs,
            reuse: classified.reuse,
          });
        },
        onDecision: (decision, work) => {
          observed.set(work.requestId, {
            ...observed.get(work.requestId),
            boundary: work.routing.boundary,
            decisionReason: decision.reason,
            selectionReasonCode: decision.selectionReason.code,
            selectionReasonDetail: decision.selectionReason.detail,
            exclusionJson: JSON.stringify(decision.exclusions),
            taskKind: decision.assessment.task,
            difficulty: decision.assessment.difficulty,
            requestedEffort: decision.assessment.requestedEffort,
            queueWaitMs: decision.queue.waitedMs,
            saturation: decision.saturation.verified && decision.saturation.saturated,
            decisionTraceJson: JSON.stringify(decision),
          });
        },
        onQueue: (event) => {
          const hooks = queueHooks.get(event.requestId);
          if (hooks === undefined) {
            return;
          }
          if (event.state === "queued") {
            hooks.onQueued(event.waitedMs);
            return;
          }
        },
      }),
    ),
  ).pipe(Layer.provide(classifierLayer));
  return {
    runtime: ManagedRuntime.make(routerLayer),
    catalogue: loaded.catalogue,
  };
}

function getInference() {
  if (processState.inference === undefined) {
    processState.inference = makeInferenceRuntime();
  }
  return processState.inference;
}
export function configuredChatDeployments(): readonly Deployment[] {
  return getInference().catalogue;
}

function toRouterWork(work: RoutedWork): RouterWork {
  return {
    requestId: work.requestId,
    keyId: work.keyId,
    policy: work.policy,
    keyPolicyVersion: work.keyPolicyVersion,
    messages: work.messages,
    tools: work.tools,
    toolChoice: work.toolChoice,
    responseFormat: work.responseFormat,
    sampling: work.sampling,
    maxCompletionTokens: work.maxCompletionTokens,
    inputTokens: work.inputTokens,
    routing: {
      sessionId: work.routing.sessionId,
      boundary: work.routing.boundary,
      taskBrief: work.routing.taskBrief,
    },
    capabilities: {
      tools: work.capabilities.tools,
      json: work.capabilities.json,
      vision: work.capabilities.vision,
    },
    freshFactsAvailable: false,
    stream: work.stream,
  };
}

function runAbortable<A, E>(
  effect: Effect.Effect<A, E, ModelRouter>,
  signal?: AbortSignal,
): Promise<A> {
  return getInference().runtime.runPromise(effect, { signal });
}

function resultMetadata(
  work: RoutedWork,
  result: RoutedCompletion | RoutedStream,
): Omit<FinalizeOutcome, "status"> {
  const deployment = getInference().catalogue.find(
    (item) => item.id === result.headers.deploymentId,
  )!;
  const { decodeTokensPerSecond, ...accounting } = result.accounting;
  return {
    ...accounting,
    deploymentId: deployment.id,
    location: deployment.location,
    transport: deployment.transport,
    boundary: work.routing.boundary,
    trajectoryHash: createHash("sha256")
      .update(JSON.stringify([work.keyId, work.routing.sessionId]))
      .digest("hex"),
    decodeTps: decodeTokensPerSecond,
    queueWaitMs: result.headers.waitedMs,
    decisionReason: result.decision.reason,
    selectionReasonCode: result.decision.selectionReason.code,
    selectionReasonDetail: result.decision.selectionReason.detail,
    exclusionJson: JSON.stringify(result.decision.exclusions),
    taskKind: result.decision.assessment.task,
    difficulty: result.decision.assessment.difficulty,
    requestedEffort: result.decision.assessment.requestedEffort,
    saturation: result.decision.saturation.verified && result.decision.saturation.saturated,
    cacheObservation:
      accounting.cachedInputTokens === null
        ? "unknown"
        : accounting.cachedInputTokens > 0
          ? "observed-hit"
          : "observed-miss",
    decisionTraceJson: JSON.stringify(result.decision),
  };
}

const gateway: InferenceGateway = {
  complete: async (work, hooks, signal) => {
    if (hooks !== undefined) queueHooks.set(work.requestId, hooks);
    let result: RoutedCompletion;
    try {
      result = await runAbortable(
        ModelRouter.use((router) => router.complete(toRouterWork(work))),
        signal,
      );
    } catch (error) {
      throw new GatewayFailure(
        error,
        observed.get(work.requestId) ?? {
          decisionReason: "failed-precheck",
          selectionReasonCode: "failed-precheck",
        },
      );
    } finally {
      queueHooks.delete(work.requestId);
      observed.delete(work.requestId);
    }
    return {
      headers: {
        requestId: result.headers.requestId,
        deploymentId: result.headers.deploymentId,
        sessionId: result.headers.sessionId,
        appliedEffort: result.headers.appliedEffort,
        priority: result.headers.priority,
        queueWaitMs: result.headers.waitedMs,
      },
      body: result.body,
      metadata: () => resultMetadata(work, result),
    };
  },
  stream: async (work, hooks, signal) => {
    if (hooks !== undefined) {
      queueHooks.set(work.requestId, hooks);
    }
    try {
      const result = await runAbortable(
        ModelRouter.use((router) => router.stream(toRouterWork(work))),
        signal,
      );
      return {
        headers: {
          requestId: result.headers.requestId,
          deploymentId: result.headers.deploymentId,
          sessionId: result.headers.sessionId,
          appliedEffort: result.headers.appliedEffort,
          priority: result.headers.priority,
          queueWaitMs: result.headers.waitedMs,
        },
        body: result.body,
        metadata: () => resultMetadata(work, result),
      };
    } catch (error) {
      throw new GatewayFailure(
        error,
        observed.get(work.requestId) ?? {
          decisionReason: "failed-precheck",
          selectionReasonCode: "failed-precheck",
        },
      );
    } finally {
      queueHooks.delete(work.requestId);
      observed.delete(work.requestId);
    }
  },
};

export function getInferenceDeps(): InferenceDeps {
  assertAcceptingWork();
  getInference();
  return {
    keys,
    gateway,
    status: statusStore,
  };
}

export async function disposeGateway(): Promise<void> {
  if (processState.inference !== undefined) {
    await processState.inference.runtime.dispose();
    processState.inference = undefined;
  }
  await disposeControlPlane();
}
