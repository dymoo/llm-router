import type { SamplingOptions } from "../sampling.ts";
import { Clock, Context, Effect, Layer } from "effect";
import {
  checkCatalogueForInference,
  checkFeasibility,
  applyConfiguredRateCardUsd,
  type Assessment,
  type ClassifiedAssessment,
  type ClassifyInput,
  type Deployment,
  type KeyPolicy,
  type LocalDeploymentBrief,
  type Priority,
  type RequestAccounting,
  type Reservation,
  type SessionBoundary,
  type SessionPin,
} from "../domain.ts";
import {
  BoundaryRequired,
  CapacityBusy,
  CatalogueInvalid,
  EmptyAllowlist,
  ImpossibleLimits,
  MissingSession,
  NoEligibleModel,
  ProviderFailure,
  RetrievalRequired,
  UnsupportedCapabilities,
  type ClassifierError,
  type KeyLifecycleError,
  InvalidInput,
} from "../errors.ts";
import { adaptersFor } from "./adapters/index.ts";
import { holdReadableStream, type FetchImpl } from "./adapters/http.ts";
import { observeSseUsage } from "./sse.ts";
import { attachUsage } from "./cost.ts";
import type { AdapterRequest, ProviderAdapter } from "./adapters/types.ts";
import { emptyProviderUsage, type ProviderUsage } from "./accounting.ts";
import {
  createCapacityPool,
  waitBudgetMs,
  type CapacityPool,
  type Permit,
  type QueueEvent,
} from "./capacity.ts";
import {
  cloudSpillPermitted,
  preferredLocationFromBias,
  UNKNOWN_SATURATION,
  type SaturationEvidence,
} from "./locality.ts";
import { continuityKey } from "./continuity.ts";
import { pinRequestedEffort, type AppliedEffort, type RequestedEffort } from "./effort.ts";
import { LockTimeout, QueueFull } from "./failures.ts";
import type { ChatMessage } from "./messages.ts";
import { serializeMessages } from "./messages.ts";
import {
  CHECKPOINT_SCORE_MARGIN,
  DEFAULT_LOCK_WAIT_MS,
  createSessionStore,
  type SessionStore,
} from "./session.ts";
import {
  selectRoute,
  type CacheEvidence,
  type RankedCandidate,
  type SelectRouteResult,
} from "./select-route.ts";
import { decideReason, exclusionsOf, type RouteDecision } from "./decision.ts";

export interface Classification {
  readonly assessment: Assessment;
  readonly usage: {
    readonly input_tokens: number | null;
    readonly output_tokens: number | null;
  };
  readonly backend: "laya" | "jev" | null;
  readonly modelRevision: string | null;
  readonly cacheHit: boolean;
  readonly elapsedMs: number | null;
  readonly reuse: RequestAccounting["reuse"];
  readonly source: RequestAccounting["source"];
}

export interface RouterWork {
  readonly requestId: string;
  readonly keyId: string;
  readonly policy: KeyPolicy;
  readonly keyPolicyVersion?: number;
  readonly messages: readonly ChatMessage[];
  readonly tools?: unknown;
  readonly toolChoice?: unknown;
  readonly responseFormat?: unknown;
  readonly sampling?: SamplingOptions;
  readonly maxCompletionTokens?: number;
  readonly inputTokens: number;
  readonly routing: {
    readonly sessionId: string;
    readonly boundary: SessionBoundary;
    readonly taskBrief?: string;
    readonly qualityOverride?: "highest";
  };
  readonly capabilities: {
    readonly tools: boolean;
    readonly json: boolean;
    readonly vision: boolean;
  };
  readonly freshFactsAvailable: boolean;
  readonly cacheEvidence?: CacheEvidence;
  readonly stream: boolean;
}

export interface RouteHeaders {
  readonly requestId: string;
  readonly deploymentId: string;
  readonly sessionId: string;
  readonly appliedEffort: AppliedEffort;
  readonly requestedEffort: RequestedEffort;
  readonly priority: Priority;
  readonly queued: boolean;
  readonly waitedMs: number;
}

export interface RoutedCompletion {
  readonly headers: RouteHeaders;
  readonly reservation: Reservation;
  readonly body: Record<string, unknown>;
  readonly accounting: RequestAccounting;
  readonly decision: RouteDecision;
}

