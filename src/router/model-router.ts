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
import type { FinalizeOutcome } from "../keys/types.ts";
import {
  BoundaryRequired,
  CapacityBusy,
  CatalogueInvalid,
  EmptyAllowlist,
  ImpossibleLimits,
  MissingSession,
  NoEligibleModel,
  LocalOverloaded,
  ProviderFailure,
  RetrievalRequired,
  UnsupportedCapabilities,
  type ClassifierError,
  type KeyLifecycleError,
  InvalidInput,
} from "../errors.ts";
import { adaptersFor, openRouterBody } from "./adapters/index.ts";
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
  readonly assessment: Assessment | null;
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
  readonly parallelToolCalls?: boolean;
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

export interface BatchSpillPlan {
  readonly deployment: Deployment;
  readonly body: Record<string, unknown>;
  readonly metadata: Omit<FinalizeOutcome, "status">;
}

export type RouterFailure =
  | BoundaryRequired
  | CapacityBusy
  | CatalogueInvalid
  | EmptyAllowlist
  | ImpossibleLimits
  | MissingSession
  | NoEligibleModel
  | LocalOverloaded
  | ProviderFailure
  | RetrievalRequired
  | UnsupportedCapabilities
  | QueueFull
  | LockTimeout
  | ClassifierError
  | KeyLifecycleError
  | InvalidInput;

export type RouterOptions = RouterCommonOptions &
  (
    | { readonly mode: "rules" }
    | {
        readonly mode?: "classifier";
        readonly classify: (
          input: ClassifyInput,
        ) => Effect.Effect<ClassifiedAssessment, ClassifierError>;
      }
  );

interface RouterCommonOptions {
  readonly catalogue: readonly Deployment[];
  readonly catalogueVersion: string;

  readonly fetch?: FetchImpl;
  readonly credentials?: (envVar: string) => string | undefined;
  readonly unavailable?: ReadonlySet<string>;
  readonly saturation?: (deploymentId: string) => SaturationEvidence;
  readonly onBeforeDispatch?: (
    work: RouterWork,
    reservation: Reservation,
  ) => Effect.Effect<void, KeyLifecycleError | InvalidInput>;
  readonly onQueue?: (event: QueueEvent) => void;
  readonly onQueueOutcome?: (event: "timeout" | "full", priority: Priority) => void;
  readonly onDecision?: (decision: RouteDecision, work: RouterWork) => void;
  readonly onClassified?: (work: RouterWork, classified: Classification) => void;
  readonly onCapacityPool?: (pool: CapacityPool) => void;
  readonly onOpenRouterCompleted?: (deployment: Deployment, generationId: unknown) => void;
  readonly lockWaitMs?: number;
  readonly sessionTtlMs?: number;
  readonly sessionCapacity?: number;
  readonly queueSlots?: number;
}

type RouteMode =
  | { readonly kind: "interactive" }
  | { readonly kind: "batch-local"; readonly requestedModel: string }
  | {
      readonly kind: "batch-spill";
      readonly requestedModel: string;
      readonly catalogue: readonly Deployment[];
    };

interface ForegroundTracker {
  readonly enter: () => () => void;
  readonly state: { value: number };
}

function createForegroundTracker(): ForegroundTracker {
  const state = { value: 0 };
  return {
    state,
    enter: () => {
      state.value += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        state.value = Math.max(0, state.value - 1);
      };
    },
  };
}

