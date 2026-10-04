import { Clock, Context, Duration, Effect, Layer, Option } from "effect";
import type { SamplingOptions } from "../sampling.ts";
import {
  applyConfiguredRateCardUsd,
  type AppAttribution,
  checkCatalogueForInference,
  type Deployment,
  type KeyPolicy,
  type Priority,
  type RequestAccounting,
  type Reservation,
} from "../domain.ts";
import type { FinalizeOutcome } from "../keys/types.ts";
import {
  CapacityBusy,
  InvalidInput,
  LocalOverloaded,
  ModelNotAllowed,
  NoEligibleModel,
  ProviderFailure,
  type CatalogueInvalid,
  type KeyLifecycleError,
} from "../errors.ts";
import { adaptersFor, openRouterBody } from "./adapters/index.ts";
import { holdReadableStream, type FetchImpl } from "./adapters/http.ts";
import type { AdapterRequest } from "./adapters/types.ts";
import { emptyProviderUsage, type ProviderUsage } from "./accounting.ts";
import {
  createCapacityPool,
  DEFAULT_FLEX_LIMIT,
  FLEX_MAX_WAIT_MS,
  FLEX_PROMOTE_AFTER_MS,
  LOCAL_WAIT_MS,
  type CapacityPool,
  type Permit,
  type QueueEvent,
  type WorkPriority,
} from "./capacity.ts";
import { attachUsage } from "./cost.ts";
import type { RouteDecision, RouteDecisionReason } from "./decision.ts";
import { effortFor, type AppliedEffort, type RequestedEffort } from "./effort.ts";
import { createFlexQueue } from "./flex.ts";
import type { ChatMessage } from "./messages.ts";
import { createSessionStore } from "./session.ts";
import { observeSseUsage } from "./sse.ts";

/** Floor on the pause between Gufo attempts, so a zero Retry-After cannot spin. */
const RETRY_MIN_MS = 250;

export interface RouterWork {
  /** `auto` (default), `cheap`, or a model id to pin (a deployment's `modelId` or variant). */
  readonly model?: string;
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
  /** The client's `reasoning_effort`, mapped per deployment; absent = cheapest. */
  readonly reasoningEffort?: RequestedEffort;
  readonly inputTokens: number;
  /** Client session for stickiness only: never a reason to fail. */
  readonly sessionId?: string;
  readonly capabilities: {
    readonly tools: boolean;
    readonly json: boolean;
    readonly vision: boolean;
  };
  readonly stream: boolean;
  /** Flex tier (low keys, or `service_tier: "flex"`): local idle compute only. */
  readonly serviceTier?: "flex";
  /** Client app attribution, passed to adapters only; routing never reads it. */
  readonly appAttribution?: AppAttribution;
}