export interface RoutedStream {
  readonly headers: RouteHeaders;
  readonly reservation: Reservation;
  readonly body: ReadableStream<Uint8Array>;
  readonly accounting: RequestAccounting;
  readonly decision: RouteDecision;
}

export type RouterFailure =
  | BoundaryRequired
  | CapacityBusy
  | CatalogueInvalid
  | EmptyAllowlist
  | ImpossibleLimits
  | MissingSession
  | NoEligibleModel
  | ProviderFailure
  | RetrievalRequired
  | UnsupportedCapabilities
  | QueueFull
  | LockTimeout
  | ClassifierError
  | KeyLifecycleError
  | InvalidInput;

export interface RouterOptions {
  readonly catalogue: readonly Deployment[];
  readonly catalogueVersion: string;
  readonly classify: (input: ClassifyInput) => Effect.Effect<ClassifiedAssessment, ClassifierError>;
  readonly fetch?: FetchImpl;
  readonly credentials?: (envVar: string) => string | undefined;
  readonly unavailable?: ReadonlySet<string>;
  readonly saturation?: (deploymentId: string) => SaturationEvidence;
  readonly onBeforeDispatch?: (
    work: RouterWork,
    reservation: Reservation,
  ) => Effect.Effect<void, KeyLifecycleError | InvalidInput>;
  readonly onQueue?: (event: QueueEvent) => void;
  readonly onDecision?: (decision: RouteDecision, work: RouterWork) => void;
  readonly onClassified?: (work: RouterWork, classified: Classification) => void;
  readonly lockWaitMs?: number;
  readonly sessionTtlMs?: number;
  readonly sessionCapacity?: number;
  readonly queueSlots?: number;
}

export class ModelRouter extends Context.Service<
  ModelRouter,
  {
    readonly complete: (work: RouterWork) => Effect.Effect<RoutedCompletion, RouterFailure>;
    readonly stream: (work: RouterWork) => Effect.Effect<RoutedStream, RouterFailure>;
  }
>()("llm-router/router/ModelRouter") {}

export const modelRouterLayer = (options: RouterOptions) =>
  Layer.effect(
    ModelRouter,
    Effect.sync(() => {
      const sessions = createSessionStore({
        capacity: options.sessionCapacity,
        ttlMs: options.sessionTtlMs,
      });
      const pool = createCapacityPool({ queueSlots: options.queueSlots });
      const adapters = adaptersFor(options.fetch ?? fetch);
      const credentials = options.credentials ?? ((envVar: string) => process.env[envVar]);
      const lockWaitMs = options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS;
      const complete = (work: RouterWork) =>
        runRouted(
          work,
          options,
          sessions,
          pool,
          adapters,
          credentials,
          lockWaitMs,
          false,
        ) as Effect.Effect<RoutedCompletion, RouterFailure>;
      const stream = (work: RouterWork) =>
        runRouted(
          work,
          options,
          sessions,
          pool,
          adapters,
          credentials,
          lockWaitMs,
          true,
        ) as Effect.Effect<RoutedStream, RouterFailure>;
      return ModelRouter.of({ complete, stream });
    }),
  );

function runRouted(
  work: RouterWork,
  options: RouterOptions,
  sessions: SessionStore,
  pool: CapacityPool,
  adapters: Record<Deployment["transport"], ProviderAdapter>,
  credentials: (envVar: string) => string | undefined,
  lockWaitMs: number,
  stream: boolean,
): Effect.Effect<RoutedCompletion | RoutedStream, RouterFailure> {
  return sessions.withLock(
    work.keyId,
    work.routing.sessionId,
    lockWaitMs,
    executeLocked(work, options, sessions, pool, adapters, credentials, stream),
    stream
      ? (result, release) => {
          if (result.body instanceof ReadableStream) {
            Object.assign(result, { body: holdReadableStream(new Response(result.body), release) });
          } else release();
        }
      : undefined,
  );
}