export class ModelRouter extends Context.Service<
  ModelRouter,
  {
    readonly complete: (work: RouterWork) => Effect.Effect<RoutedCompletion, RouterFailure>;
    readonly stream: (work: RouterWork) => Effect.Effect<RoutedStream, RouterFailure>;
    readonly completeBatch: (
      work: RouterWork,
      requestedModel: string,
    ) => Effect.Effect<RoutedCompletion, RouterFailure>;
    readonly planBatchSpill: (
      work: RouterWork,
      catalogue: readonly Deployment[],
      requestedModel: string,
    ) => Effect.Effect<BatchSpillPlan, RouterFailure>;
    readonly interactiveIdle: () => boolean;
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
      options.onCapacityPool?.(pool);
      const adapters = adaptersFor(options.fetch ?? fetch);
      const credentials = options.credentials ?? ((envVar: string) => process.env[envVar]);
      const lockWaitMs = options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS;
      const foreground = createForegroundTracker();
      const complete = (work: RouterWork) =>
        Effect.acquireUseRelease(
          Effect.sync(foreground.enter),
          (release) =>
            runRouted(
              work,
              options,
              sessions,
              pool,
              adapters,
              credentials,
              lockWaitMs,
              false,
              { kind: "interactive" },
              release,
            ),
          (release) => Effect.sync(release),
        ) as Effect.Effect<RoutedCompletion, RouterFailure>;
      const stream = (work: RouterWork) =>
        Effect.acquireUseRelease(
          Effect.sync(foreground.enter),
          (release) =>
            runRouted(
              work,
              options,
              sessions,
              pool,
              adapters,
              credentials,
              lockWaitMs,
              true,
              { kind: "interactive" },
              release,
            ),
          (release, exit) =>
            Effect.sync(() => {
              if (exit._tag !== "Success") release();
            }),
        ) as Effect.Effect<RoutedStream, RouterFailure>;
      const completeBatch = (work: RouterWork, requestedModel: string) =>
        runRouted(
          work,
          options,
          sessions,
          pool,
          adapters,
          credentials,
          lockWaitMs,
          false,
          { kind: "batch-local", requestedModel },
          undefined,
          () => foreground.state.value === 0,
        ).pipe(Effect.map((result) => result as RoutedCompletion));
      const planBatchSpill = (
        work: RouterWork,
        catalogue: readonly Deployment[],
        requestedModel: string,
      ) =>
        planSpill(work, options, sessions, pool, adapters, credentials, catalogue, requestedModel);
      const interactiveIdle = () => foreground.state.value === 0;
      return ModelRouter.of({
        complete,
        stream,
        completeBatch,
        planBatchSpill,
        interactiveIdle,
      });
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
  mode: RouteMode = { kind: "interactive" },
  onInteractiveRelease?: () => void,
  isInteractiveIdle: () => boolean = () => true,
): Effect.Effect<RoutedCompletion | RoutedStream | BatchSpillPlan, RouterFailure> {
  return sessions.withLock(
    work.keyId,
    work.routing.sessionId,
    lockWaitMs,
    executeLocked(
      work,
      options,
      sessions,
      pool,
      adapters,
      credentials,
      stream,
      mode,
      isInteractiveIdle,
    ),
    stream
      ? (result, release) => {
          if (result.body instanceof ReadableStream) {
            Object.assign(result, {
              body: holdReadableStream(new Response(result.body), () => {
                release();
                onInteractiveRelease?.();
              }),
            });
          } else {
            release();
            onInteractiveRelease?.();
          }
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
  mode: RouteMode,
  isInteractiveIdle: () => boolean,
): Effect.Effect<RoutedCompletion | RoutedStream | BatchSpillPlan, RouterFailure> {
  return Effect.gen(function* () {
    const configuredCatalogue = yield* checkCatalogueForInference(options.catalogue);
    let sourceCatalogue: readonly Deployment[] = configuredCatalogue;
    if (mode.kind === "batch-spill") {
      sourceCatalogue = yield* checkCatalogueForInference(mode.catalogue);
    }
    const catalogue = sourceCatalogue.filter((deployment) => {
      if (mode.kind === "interactive") {
        return true;
      }
      if (mode.kind === "batch-local") {
        return (
          deployment.location === "local" &&
          (mode.requestedModel === "auto" || deployment.id === mode.requestedModel)
        );
      }
      return (
        deployment.location === "cloud" &&
        deployment.transport === "openrouter" &&
        (mode.requestedModel === "auto" || deployment.id === mode.requestedModel)
      );
    });
    if (catalogue.length === 0) {
      return yield* Effect.fail(
        new NoEligibleModel({
          message:
            mode.kind === "batch-spill"
              ? "No eligible cloud OpenRouter batch deployment"
              : "No eligible local batch deployment",
        }),
      );
    }
    const generationAllowance = Math.min(
      work.maxCompletionTokens ?? work.policy.maxCompletionTokens,
      work.policy.maxCompletionTokens,
    );
    // Rules uses the selection seam's complete hard filters, without assessment prechecks.
    if (options.mode !== "rules") {
      yield* checkFeasibility({
        policy: work.policy,
        catalogue,
        estimatedInputTokens: work.inputTokens,
        requestedCompletionTokens: generationAllowance,
        capabilities: work.capabilities,
      });
    }

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

    const classified = yield* classifyIfNeeded(work, options, configuredCatalogue, pin);
    options.onClassified?.(work, classified);
    let availability: DeploymentAvailability;
    if (mode.kind === "batch-spill") {
      availability = unavailableWithoutProviderProbe(catalogue, credentials, options.unavailable);
    } else {
      availability = yield* probeUnavailable(catalogue, adapters, credentials, options.unavailable);
    }
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
      unavailable: availability.unavailable,
      missingCredentials: availability.missingCredentials,
      cacheEvidence: work.cacheEvidence,
      qualityOverride: work.routing.qualityOverride,
      preferredLocation: preferredLocationFromBias(work.policy.localityBias),
      pinRequestedEffort:
        work.routing.boundary === "continue"
          ? options.mode === "rules"
            ? pin?.requestedEffort
            : pinRequestedEffort(pin?.requestedEffort ?? "low")
          : undefined,
    });
    // In Rules, a health denial means the other hard constraints already passed.
    const localUnavailable =
      options.mode === "rules" &&
      mode.kind !== "batch-spill" &&
      selected.denials.some(
        (denial) =>
          denial.code === "health" &&
          catalogue.some(
            (deployment) =>
              deployment.id === denial.deploymentId &&
              deployment.location === "local" &&
              (work.routing.boundary === "continue"
                ? deployment.id === pin?.deploymentId
                : work.policy.localityBias >= 0.5 || selected._tag === "Denied"),
          ),
      ) &&
      (work.routing.boundary === "continue" ||
        selected._tag === "Denied" ||
        !selected.ranked.some((entry) => entry.deployment.location === "local"));
    if (
      localUnavailable &&
      (work.policy.overloadAction === "report" ||
        work.routing.boundary === "continue" ||
        selected._tag === "Denied")
    ) {
      const failed = denialDecision(work, options, classified, {
        _tag: "Denied",
        code: "health",
        detail: "Local deployment unavailable",
        denials: selected.denials,
      });
      options.onDecision?.(
        {
          ...failed,
          reason: "local-overloaded",
          selectionReason: { code: "local-overloaded", detail: "local-unavailable" },
        },
        work,
      );
      return yield* new LocalOverloaded({
        message: "Local deployment unavailable",
        retryAfterSeconds: null,
      });
    }
    if (selected._tag === "Denied") {
      const denied = denialDecision(work, options, classified, selected);
      options.onDecision?.(denied, work);
      return yield* Effect.fail(
        options.mode === "rules" && selected.denials.length > 0
          ? new NoEligibleModel({ message: selected.detail })
          : toDenialError(selected),
      );
    }

    const chosen = chooseCandidate(work, pin, selected);
    if (chosen._tag === "fail") {
      return yield* Effect.fail(chosen.error);
    }

    let saturation: SaturationEvidence;
    if (mode.kind === "interactive") {
      if (options.saturation !== undefined) {
        saturation = options.saturation("local");
      } else {
        saturation = yield* readLocalSaturation(catalogue, adapters, credentials);
      }
    } else {
      saturation = UNKNOWN_SATURATION;
    }
    const spill =
      mode.kind === "interactive" &&
      (classified.assessment === null
        ? chosen.candidates[0]?.deployment.location === "cloud"
        : cloudSpillPermitted(
            work.policy,
            classified.assessment,
            saturation,
            work.routing.boundary,
          ));
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
    } else if (!spill && mode.kind !== "batch-spill") {
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

    const overloadFailover =
      mode.kind === "interactive" &&
      work.policy.overloadAction === "failover" &&
      work.routing.boundary !== "continue" &&
      rankedDeployments[0]?.location === "local";
    if (overloadFailover) {
      const localFirst: Deployment[] = [];
      for (const entry of chosen.candidates) {
        if (entry.deployment.location === "local") localFirst.push(entry.deployment);
      }
      for (const entry of chosen.candidates) {
        if (entry.deployment.location === "cloud") localFirst.push(entry.deployment);
      }
      rankedDeployments = localFirst;
    }
    let queued = false;
    let waitedMs = 0;
    let permit: Permit | undefined;
    if (mode.kind === "batch-spill") {
      permit = undefined;
    } else if (mode.kind === "batch-local") {
      permit = pool.tryAcquireIdleOnly(rankedDeployments, work.policy.priority, isInteractiveIdle);
      if (permit === undefined) {
        return yield* Effect.fail(
          new CapacityBusy({ message: "batch requires an interactive-idle permit" }),
        );
      }
    } else {
      const capacityStartedAt = yield* Clock.currentTimeMillis;
      permit = yield* pool
        .acquire(rankedDeployments, work.policy.priority, {
          requestId: work.requestId,
          waitMs: overloadFailover ? 0 : waitBudgetMs(work.policy),
          spill: spill && work.routing.boundary !== "continue",
          onQueue: (event) => {
            if (event.state === "queued") {
              queued = true;
            }
            waitedMs = event.waitedMs;
            options.onQueue?.(event);
          },
          onOutcome: options.onQueueOutcome,
        })
        .pipe(
          Effect.mapError((error) =>
            rankedDeployments.some((deployment) => deployment.location === "local")
              ? new LocalOverloaded({
                  message: "Local deployment overloaded",
                  retryAfterSeconds: null,
                })
              : error,
          ),
          Effect.tapError((error) =>
            Effect.gen(function* () {
              if (error._tag !== "LocalOverloaded") return;
              waitedMs = Math.max(waitedMs, (yield* Clock.currentTimeMillis) - capacityStartedAt);
              const failed = denialDecision(work, options, classified, {
                _tag: "Denied",
                code: "health",
                detail: "local-overloaded",
                denials: selected.denials,
              });
              options.onDecision?.(
                {
                  ...failed,
                  reason: "local-overloaded",
                  selectionReason: { code: "local-overloaded", detail: "local-overloaded" },
                  queue: { queued, waitedMs },
                  exclusions: [
                    ...failed.exclusions,
                    ...rankedDeployments
                      .filter((deployment) => deployment.location === "local")
                      .map((deployment) => ({
                        deploymentId: deployment.id,
                        code: "saturation" as const,
                        detail: "router-owned local permit unavailable",
                      })),
                  ],
                },
                work,
              );
            }),
          ),
        );
    }

    const candidate =
      chosen.candidates.find(
        (entry) => entry.deployment.id === (permit?.deploymentId ?? rankedDeployments[0]?.id),
      ) ?? chosen.candidates[0]!;
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
    const overloadedToCloud =
      (overloadFailover || localUnavailable) && candidate.deployment.location === "cloud";
    const reason = overloadedToCloud
      ? "local-overload-failover"
      : classified.assessment === null
        ? "deterministic-rules"
        : decideReason({
            pinned: work.routing.boundary === "continue",
            qualityOverride: work.routing.qualityOverride === "highest",
            queued,
            selectedLocation: candidate.deployment.location,
            spilledForSaturation:
              saturation.verified &&
              saturation.saturated &&
              candidate.deployment.location === "cloud",
            spilledForComplexity:
              candidate.deployment.location === "cloud" &&
              (classified.assessment.difficulty.value === "hard" ||
                classified.assessment.localSufficiency < 0.8),
          });
    const decision: RouteDecision = {
      reason,
      selectionReason: { code: reason, detail: reason },
      exclusions: overloadedToCloud
        ? [
            ...exclusionsOf(selected.denials),
            ...chosen.candidates
              .filter((entry) => entry.deployment.location === "local")
              .map((entry) => ({
                deploymentId: entry.deployment.id,
                code: "saturation" as const,
                detail: "router-owned local permit unavailable",
              })),
          ]
        : exclusionsOf(selected.denials),
      assessment: {
        task: classified.assessment?.task ?? null,
        difficulty: classified.assessment?.difficulty.value ?? null,
        difficultyConfidence: classified.assessment?.difficulty.confidence ?? null,
        localSufficiency: classified.assessment?.localSufficiency ?? null,
        freshFacts: classified.assessment?.freshFacts ?? null,
        trivialChat: classified.assessment?.trivialChat ?? null,
        effortConfidence: classified.assessment?.effort.confidence ?? null,
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
    if (mode.kind === "batch-spill") {
      const request = adapterRequestFor(work, candidate, credentials);
      return {
        deployment: candidate.deployment,
        body: openRouterBody(request, false),
        metadata: batchMetadataOf(work, candidate, classified, decision, pin),
      } satisfies BatchSpillPlan;
    }
    if (permit === undefined) {
      return yield* Effect.fail(new CapacityBusy({ message: "missing route permit" }));
    }

    const send = (
      entry: RankedCandidate,
      heldPermit: Permit,
      routeHeaders: RouteHeaders,
      routeReservation: Reservation,
      routeDecision: RouteDecision,
    ) =>
      Effect.acquireUseRelease(
        Effect.succeed(heldPermit),
        (held) =>
          dispatch(
            work,
            options,
            sessions,
            entry,
            held,
            adapters,
            credentials,
            stream,
            classified,
            routeHeaders,
            routeReservation,
            pin,
            routeDecision,
            // Batch work runs only on runtime-verified spare capacity.
            mode.kind === "batch-local" ? "flex" : undefined,
          ),
        (held, exit) =>
          Effect.sync(() => {
            if (stream && exit._tag === "Success") return;
            held.release();
          }),
      );

    return yield* send(candidate, permit, headers, reservation, decision).pipe(
      Effect.catchTag("LocalOverloaded", (error) =>
        Effect.gen(function* () {
          const reportRejected = () => {
            if (candidate.deployment.location !== "local") return;
            options.onDecision?.(
              {
                ...decision,
                reason: "local-overloaded",
                selectionReason: { code: "local-overloaded", detail: "local-overloaded" },
                exclusions: [
                  ...decision.exclusions,
                  {
                    deploymentId: candidate.deployment.id,
                    code: "saturation",
                    detail: "local runtime rejected before enqueue",
                  },
                ],
              },
              work,
            );
          };
          if (mode.kind === "batch-local" && error.flexRefused === true) {
            // No spare capacity right now: the batch item stays queued. A full
            // queue or a draining runtime keeps the key's overload policy.
            reportRejected();
            return yield* new CapacityBusy({
              message: "local runtime has no spare capacity for batch work",
            });
          }
          if (
            mode.kind !== "interactive" ||
            work.policy.overloadAction !== "failover" ||
            work.routing.boundary === "continue" ||
            candidate.deployment.location !== "local"
          ) {
            reportRejected();
            return yield* error;
          }

          let next: RankedCandidate | undefined;
          let cloudPermit: Permit | undefined;
          for (const entry of chosen.candidates) {
            if (entry.deployment.location !== "cloud") continue;
            cloudPermit = pool.tryAcquire(entry.deployment, work.policy.priority);
            if (cloudPermit !== undefined) {
              next = entry;
              break;
            }
          }
          if (next === undefined || cloudPermit === undefined) {
            reportRejected();
            return yield* error;
          }
          const nextDecision: RouteDecision = {
            ...decision,
            reason: "local-overload-failover",
            selectionReason: { code: "local-overload-failover", detail: "local-overload-failover" },
            exclusions: [
              ...decision.exclusions,
              {
                deploymentId: candidate.deployment.id,
                code: "saturation",
                detail: "local runtime rejected before enqueue",
              },
            ],
            assessment: {
              ...decision.assessment,
              requestedEffort: next.requestedEffort,
              appliedEffort: next.appliedEffort,
            },
          };
          options.onDecision?.(nextDecision, work);
          return yield* send(
            next,
            cloudPermit,
            {
              ...headers,
              deploymentId: next.deployment.id,
              requestedEffort: next.requestedEffort,
              appliedEffort: next.appliedEffort,
            },
            {
              ...reservation,
              deploymentId: next.deployment.id,
              requestedEffort: next.requestedEffort,
              appliedEffort: next.appliedEffort,
            },
            nextDecision,
          );
        }),
      ),
    );
  });
}

function planSpill(
  work: RouterWork,
  options: RouterOptions,
  sessions: SessionStore,
  pool: CapacityPool,
  adapters: Record<Deployment["transport"], ProviderAdapter>,
  credentials: (envVar: string) => string | undefined,
  catalogue: readonly Deployment[],
  requestedModel: string,
): Effect.Effect<BatchSpillPlan, RouterFailure> {
  return runRouted(
    work,
    options,
    sessions,
    pool,
    adapters,
    credentials,
    options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS,
    false,
    { kind: "batch-spill", catalogue, requestedModel },
  ).pipe(Effect.map((result) => result as BatchSpillPlan));
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
  if (options.mode === "rules") {
    return Effect.succeed({
      assessment: null,
      usage: { input_tokens: null, output_tokens: null },
      backend: null,
      modelRevision: null,
      cacheHit: false,
      elapsedMs: null,
      reuse: null,
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

interface DeploymentAvailability {
  readonly unavailable: ReadonlySet<string>;
  readonly missingCredentials: ReadonlySet<string>;
}

function probeUnavailable(
  catalogue: readonly Deployment[],
  adapters: Record<Deployment["transport"], ProviderAdapter>,
  credentials: (envVar: string) => string | undefined,
  extra?: ReadonlySet<string>,
): Effect.Effect<DeploymentAvailability> {
  return Effect.gen(function* () {
    const unavailable = new Set<string>(extra ?? []);
    const missingCredentials = new Set<string>();
    for (const deployment of catalogue) {
      const credential =
        deployment.credentialEnvVar === null ? undefined : credentials(deployment.credentialEnvVar);
      if (
        deployment.credentialEnvVar !== null &&
        (credential === undefined || credential.length === 0)
      ) {
        unavailable.add(deployment.id);
        missingCredentials.add(deployment.id);
        continue;
      }
      const down = yield* adapters[deployment.transport].probeUnavailable(deployment, credential);
      if (down) {
        unavailable.add(deployment.id);
      }
    }
    return { unavailable, missingCredentials };
  });
}

function unavailableWithoutProviderProbe(
  catalogue: readonly Deployment[],
  credentials: (envVar: string) => string | undefined,
  extra?: ReadonlySet<string>,
): DeploymentAvailability {
  const unavailable = new Set<string>(extra ?? []);
  const missingCredentials = new Set<string>();
  for (const deployment of catalogue) {
    if (
      deployment.credentialEnvVar !== null &&
      (credentials(deployment.credentialEnvVar) ?? "").length === 0
    ) {
      unavailable.add(deployment.id);
      missingCredentials.add(deployment.id);
    }
  }
  return { unavailable, missingCredentials };
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

function adapterRequestFor(
  work: RouterWork,
  candidate: RankedCandidate,
  credentials: (envVar: string) => string | undefined,
  serviceTier?: "flex",
): AdapterRequest {
  const credential =
    candidate.deployment.credentialEnvVar === null
      ? undefined
      : credentials(candidate.deployment.credentialEnvVar);
  return {
    deployment: candidate.deployment,
    messages: work.messages,
    tools: work.tools,
    toolChoice: work.toolChoice,
    parallelToolCalls: work.parallelToolCalls,
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
    requestId: work.requestId,
    ...(serviceTier === undefined ? {} : { serviceTier }),
  };
}

function batchMetadataOf(
  work: RouterWork,
  candidate: RankedCandidate,
  classified: Classification,
  decision: RouteDecision,
  pin: SessionPin | undefined,
): BatchSpillPlan["metadata"] {
  const accounting = accountingOf(classified, candidate, emptyProviderUsage(), pin, 0, null);
  return {
    ...accounting,
    deploymentId: candidate.deployment.id,
    location: candidate.deployment.location,
    transport: candidate.deployment.transport,
    boundary: work.routing.boundary,
    trajectoryHash: accounting.trajectoryHash,
    decodeTps: null,
    queueWaitMs: 0,
    decisionReason: decision.reason,
    selectionReasonCode: decision.selectionReason.code,
    selectionReasonDetail: decision.selectionReason.detail,
    exclusionJson: JSON.stringify(decision.exclusions),
    taskKind: decision.assessment.task,
    difficulty: decision.assessment.difficulty,
    requestedEffort: decision.assessment.requestedEffort,
    saturation: decision.saturation.verified && decision.saturation.saturated,
    cacheObservation:
      accounting.cachedInputTokens === null
        ? "unknown"
        : accounting.cachedInputTokens > 0
          ? "observed-hit"
          : "observed-miss",
    decisionTraceJson: JSON.stringify(decision),
  };
}

function reportOpenRouterCompletion(
  candidate: RankedCandidate,
  options: RouterOptions,
  generationId: unknown,
): void {
  if (candidate.deployment.transport === "openrouter")
    options.onOpenRouterCompleted?.(candidate.deployment, generationId);
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
  serviceTier?: "flex",
): Effect.Effect<RoutedCompletion | RoutedStream, RouterFailure> {
  return Effect.gen(function* () {
    if (options.onBeforeDispatch !== undefined) {
      yield* options.onBeforeDispatch(work, reservation);
    }
    const adapterRequest = adapterRequestFor(work, candidate, credentials, serviceTier);
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
        (generationId) => reportOpenRouterCompletion(candidate, options, generationId),
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
    reportOpenRouterCompletion(candidate, options, completion.body.id);
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
  assessment: Assessment | null,
  nowMs: number,
): void {
  sessions.set(work.keyId, work.routing.sessionId, {
    deploymentId: candidate.deployment.id,
    requestedEffort:
      assessment === null
        ? candidate.requestedEffort
        : pinRequestedEffort(candidate.requestedEffort),
    appliedEffort:
      assessment === null || candidate.appliedEffort !== "none" ? candidate.appliedEffort : "low",
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
      task: classified.assessment?.task ?? null,
      difficulty: classified.assessment?.difficulty.value ?? null,
      difficultyConfidence: classified.assessment?.difficulty.confidence ?? null,
      localSufficiency: classified.assessment?.localSufficiency ?? null,
      freshFacts: classified.assessment?.freshFacts ?? null,
      trivialChat: classified.assessment?.trivialChat ?? null,
      effortConfidence: classified.assessment?.effort.confidence ?? null,
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