export interface RouteHeaders {
  readonly requestId: string;
  readonly deploymentId: string;
  readonly sessionId?: string;
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
  | CapacityBusy
  | CatalogueInvalid
  | NoEligibleModel
  | LocalOverloaded
  | ProviderFailure
  | KeyLifecycleError
  | InvalidInput
  | ModelNotAllowed;

export interface RouterOptions {
  readonly catalogue: readonly Deployment[];
  readonly catalogueVersion: string;
  readonly fetch?: FetchImpl;
  readonly credentials?: (envVar: string) => string | undefined;
  readonly unavailable?: ReadonlySet<string>;
  readonly onBeforeDispatch?: (
    work: RouterWork,
    reservation: Reservation,
  ) => Effect.Effect<void, KeyLifecycleError | InvalidInput>;
  readonly onQueue?: (event: QueueEvent) => void;
  readonly onQueueOutcome?: (event: "timeout" | "full", priority: Priority) => void;
  readonly onDecision?: (decision: RouteDecision, work: RouterWork) => void;
  readonly onCapacityPool?: (pool: CapacityPool) => void;
  readonly onOpenRouterCompleted?: (deployment: Deployment, generationId: unknown) => void;
  readonly sessionTtlMs?: number;
  readonly sessionCapacity?: number;
  readonly queueSlots?: number;
  /** Wait budgets; defaults are LOCAL_WAIT_MS and FLEX_MAX_WAIT_MS. */
  readonly waitMs?: {
    readonly high?: number;
    readonly medium?: number;
    readonly flex?: number;
    /** When a waiting flex request is promoted; default FLEX_PROMOTE_AFTER_MS. */
    readonly promote?: number;
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

type Effort = ReturnType<typeof effortFor>;
type Queue = RouteDecision["queue"];
const NOT_QUEUED: Queue = { queued: false, waitedMs: 0 };

/** Whether a deployment could ever serve the request: capabilities, context and output. */
function fits(work: RouterWork, deployment: Deployment): boolean {
  const output = work.maxCompletionTokens ?? 0;
  return (
    (!work.capabilities.tools || deployment.capabilities.tools) &&
    (!work.capabilities.json || deployment.capabilities.json) &&
    (!work.capabilities.vision || deployment.capabilities.vision) &&
    output <= deployment.maxOutputTokens &&
    // max_tokens is a cap, not a reservation: a reply that reaches the end of
    // the context stops with `length`, so only the prompt has to fit.
    work.inputTokens < deployment.contextLimitTokens
  );
}

function stickyFirst(deployments: readonly Deployment[], sticky: string | undefined) {
  return [
    ...deployments.filter((deployment) => deployment.id === sticky),
    ...deployments.filter((deployment) => deployment.id !== sticky),
  ];
}

/** Flex found no idle local compute in time: HTTP 429 `resource_unavailable`. */
const flexUnavailable = (message: string, retryAfterSeconds: number | null) =>
  new LocalOverloaded({ message, retryAfterSeconds: retryAfterSeconds ?? 1, flexRefused: true });

export const modelRouterLayer = (options: RouterOptions) =>
  Layer.effect(
    ModelRouter,
    Effect.sync(() => ModelRouter.of(createRouter(options))),
  );

function createRouter(options: RouterOptions) {
  const sessions = createSessionStore({
    capacity: options.sessionCapacity,
    ttlMs: options.sessionTtlMs,
  });
  const pool = createCapacityPool({ queueSlots: options.queueSlots });
  options.onCapacityPool?.(pool);
  const flex = createFlexQueue();
  const adapters = adaptersFor(options.fetch ?? fetch);
  const credentials = options.credentials ?? ((envVar: string) => process.env[envVar]);
  const waits = {
    high: options.waitMs?.high ?? LOCAL_WAIT_MS.high,
    medium: options.waitMs?.medium ?? LOCAL_WAIT_MS.medium,
    flex: options.waitMs?.flex ?? FLEX_MAX_WAIT_MS,
    promote: options.waitMs?.promote ?? FLEX_PROMOTE_AFTER_MS,
  };
  let foreground = 0;
  const enterForeground = () => {
    foreground += 1;
    let left = false;
    return () => {
      if (left) return;
      left = true;
      foreground -= 1;
    };
  };

  const credentialOf = (deployment: Deployment) =>
    deployment.credentialEnvVar === null ? undefined : credentials(deployment.credentialEnvVar);

  /** Deployments that can take work now: credential present, not marked down, probe healthy. */
  const up = (deployments: readonly Deployment[]) =>
    Effect.forEach(
      deployments,
      (deployment) => {
        const credential = credentialOf(deployment);
        if (
          options.unavailable?.has(deployment.id) === true ||
          (deployment.credentialEnvVar !== null && (credential ?? "").length === 0)
        )
          return Effect.succeed(false);
        return adapters[deployment.transport]
          .probeUnavailable(deployment, credential)
          .pipe(Effect.map((down) => !down));
      },
      { concurrency: "unbounded" },
    ).pipe(Effect.map((ready) => deployments.filter((_, index) => ready[index])));

  const decisionOf = (
    work: RouterWork,
    reason: RouteDecisionReason,
    effort?: Effort,
    queue: Queue = NOT_QUEUED,
  ): RouteDecision => ({
    reason,
    selectionReason: { code: reason, detail: reason },
    exclusions: [],
    requestedEffort: effort?.requestedEffort ?? null,
    appliedEffort: effort?.appliedEffort ?? null,
    keyPolicyVersion: work.keyPolicyVersion ?? null,
    catalogueVersion: options.catalogueVersion,
    priority: work.policy.priority,
    cloud: work.policy.cloud,
    serviceTier: work.serviceTier ?? "default",
    queue,
  });

  const fail = <E>(work: RouterWork, reason: RouteDecisionReason, error: E) => {
    options.onDecision?.(decisionOf(work, reason), work);
    return Effect.fail(error);
  };

  const waiting = (work: RouterWork, queuedAt: number) =>
    Effect.map(Clock.currentTimeMillis, (now) =>
      options.onQueue?.({
        requestId: work.requestId,
        state: "queued",
        priority: work.policy.priority,
        queuedAt,
        waitedMs: now - queuedAt,
      }),
    );

  /** A router permit on the first free deployment in order, or undefined once `waitMs` runs out. */
  const acquire = (
    work: RouterWork,
    ranked: readonly Deployment[],
    waitMs: number,
    priority: WorkPriority,
    onQueued: () => void,
  ) =>
    pool
      .acquire(ranked, priority, {
        requestId: work.requestId,
        waitMs: Math.max(0, waitMs),
        onQueue: (event) => {
          if (event.state === "queued") onQueued();
          options.onQueue?.(event);
        },
        onOutcome: options.onQueueOutcome,
      })
      .pipe(
        Effect.map((permit): Permit | undefined => permit),
        Effect.catch(() => Effect.succeed(undefined)),
      );

  /**
   * One dispatch. The permit (and `onEnd`, for a stream) is held until the
   * response ends. A Gufo pre-enqueue refusal fails with LocalOverloaded, having
   * released the permit, so the caller may wait and try again.
   */
  const send = (
    work: RouterWork,
    stream: boolean,
    deployment: Deployment,
    permit: Permit,
    reason: RouteDecisionReason,
    queue: Queue,
    onEnd: () => void,
    serviceTier?: "flex",
  ): Effect.Effect<RoutedCompletion | RoutedStream, RouterFailure> =>
    Effect.gen(function* () {
      const effort = effortFor(work.reasoningEffort, deployment);
      const decision = decisionOf(work, reason, effort, queue);
      options.onDecision?.(decision, work);
      const reservation: Reservation = {
        requestId: work.requestId,
        deploymentId: deployment.id,
        ...effort,
      };
      if (options.onBeforeDispatch !== undefined) {
        yield* options.onBeforeDispatch(work, reservation);
      }
      const request = adapterRequestFor(
        work,
        deployment,
        effort,
        credentialOf(deployment),
        serviceTier,
      );
      const adapter = adapters[deployment.transport];
      const headers: RouteHeaders = {
        requestId: work.requestId,
        deploymentId: deployment.id,
        ...(work.sessionId === undefined ? {} : { sessionId: work.sessionId }),
        ...effort,
        priority: work.policy.priority,
        ...queue,
      };
      const remember = (now: number) => {
        if (work.sessionId !== undefined)
          sessions.set(work.keyId, work.sessionId, deployment.id, now);
      };
      const reportOpenRouter = (generationId: unknown) => {
        if (deployment.transport === "openrouter")
          options.onOpenRouterCompleted?.(deployment, generationId);
      };
      const startedAt = yield* Clock.currentTimeMillis;
      if (stream) {
        const response = yield* adapter.stream(request);
        remember(yield* Clock.currentTimeMillis);
        const accounting = {
          ...accountingOf(deployment, emptyProviderUsage(), 0),
          generationElapsedMs: null,
        };
        const body = observeSseUsage(
          holdReadableStream(response, () => {
            permit.release();
            onEnd();
          }),
          (usage) => {
            Object.assign(accounting, accountingOf(deployment, usage, Date.now() - startedAt));
          },
          deployment.location === "local"
            ? (frame, usage) => attachUsage({ ...frame, choices: [] }, deployment, usage)
            : undefined,
          startedAt,
          reportOpenRouter,
        );
        return { headers, reservation, body, accounting, decision } satisfies RoutedStream;
      }
      const completion = yield* adapter.complete(request);
      const finishedAt = yield* Clock.currentTimeMillis;
      const body = yield* Effect.try({
        try: () => attachUsage(completion.body, deployment, completion.usage),
        catch: () => new ProviderFailure({ message: "Invalid local token usage" }),
      });
      remember(finishedAt);
      reportOpenRouter(completion.body.id);
      return {
        headers,
        reservation,
        body,
        accounting: accountingOf(deployment, completion.usage, finishedAt - startedAt),
        decision,
      } satisfies RoutedCompletion;
    }).pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          if (!(stream && exit._tag === "Success")) permit.release();
        }),
      ),
    );

  /** `send`, with a pre-enqueue refusal turned into `undefined` and its Retry-After kept. */
  const attempt = (
    dispatch: Effect.Effect<RoutedCompletion | RoutedStream, RouterFailure>,
    onRefused: (retryAfterSeconds: number | null) => void,
  ) =>
    dispatch.pipe(
      Effect.catchTag("LocalOverloaded", (refusal) => {
        onRefused(refusal.retryAfterSeconds);
        return Effect.succeed(undefined);
      }),
    );

  /**
   * High and medium: Gufo first. Wait for a permit, and retry Gufo's
   * pre-enqueue refusals after their Retry-After, within the priority's budget;
   * then the first eligible cloud deployment if the key allows cloud, else
   * `local_overloaded`. A session last served by cloud tries that first.
   */
  const routeDefault = (
    work: RouterWork,
    stream: boolean,
    onEnd: () => void,
    pinned?: Deployment,
  ) =>
    Effect.gen(function* () {
      // A pinned model is the only candidate: no choice, and no cloud failover for local.
      const catalogue =
        pinned === undefined ? yield* checkCatalogueForInference(options.catalogue) : [pinned];
      const local = catalogue.filter((item) => item.location === "local" && fits(work, item));
      const anyCloud = catalogue.filter((item) => item.location === "cloud" && fits(work, item));
      const cloud = work.policy.cloud ? anyCloud : [];
      if (local.length === 0 && cloud.length === 0) {
        return yield* fail(
          work,
          "no-eligible",
          new NoEligibleModel({ message: "No deployment this key may use can serve the request" }),
        );
      }
      const startedAt = yield* Clock.currentTimeMillis;
      const sticky =
        work.sessionId === undefined
          ? undefined
          : sessions.get(work.keyId, work.sessionId, startedAt);
      const stickyCloud = cloud.find((item) => item.id === sticky);
      if (stickyCloud !== undefined && (yield* up([stickyCloud])).length > 0) {
        const permit = pool.tryAcquire(stickyCloud, work.policy.priority);
        if (permit !== undefined)
          return yield* send(work, stream, stickyCloud, permit, "pinned", NOT_QUEUED, onEnd);
      }

      const deadline = startedAt + (work.policy.priority === "high" ? waits.high : waits.medium);
      const localUp = stickyFirst(yield* up(local), sticky);
      let queued = false;
      let retryAfterSeconds: number | null = null;
      const markQueued = () => {
        queued = true;
      };
      const queue = () =>
        Effect.map(Clock.currentTimeMillis, (now): Queue => ({
          queued,
          waitedMs: now - startedAt,
        }));
      while (localUp.length > 0) {
        const now = yield* Clock.currentTimeMillis;
        const permit = yield* acquire(
          work,
          localUp,
          deadline - now,
          work.policy.priority,
          markQueued,
        );
        if (permit === undefined) break;
        const deployment = localUp.find((item) => item.id === permit.deploymentId)!;
        const reason =
          deployment.id === sticky ? "pinned" : queued ? "queue-admitted" : "local-preference";
        const routed = yield* attempt(
          send(work, stream, deployment, permit, reason, yield* queue(), onEnd),
          (seconds) => {
            retryAfterSeconds = seconds;
          },
        );
        if (routed !== undefined) return routed;
        const pause = Math.max(RETRY_MIN_MS, (retryAfterSeconds ?? 1) * 1000);
        if ((yield* Clock.currentTimeMillis) + pause >= deadline) break;
        markQueued();
        yield* waiting(work, startedAt);
        yield* Effect.sleep(Duration.millis(pause));
      }

      // Gufo down (not merely busy): every key may use cloud, so an outage or
      // maintenance never strands a key; cloud-off keys still never pay to skip a queue.
      const gufoDown = local.length > 0 && localUp.length === 0;
      const cloudUp = yield* up(gufoDown ? anyCloud : cloud);
      if (cloudUp.length > 0) {
        const now = yield* Clock.currentTimeMillis;
        const permit = yield* acquire(
          work,
          cloudUp,
          deadline - now,
          work.policy.priority,
          markQueued,
        );
        if (permit === undefined) {
          return yield* fail(
            work,
            "local-overloaded",
            new CapacityBusy({ message: "cloud deployment capacity is busy" }),
          );
        }
        const deployment = cloudUp.find((item) => item.id === permit.deploymentId)!;
        return yield* send(
          work,
          stream,
          deployment,
          permit,
          "local-overload-failover",
          yield* queue(),
          onEnd,
        );
      }
      if (local.length > 0) {
        return yield* fail(
          work,
          "local-overloaded",
          new LocalOverloaded({
            message:
              localUp.length > 0 ? "Local deployment overloaded" : "Local deployment unavailable",
            retryAfterSeconds: retryAfterSeconds ?? 1,
          }),
        );
      }
      return yield* fail(
        work,
        "no-eligible",
        new NoEligibleModel({ message: "No eligible deployment is available" }),
      );
    });

  /**
   * Flex (low keys, `service_tier: "flex"`): local only. Requests queue FIFO
   * per deployment; at most Gufo's `flex_limit` hold a slot and dispatch. The
   * holder retries a refusal after its Retry-After; nobody waits past the flex
   * budget, then `resource_unavailable`.
   */
  const routeFlex = (work: RouterWork, stream: boolean, onEnd: () => void, pinned?: Deployment) =>
    Effect.gen(function* () {
      const catalogue =
        pinned === undefined ? yield* checkCatalogueForInference(options.catalogue) : [pinned];
      const local = catalogue.filter((item) => item.location === "local" && fits(work, item));
      if (local.length === 0) {
        return yield* fail(
          work,
          "no-eligible",
          new NoEligibleModel({ message: "No local deployment can serve this flex request" }),
        );
      }
      const startedAt = yield* Clock.currentTimeMillis;
      const sticky =
        work.sessionId === undefined
          ? undefined
          : sessions.get(work.keyId, work.sessionId, startedAt);
      // ponytail: one deployment per request (sticky, else the first up); no cross-queue balancing.
      const target = stickyFirst(yield* up(local), sticky)[0];
      // Gufo down: the default route sends it to cloud (see routeDefault).
      if (target === undefined) return yield* routeDefault(work, stream, onEnd, pinned);
      const deadline = startedAt + waits.flex;
      const limit =
        (yield* (
          adapters[target.transport].readFlexLimit?.(target, credentialOf(target)) ??
            Effect.succeed(undefined)
        )) ?? DEFAULT_FLEX_LIMIT;
      let queued = false;
      const markQueued = () => {
        queued = true;
      };
      const lane = flex.snapshot(target.id);
      if (lane.waiting > 0 || lane.held >= limit) {
        markQueued();
        yield* waiting(work, startedAt);
      }
      const slot = yield* flex
        .acquire(target.id, limit)
        .pipe(Effect.timeoutOption(Duration.millis(Math.max(0, deadline - startedAt))));
      if (Option.isNone(slot)) {
        return yield* fail(work, "local-overloaded", flexUnavailable("No idle local compute", 1));
      }
      const release = slot.value;
      return yield* Effect.gen(function* () {
        let retryAfterSeconds: number | null = null;
        for (;;) {
          const now = yield* Clock.currentTimeMillis;
          if (now >= deadline) break;
          // Aged past the promotion point: default tier, ranked with high traffic.
          const promoted = now - startedAt >= waits.promote;
          const permit = yield* acquire(
            work,
            [target],
            deadline - now,
            promoted ? "high" : "low",
            markQueued,
          );
          if (permit === undefined) {
            yield* Effect.sleep(Duration.millis(RETRY_MIN_MS));
            continue;
          }
          const reason =
            target.id === sticky ? "pinned" : queued ? "queue-admitted" : "local-preference";
          const routed = yield* attempt(
            send(
              work,
              stream,
              target,
              permit,
              reason,
              { queued, waitedMs: (yield* Clock.currentTimeMillis) - startedAt },
              () => {
                release();
                onEnd();
              },
              promoted ? undefined : "flex",
            ),
            (seconds) => {
              retryAfterSeconds = seconds;
            },
          );
          if (routed !== undefined) return routed;
          const pause = Math.max(RETRY_MIN_MS, (retryAfterSeconds ?? 1) * 1000);
          if ((yield* Clock.currentTimeMillis) + pause > deadline) break;
          markQueued();
          yield* waiting(work, startedAt);
          yield* Effect.sleep(Duration.millis(pause));
        }
        return yield* fail(
          work,
          "local-overloaded",
          flexUnavailable("No idle local compute", retryAfterSeconds),
        );
      }).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (!(stream && exit._tag === "Success")) release();
          }),
        ),
      );
    });

  /**
   * The request's `model`: undefined for `auto` (policy routing), else the one deployment to
   * use. `cheap` picks the lowest catalogue price among deployments the key may use that can
   * serve the request and are up; a model id pins its deployment, carrying the variant's id
   * upstream on the same capacity. Pinning never bypasses key policy: a cloud model for a
   * cloud-off or low-priority key is refused, not rerouted.
   */
  const resolveModel = (work: RouterWork, flexOnly: boolean) =>
    Effect.gen(function* () {
      const model = work.model ?? "auto";
      if (model === "auto") return undefined;
      const catalogue = yield* checkCatalogueForInference(options.catalogue);
      const cloudAllowed = work.policy.cloud && !flexOnly;
      if (model === "cheap") {
        const price = (item: Deployment) =>
          item.prices.inputUsdPerMillion + item.prices.outputUsdPerMillion;
        const candidates = yield* up(
          catalogue.filter(
            (item) => fits(work, item) && (item.location === "local" || cloudAllowed),
          ),
        );
        const cheapest = [...candidates].sort((a, b) => price(a) - price(b))[0];
        if (cheapest !== undefined) return cheapest;
        return yield* fail(
          work,
          "no-eligible",
          new NoEligibleModel({ message: "No deployment this key may use can serve the request" }),
        );
      }
      const deployment = catalogue.find(
        (item) => item.modelId === model || (item.variants ?? []).includes(model),
      );
      if (deployment === undefined) {
        return yield* fail(
          work,
          "no-eligible",
          new InvalidInput({
            message: `unknown model ${JSON.stringify(model)}: GET /v1/models lists auto, cheap and the model ids`,
          }),
        );
      }
      if (deployment.location === "cloud" && !cloudAllowed) {
        return yield* fail(
          work,
          "no-eligible",
          new ModelNotAllowed({
            message: flexOnly
              ? `${model} is a cloud model; low-priority and flex requests run only on local models`
              : `${model} is a cloud model and this key has cloud disabled`,
          }),
        );
      }
      return { ...deployment, modelId: model };
    });

  // Low keys always run as flex: local idle compute only, never cloud.
  const route = <A extends RoutedCompletion | RoutedStream>(work: RouterWork, stream: boolean) =>
    Effect.acquireUseRelease(
      Effect.sync(enterForeground),
      (leave) => {
        const flexOnly = work.serviceTier === "flex" || work.policy.priority === "low";
        return Effect.flatMap(resolveModel(work, flexOnly), (pinned) =>
          flexOnly
            ? routeFlex({ ...work, serviceTier: "flex" }, stream, leave, pinned)
            : routeDefault(work, stream, leave, pinned),
        ) as Effect.Effect<A, RouterFailure>;
      },
      (leave, exit) =>
        Effect.sync(() => {
          if (!(stream && exit._tag === "Success")) leave();
        }),
    );

  /** Batch items run as flex on a permit taken only while no interactive work runs. */
  const completeBatch = (
    work: RouterWork,
    requestedModel: string,
  ): Effect.Effect<RoutedCompletion, RouterFailure> =>
    Effect.gen(function* () {
      const catalogue = yield* checkCatalogueForInference(options.catalogue);
      const local = catalogue.filter(
        (item) =>
          item.location === "local" &&
          (requestedModel === "auto" || item.id === requestedModel) &&
          fits(work, item),
      );
      if (local.length === 0) {
        return yield* fail(
          work,
          "no-eligible",
          new NoEligibleModel({ message: "No eligible local batch deployment" }),
        );
      }
      const ready = yield* up(local);
      if (ready.length === 0) {
        return yield* fail(
          work,
          "local-overloaded",
          new LocalOverloaded({ message: "Local deployment unavailable", retryAfterSeconds: null }),
        );
      }
      const permit = pool.tryAcquireIdleOnly(ready, "low", () => foreground === 0);
      if (permit === undefined) {
        return yield* new CapacityBusy({ message: "batch requires an interactive-idle permit" });
      }
      const deployment = local.find((item) => item.id === permit.deploymentId)!;
      const routed = yield* send(
        work,
        false,
        deployment,
        permit,
        "local-preference",
        NOT_QUEUED,
        () => undefined,
        "flex",
      ).pipe(
        Effect.catchTag(
          "LocalOverloaded",
          (error): Effect.Effect<never, LocalOverloaded | CapacityBusy> =>
            // No spare capacity right now: the item stays queued for a later tick.
            error.flexRefused === true
              ? Effect.fail(new CapacityBusy({ message: "no spare local capacity for batch work" }))
              : Effect.fail(error),
        ),
      );
      return routed as RoutedCompletion;
    });

  /** Provider-free planning of one OpenRouter Batch item; only cloud keys may spill. */
  const planBatchSpill = (
    work: RouterWork,
    batchCatalogue: readonly Deployment[],
    requestedModel: string,
  ) =>
    Effect.gen(function* () {
      const catalogue = yield* checkCatalogueForInference(batchCatalogue);
      const deployment = work.policy.cloud
        ? catalogue.find(
            (item) =>
              item.location === "cloud" &&
              item.transport === "openrouter" &&
              (requestedModel === "auto" || item.id === requestedModel) &&
              fits(work, item) &&
              (item.credentialEnvVar === null || (credentialOf(item) ?? "").length > 0),
          )
        : undefined;
      if (deployment === undefined) {
        return yield* fail(
          work,
          "no-eligible",
          new NoEligibleModel({ message: "No eligible cloud OpenRouter batch deployment" }),
        );
      }
      const effort = effortFor(work.reasoningEffort, deployment);
      const decision = decisionOf(work, "local-overload-failover", effort);
      options.onDecision?.(decision, work);
      const request = adapterRequestFor(work, deployment, effort, credentialOf(deployment));
      return {
        deployment,
        body: openRouterBody(request, false),
        metadata: {
          ...accountingOf(deployment, emptyProviderUsage(), 0),
          deploymentId: deployment.id,
          location: deployment.location,
          transport: deployment.transport,
          queueWaitMs: 0,
          decisionReason: decision.reason,
          selectionReasonCode: decision.selectionReason.code,
          selectionReasonDetail: decision.selectionReason.detail,
          exclusionJson: JSON.stringify(decision.exclusions),
          requestedEffort: effort.requestedEffort,
          saturation: false,
          cacheObservation: "unknown",
          decisionTraceJson: JSON.stringify(decision),
        },
      } satisfies BatchSpillPlan;
    });

  return {
    complete: (work: RouterWork) => route<RoutedCompletion>(work, false),
    stream: (work: RouterWork) => route<RoutedStream>(work, true),
    completeBatch,
    planBatchSpill,
    interactiveIdle: () => foreground === 0,
  };
}