function executeLocked(
  work: RouterWork,
  options: RouterOptions,
  sessions: SessionStore,
  pool: CapacityPool,
  adapters: Record<Deployment["transport"], ProviderAdapter>,
  credentials: (envVar: string) => string | undefined,
  stream: boolean,
): Effect.Effect<RoutedCompletion | RoutedStream, RouterFailure> {
  return Effect.gen(function* () {
    const catalogue = yield* checkCatalogueForInference(options.catalogue);
    const generationAllowance = Math.min(
      work.maxCompletionTokens ?? work.policy.maxCompletionTokens,
      work.policy.maxCompletionTokens,
    );
    yield* checkFeasibility({
      policy: work.policy,
      catalogue,
      estimatedInputTokens: work.inputTokens,
      requestedCompletionTokens: generationAllowance,
      capabilities: work.capabilities,
    });

    const now = yield* Clock.currentTimeMillis;
    const key = continuityKey({
      messages: work.messages,
      tools: work.tools,
      toolChoice: work.toolChoice,
      responseFormat: work.responseFormat,
    });
    const pin = sessions.get(work.keyId, work.routing.sessionId, now);

    if (work.routing.boundary === "continue") {
      if (work.routing.qualityOverride === "highest") {
        return yield* Effect.fail(
          new BoundaryRequired({ message: "quality override requires a checkpoint boundary" }),
        );
      }
      if (pin === undefined) {
        return yield* Effect.fail(
          new MissingSession({ message: "session pin is missing or expired" }),
        );
      }
      if (pin.continuityKey !== key) {
        return yield* Effect.fail(
          new BoundaryRequired({ message: "continuity key changed; checkpoint required" }),
        );
      }
    }

    const classified = yield* classifyIfNeeded(work, options, catalogue, pin);
    options.onClassified?.(work, classified);
    const unavailable = yield* probeUnavailable(
      catalogue,
      adapters,
      credentials,
      options.unavailable,
    );
    const selected = selectRoute({
      assessment: classified.assessment,
      deployments: catalogue,
      policy: work.policy,
      inputTokens: work.inputTokens,
      generationAllowance,
      tools: work.capabilities.tools,
      json: work.capabilities.json,
      vision: work.capabilities.vision,
      boundary: work.routing.boundary,
      freshFactsAvailable: work.freshFactsAvailable,
      unavailable,
      cacheEvidence: work.cacheEvidence,
      qualityOverride: work.routing.qualityOverride,
      preferredLocation: preferredLocationFromBias(work.policy.localityBias),
      pinRequestedEffort:
        work.routing.boundary === "continue"
          ? pinRequestedEffort(pin?.requestedEffort ?? "low")
          : undefined,
    });
    if (selected._tag === "Denied") {
      const denied = denialDecision(work, options, classified, selected);
      options.onDecision?.(denied, work);
      return yield* Effect.fail(toDenialError(selected));
    }

    const chosen = chooseCandidate(work, pin, selected);
    if (chosen._tag === "fail") {
      return yield* Effect.fail(chosen.error);
    }

    const saturation =
      options.saturation !== undefined
        ? options.saturation("local")
        : yield* readLocalSaturation(catalogue, adapters, credentials);
    const spill = cloudSpillPermitted(
      work.policy,
      classified.assessment,
      saturation,
      work.routing.boundary,
    );
    let rankedDeployments = chosen.candidates.map((candidate) => candidate.deployment);
    if (work.routing.boundary === "continue" && pin !== undefined) {
      rankedDeployments = rankedDeployments.filter(
        (deployment) => deployment.id === pin.deploymentId,
      );
      if (rankedDeployments.length === 0) {
        return yield* Effect.fail(
          new BoundaryRequired({ message: "pinned deployment is no longer eligible" }),
        );
      }
    } else if (!spill) {
      rankedDeployments = rankedDeployments.filter((deployment) => deployment.location === "local");
      if (rankedDeployments.length === 0) {
        const detail =
          "No eligible local deployment; cloud escalation is not authorized by locality policy";
        const denied = denialDecision(work, options, classified, {
          _tag: "Denied",
          code: "health",
          detail,
          denials: selected.denials,
        });
        options.onDecision?.(
          {
            ...denied,
            selectionReason: { code: "no-eligible", detail },
            exclusions: [
              ...denied.exclusions,
              ...chosen.candidates.map((candidate) => ({
                deploymentId: candidate.deployment.id,
                code: "saturation" as const,
                detail,
              })),
            ],
          },
          work,
        );
        return yield* Effect.fail(new NoEligibleModel({ message: detail }));
      }
    }

    let queued = false;
    let waitedMs = 0;
    const permit = yield* pool.acquire(rankedDeployments, work.policy.priority, {
      requestId: work.requestId,
      waitMs: waitBudgetMs(work.policy),
      spill: spill && work.routing.boundary !== "continue",
      onQueue: (event) => {
        if (event.state === "queued") {
          queued = true;
        }
        waitedMs = event.waitedMs;
        options.onQueue?.(event);
      },
    });

    const candidate =
      chosen.candidates.find((entry) => entry.deployment.id === permit.deploymentId) ??
      chosen.candidates[0]!;
    const reservation: Reservation = {
      requestId: work.requestId,
      deploymentId: candidate.deployment.id,
      sessionId: work.routing.sessionId,
      requestedEffort: candidate.requestedEffort,
      appliedEffort: candidate.appliedEffort,
    };
    const headers: RouteHeaders = {
      requestId: work.requestId,
      deploymentId: candidate.deployment.id,
      sessionId: work.routing.sessionId,
      appliedEffort: candidate.appliedEffort,
      requestedEffort: candidate.requestedEffort,
      priority: work.policy.priority,
      queued,
      waitedMs,
    };
    const reason = decideReason({
      pinned: work.routing.boundary === "continue",
      qualityOverride: work.routing.qualityOverride === "highest",
      queued,
      selectedLocation: candidate.deployment.location,
      spilledForSaturation:
        saturation.verified && saturation.saturated && candidate.deployment.location === "cloud",
      spilledForComplexity:
        candidate.deployment.location === "cloud" &&
        (classified.assessment.difficulty.value === "hard" ||
          classified.assessment.localSufficiency < 0.8),
    });
    const decision: RouteDecision = {
      reason,
      selectionReason: { code: reason, detail: reason },
      exclusions: exclusionsOf(selected.denials),
      assessment: {
        task: classified.assessment.task,
        difficulty: classified.assessment.difficulty.value,
        difficultyConfidence: classified.assessment.difficulty.confidence,
        localSufficiency: classified.assessment.localSufficiency,
        freshFacts: classified.assessment.freshFacts,
        trivialChat: classified.assessment.trivialChat,
        effortConfidence: classified.assessment.effort.confidence,
        requestedEffort: candidate.requestedEffort,
        appliedEffort: candidate.appliedEffort,
      },
      keyPolicyVersion: work.keyPolicyVersion ?? null,
      catalogueVersion: options.catalogueVersion,
      priority: work.policy.priority,
      localityBias: work.policy.localityBias,
      bias: work.policy.bias,
      queue: { queued, waitedMs },
      saturation: {
        verified: saturation.verified,
        saturated: saturation.saturated,
        observedAtMs: null,
        ageMs: null,
      },
    };
    options.onDecision?.(decision, work);

    const dispatched = yield* Effect.acquireUseRelease(
      Effect.succeed(permit),
      (held) =>
        dispatch(
          work,
          options,
          sessions,
          candidate,
          held,
          adapters,
          credentials,
          stream,
          classified,
          headers,
          reservation,
          pin,
          decision,
        ),
      (held, exit) =>
        Effect.sync(() => {
          if (stream && exit._tag === "Success") {
            return;
          }
          held.release();
        }),
    );
    return dispatched;
  });
}

function classifyIfNeeded(
  work: RouterWork,
  options: RouterOptions,
  catalogue: readonly Deployment[],
  pin: SessionPin | undefined,
): Effect.Effect<Classification, RouterFailure> {
  if (work.routing.boundary === "continue" && pin !== undefined) {
    return Effect.succeed({
      assessment: pin.assessment,
      usage: { input_tokens: null, output_tokens: null },
      backend: null,
      modelRevision: null,
      cacheHit: false,
      elapsedMs: null,
      reuse: "session",
      source: null,
    });
  }
  const source = work.routing.taskBrief !== undefined ? "caller-brief" : "full-input";
  const state = work.routing.taskBrief ?? serializeMessages(work.messages);
  const localDeployments: LocalDeploymentBrief[] = catalogue
    .filter((deployment) => deployment.location === "local")
    .map((deployment) => ({
      id: deployment.id,
      modelId: deployment.modelId,
      contextLimitTokens: deployment.contextLimitTokens,
      quality: {
        chat: deployment.quality.chat,
        coding: deployment.quality.coding,
        math: deployment.quality.math,
        analysis: deployment.quality.analysis,
        writing: deployment.quality.writing,
        extraction: deployment.quality.extraction,
      },
    }));
  const pendingToolCalls = work.messages.reduce((count, message) => {
    if (!Array.isArray(message.tool_calls)) {
      return count;
    }
    return count + message.tool_calls.length;
  }, 0);
  return options
    .classify({
      state,
      localDeployments,
      keyId: work.keyId,
      catalogueVersion: options.catalogueVersion,
      source,
      meta: {
        fullPromptTokenEstimate: work.inputTokens,
        toolCount: Array.isArray(work.tools) ? work.tools.length : 0,
        turnCount: work.messages.length,
        pendingToolCalls,
      },
    })
    .pipe(
      Effect.map((result) => ({
        assessment: result.assessment,
        usage: {
          input_tokens: result.usage.input_tokens ?? null,
          output_tokens: result.usage.output_tokens ?? null,
        },
        backend: result.backend,
        modelRevision: result.modelRevision,
        cacheHit: result.cacheHit,
        elapsedMs: result.elapsedMs ?? null,
        reuse: result.reuse,
        source: result.source,
      })),
    );
}