function adapterRequestFor(
  work: RouterWork,
  deployment: Deployment,
  effort: Effort,
  credential: string | undefined,
  serviceTier?: "flex",
): AdapterRequest {
  return {
    deployment,
    messages: work.messages,
    tools: work.tools,
    toolChoice: work.toolChoice,
    parallelToolCalls: work.parallelToolCalls,
    responseFormat: work.responseFormat,
    sampling: work.sampling,
    maxCompletionTokens: Math.min(
      work.maxCompletionTokens ?? deployment.maxOutputTokens,
      deployment.maxOutputTokens,
    ),
    requestedEffort: effort.requestedEffort,
    appliedEffort: effort.appliedEffort,
    credential,
    requestId: work.requestId,
    ...(serviceTier === undefined ? {} : { serviceTier }),
    ...(work.appAttribution === undefined ? {} : { appAttribution: work.appAttribution }),
  };
}

function accountingOf(
  deployment: Deployment,
  usage: ProviderUsage,
  elapsedMs: number,
): RequestAccounting {
  const pricedUsage = applyConfiguredRateCardUsd(deployment.prices, {
    prompt: usage.promptTokens,
    cached: usage.cachedTokens,
    completion: usage.completionTokens,
  });
  return {
    classifierBackend: null,
    modelRevision: null,
    source: null,
    classifierInputTokens: null,
    classifierElapsedMs: null,
    reuse: null,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    reasoningTokens: usage.reasoningTokens,
    cachedInputTokens: usage.cachedTokens,
    ttftMs: usage.ttftMs,
    generationElapsedMs: elapsedMs,
    providerReportedUsd: deployment.location === "cloud" ? usage.providerReportedCostUsd : null,
    estimatedCostUsd: pricedUsage,
    estimatedCacheSavingsUsd:
      usage.cachedTokens === null || deployment.prices.provenance.source === "unknown"
        ? null
        : (usage.cachedTokens *
            Math.max(
              0,
              deployment.prices.inputUsdPerMillion - deployment.prices.cachedInputUsdPerMillion,
            )) /
          1_000_000,
    localComputeEstimatedUsd: deployment.location === "local" ? pricedUsage : null,
    costSource:
      deployment.location === "local"
        ? pricedUsage === null
          ? null
          : "local-rate-card"
        : usage.providerReportedCostUsd !== null
          ? "provider-reported"
          : pricedUsage === null
            ? null
            : "estimated",
    decodeTokensPerSecond: usage.decodeTokensPerSecond,
    priceVersion: deployment.prices.provenance.asOf,
    trajectoryHash: null,
    errorCode: null,
  };
}