function probeUnavailable(
  catalogue: readonly Deployment[],
  adapters: Record<Deployment["transport"], ProviderAdapter>,
  credentials: (envVar: string) => string | undefined,
  extra?: ReadonlySet<string>,
): Effect.Effect<ReadonlySet<string>> {
  return Effect.gen(function* () {
    const unavailable = new Set<string>(extra ?? []);
    for (const deployment of catalogue) {
      const credential =
        deployment.credentialEnvVar === null ? undefined : credentials(deployment.credentialEnvVar);
      if (
        deployment.credentialEnvVar !== null &&
        (credential === undefined || credential.length === 0)
      ) {
        unavailable.add(deployment.id);
        continue;
      }
      const down = yield* adapters[deployment.transport].probeUnavailable(deployment, credential);
      if (down) {
        unavailable.add(deployment.id);
      }
    }
    return unavailable;
  });
}

function chooseCandidate(
  work: RouterWork,
  pin: SessionPin | undefined,
  selected: Extract<SelectRouteResult, { _tag: "Selected" }>,
):
  | { readonly _tag: "ok"; readonly candidates: readonly RankedCandidate[] }
  | { readonly _tag: "fail"; readonly error: RouterFailure } {
  if (work.routing.boundary === "continue") {
    return { _tag: "ok", candidates: selected.ranked };
  }
  if (
    work.routing.boundary === "checkpoint" &&
    pin !== undefined &&
    work.routing.qualityOverride !== "highest"
  ) {
    const pinned = selected.ranked.find(
      (candidate) => candidate.deployment.id === pin.deploymentId,
    );
    const best = selected.ranked[0];
    if (
      pinned !== undefined &&
      best !== undefined &&
      best.score < pinned.score + CHECKPOINT_SCORE_MARGIN
    ) {
      return {
        _tag: "ok",
        candidates: [
          pinned,
          ...selected.ranked.filter(
            (candidate) => candidate.deployment.id !== pinned.deployment.id,
          ),
        ],
      };
    }
  }
  return { _tag: "ok", candidates: selected.ranked };
}

function toDenialError(result: Extract<SelectRouteResult, { _tag: "Denied" }>): RouterFailure {
  const message = result.detail;
  switch (result.code) {
    case "deny-all":
      return new EmptyAllowlist({ message });
    case "impossible-limits":
      return new ImpossibleLimits({ message });
    case "retrieval-required":
      return new RetrievalRequired({ message });
    case "capability":
      return new UnsupportedCapabilities({ message });
    default:
      return new NoEligibleModel({ message });
  }
}

function dispatch(
  work: RouterWork,
  options: RouterOptions,
  sessions: SessionStore,
  candidate: RankedCandidate,
  permit: Permit,
  adapters: Record<Deployment["transport"], ProviderAdapter>,
  credentials: (envVar: string) => string | undefined,
  stream: boolean,
  classified: Classification,
  headers: RouteHeaders,
  reservation: Reservation,
  pin: SessionPin | undefined,
  decision: RouteDecision,
): Effect.Effect<RoutedCompletion | RoutedStream, RouterFailure> {
  return Effect.gen(function* () {
    if (options.onBeforeDispatch !== undefined) {
      yield* options.onBeforeDispatch(work, reservation);
    }
    const credential =
      candidate.deployment.credentialEnvVar === null
        ? undefined
        : credentials(candidate.deployment.credentialEnvVar);
    const adapterRequest: AdapterRequest = {
      deployment: candidate.deployment,
      messages: work.messages,
      tools: work.tools,
      toolChoice: work.toolChoice,
      responseFormat: work.responseFormat,
      sampling: work.sampling,
      maxCompletionTokens: Math.min(
        work.maxCompletionTokens ?? work.policy.maxCompletionTokens,
        work.policy.maxCompletionTokens,
        candidate.deployment.maxOutputTokens,
      ),
      requestedEffort: candidate.requestedEffort,
      appliedEffort: candidate.appliedEffort,
      credential,
    };
    const adapter = adapters[candidate.deployment.transport];
    const startedAt = yield* Clock.currentTimeMillis;
    if (stream) {
      const response = yield* adapter.stream(adapterRequest);
      const now = yield* Clock.currentTimeMillis;
      persistPin(sessions, work, candidate, classified.assessment, now);
      const accounting = {
        ...accountingOf(classified, candidate, emptyProviderUsage(), pin, now - startedAt, null),
        generationElapsedMs: null,
      };
      const body = observeSseUsage(
        holdReadableStream(response, () => permit.release()),
        (usage) => {
          Object.assign(
            accounting,
            accountingOf(classified, candidate, usage, pin, Date.now() - startedAt, null),
          );
        },
        candidate.deployment.location === "local"
          ? (frame, usage) =>
              attachUsage(
                {
                  ...frame,
                  choices: [],
                },
                candidate.deployment,
                usage,
              )
          : undefined,
        startedAt,
      );
      return {
        headers,
        reservation,
        body,
        accounting,
        decision,
      } satisfies RoutedStream;
    }
    const completion = yield* adapter.complete(adapterRequest);
    const finishedAt = yield* Clock.currentTimeMillis;
    const body = yield* Effect.try({
      try: () => attachUsage(completion.body, candidate.deployment, completion.usage),
      catch: () => new ProviderFailure({ message: "Invalid local token usage" }),
    });
    persistPin(sessions, work, candidate, classified.assessment, finishedAt);
    return {
      headers,
      reservation,
      body,
      accounting: accountingOf(
        classified,
        candidate,
        completion.usage,
        pin,
        finishedAt - startedAt,
        null,
      ),
      decision,
    } satisfies RoutedCompletion;
  });
}

function persistPin(
  sessions: SessionStore,
  work: RouterWork,
  candidate: RankedCandidate,
  assessment: Assessment,
  nowMs: number,
): void {
  sessions.set(work.keyId, work.routing.sessionId, {
    deploymentId: candidate.deployment.id,
    requestedEffort: pinRequestedEffort(candidate.requestedEffort),
    appliedEffort: candidate.appliedEffort === "none" ? "low" : candidate.appliedEffort,
    continuityKey: continuityKey({
      messages: work.messages,
      tools: work.tools,
      toolChoice: work.toolChoice,
      responseFormat: work.responseFormat,
    }),
    assessment,
    createdAt: nowMs,
  });
}

function accountingOf(
  classified: Classification,
  candidate: RankedCandidate,
  usage: ProviderUsage,
  pin: SessionPin | undefined,
  elapsedMs: number,
  errorCode: string | null,
): RequestAccounting {
  const pricedUsage = applyConfiguredRateCardUsd(candidate.deployment.prices, {
    prompt: usage.promptTokens,
    cached: usage.cachedTokens,
    completion: usage.completionTokens,
  });
  return {
    classifierBackend:
      classified.backend === "laya" || classified.backend === "jev" ? classified.backend : null,
    modelRevision: classified.modelRevision,
    source: classified.source,
    classifierInputTokens: classified.reuse === "classified" ? classified.usage.input_tokens : 0,
    classifierElapsedMs: classified.elapsedMs,
    reuse: classified.reuse,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    reasoningTokens: usage.reasoningTokens,
    cachedInputTokens: usage.cachedTokens,
    ttftMs: usage.ttftMs,
    generationElapsedMs: elapsedMs,
    providerReportedUsd:
      candidate.deployment.location === "cloud" ? usage.providerReportedCostUsd : null,
    estimatedCostUsd: pricedUsage,
    estimatedCacheSavingsUsd:
      usage.cachedTokens === null || candidate.deployment.prices.provenance.source === "unknown"
        ? null
        : (usage.cachedTokens *
            Math.max(
              0,
              candidate.deployment.prices.inputUsdPerMillion -
                candidate.deployment.prices.cachedInputUsdPerMillion,
            )) /
          1_000_000,
    localComputeEstimatedUsd: candidate.deployment.location === "local" ? pricedUsage : null,
    costSource:
      candidate.deployment.location === "local"
        ? pricedUsage === null
          ? null
          : "local-rate-card"
        : usage.providerReportedCostUsd !== null
          ? "provider-reported"
          : pricedUsage === null
            ? null
            : "estimated",
    decodeTokensPerSecond: usage.decodeTokensPerSecond,
    priceVersion: candidate.deployment.prices.provenance.asOf,
    trajectoryHash: pin?.continuityKey ?? null,
    errorCode,
  };
}

function denialDecision(
  work: RouterWork,
  options: RouterOptions,
  classified: Classification,
  selected: Extract<SelectRouteResult, { _tag: "Denied" }>,
): RouteDecision {
  return {
    reason: "no-eligible",
    selectionReason: { code: "no-eligible", detail: selected.detail },
    exclusions: exclusionsOf(selected.denials),
    assessment: {
      task: classified.assessment.task,
      difficulty: classified.assessment.difficulty.value,
      difficultyConfidence: classified.assessment.difficulty.confidence,
      localSufficiency: classified.assessment.localSufficiency,
      freshFacts: classified.assessment.freshFacts,
      trivialChat: classified.assessment.trivialChat,
      effortConfidence: classified.assessment.effort.confidence,
      requestedEffort: null,
      appliedEffort: null,
    },
    keyPolicyVersion: work.keyPolicyVersion ?? null,
    catalogueVersion: options.catalogueVersion,
    priority: work.policy.priority,
    localityBias: work.policy.localityBias,
    bias: work.policy.bias,
    queue: { queued: false, waitedMs: 0 },
    saturation: { verified: false, saturated: false, observedAtMs: null, ageMs: null },
  };
}

function readLocalSaturation(
  catalogue: readonly Deployment[],
  adapters: Record<Deployment["transport"], ProviderAdapter>,
  credentials: (envVar: string) => string | undefined,
): Effect.Effect<SaturationEvidence> {
  return Effect.gen(function* () {
    const locals = catalogue.filter((deployment) => deployment.location === "local");
    if (locals.length === 0) {
      return UNKNOWN_SATURATION;
    }
    let verified = false;
    let unknown = false;
    for (const deployment of locals) {
      const reader = adapters[deployment.transport].readSaturation;
      if (reader === undefined) {
        unknown = true;
        continue;
      }
      const credential =
        deployment.credentialEnvVar === null ? undefined : credentials(deployment.credentialEnvVar);
      if (
        deployment.credentialEnvVar !== null &&
        (credential === undefined || credential.length === 0)
      ) {
        unknown = true;
        continue;
      }
      const snapshot = yield* reader(deployment, credential);
      if (!snapshot.verified) {
        unknown = true;
        continue;
      }
      verified = true;
      if (!snapshot.saturated) {
        return { verified: true, saturated: false };
      }
    }
    if (!verified || unknown) {
      return UNKNOWN_SATURATION;
    }
    return { verified: true, saturated: true };
  });
}
