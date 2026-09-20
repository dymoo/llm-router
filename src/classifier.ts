import "server-only";
import { createHash } from "node:crypto";
import { TypeSafeClient, choice, noul, type TypeSafeClientService } from "@compootor/effective-jev";
import { Clock, Context, Duration, Effect, Layer } from "effect";
import {
  ASSESSMENT_QUESTION_SCHEMA_VERSION,
  CLASSIFICATION_CACHE_MAX_ENTRIES,
  CLASSIFICATION_CACHE_TTL_MS,
  CLASSIFIER_ATTEMPT_TIMEOUT_MS,
  CLASSIFIER_MAX_RETRIES,
  CLASSIFIER_TOTAL_TIMEOUT_MS,
  JEV_MODEL_ID,
  JEV_STATE_PLUS_LONGEST_QUESTION_LIMIT,
  JEV_TOTAL_TOKEN_LIMIT,
  type Assessment,
  type ClassifiedAssessment,
  type ClassifierMode,
  type ClassifierSource,
  type ClassifyInput,
  type LayaBudget,
  type LayaHealth,
  decodeAssessment,
  decodeLayaBudget,
  decodeLayaHealth,
  decodeLayaResponse,
} from "./domain.ts";
import {
  BriefRequired,
  ClassifierContextExceeded,
  ClassifierInvalidResponse,
  ClassifierTimeout,
  ClassifierUnavailable,
  type ClassifierError,
} from "./errors.ts";

export const assessmentQuestions = {
  task: choice("What is the primary task type? Answer independently of the other questions.", {
    chat: "Conversation, greeting, or open-ended talk that is not mainly code, math, analysis, writing, or extraction.",
    coding: "Software implementation, debugging, refactoring, or programming-tool use.",
    math: "Calculation, proof, or quantitative reasoning.",
    analysis: "Investigation, comparison, or structured reasoning over supplied material.",
    writing: "Prose composition, editing, or rewriting where code is not the product.",
    extraction: "Pulling structured fields, entities, or facts from supplied text.",
  }),
  difficulty: choice("How difficult is this task for a capable coding-agent model?", {
    easy: "Routine, short, and unambiguous.",
    moderate: "Needs care or multiple steps but is well specified.",
    hard: "Ambiguous, large, or easy to get wrong without substantial reasoning.",
  }),
  effort: choice(
    "What reasoning effort is appropriate? Do not choose none; thinking-off is decided later by policy.",
    {
      low: "Light reasoning is enough.",
      medium: "A moderate chain of thought is warranted.",
      high: "Careful multi-step reasoning is needed.",
      xhigh: "Very expensive reasoning is justified.",
    },
  ),
  trivialChat: noul(
    "Is this purely trivial social chat such as a greeting, with no request for information, analysis, code, or work?",
  ),
  localSufficiency: noul(
    "Would even the least capable of the listed local deployments be adequate to complete this task well?",
  ),
  freshFacts: noul(
    "Does answering correctly require missing fresh external facts that are not in the prompt or listed local context?",
  ),
  expectedLength: choice("What visible answer length is expected, excluding hidden reasoning?", {
    short: "A brief reply, roughly a few paragraphs or less.",
    medium: "A substantial reply on the order of a short document.",
    long: "A long reply such as a large implementation or report.",
  }),
};

export interface RouterClassifierService {
  readonly classify: (input: ClassifyInput) => Effect.Effect<ClassifiedAssessment, ClassifierError>;
}

export interface ClassifierLayerOptions {
  readonly mode: ClassifierMode;
  readonly layaUrl?: string | null;
  readonly layaModelRevision?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly jev?: TypeSafeClientService;
  readonly jevModel?: string;
  readonly jevApiKey?: string;
  readonly jevBaseUrl?: string;
  readonly cacheTtlMs?: number;
  readonly cacheMaxEntries?: number;
}

type CacheRecord = {
  readonly value: ClassifiedAssessment;
  readonly expiresAt: number;
};

const joinLaya = (base: string, path: string): string =>
  new URL(path, base.endsWith("/") ? base : `${base}/`).toString();

const digestState = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const cacheKey = (input: ClassifyInput, backend: ClassifierMode, modelRevision: string): string =>
  [
    input.keyId,
    backend,
    modelRevision,
    ASSESSMENT_QUESTION_SCHEMA_VERSION,
    digestState({
      state: input.state,
      localDeployments: input.localDeployments,
      source: input.source,
      meta: input.meta ?? null,
    }),
    input.catalogueVersion,
  ].join("\0");

const classifierState = (input: ClassifyInput) => ({
  brief: input.state,
  localDeployments: input.localDeployments,
  source: input.source,
  meta: input.meta ?? null,
});

const asChoice = (
  value: unknown,
  labels: readonly string[],
): Effect.Effect<
  { readonly choice: string; readonly confidence: number },
  ClassifierInvalidResponse
> => {
  if (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "choice" &&
    "choice" in value &&
    typeof value.choice === "string" &&
    labels.includes(value.choice) &&
    "confidence" in value &&
    typeof value.confidence === "number"
  ) {
    return Effect.succeed({ choice: value.choice, confidence: value.confidence });
  }
  return Effect.fail(new ClassifierInvalidResponse({ message: "Malformed choice answer" }));
};

const asNoul = (value: unknown): Effect.Effect<number, ClassifierInvalidResponse> => {
  if (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "noul" &&
    "noul" in value &&
    typeof value.noul === "number"
  ) {
    return Effect.succeed(value.noul);
  }
  return Effect.fail(new ClassifierInvalidResponse({ message: "Malformed noul answer" }));
};

const answersToAssessment = Effect.fn("answersToAssessment")(function* (
  answers: Record<string, unknown>,
): Effect.fn.Return<Assessment, ClassifierInvalidResponse> {
  const task = yield* asChoice(answers.task, [
    "chat",
    "coding",
    "math",
    "analysis",
    "writing",
    "extraction",
  ]);
  const difficulty = yield* asChoice(answers.difficulty, ["easy", "moderate", "hard"]);
  const effort = yield* asChoice(answers.effort, ["low", "medium", "high", "xhigh"]);
  const trivialChat = yield* asNoul(answers.trivialChat);
  const localSufficiency = yield* asNoul(answers.localSufficiency);
  const freshFacts = yield* asNoul(answers.freshFacts);
  const expectedLength = yield* asChoice(answers.expectedLength, ["short", "medium", "long"]);
  return yield* decodeAssessment({
    task: task.choice,
    difficulty: { value: difficulty.choice, confidence: difficulty.confidence },
    effort: { value: effort.choice, confidence: effort.confidence },
    trivialChat,
    localSufficiency,
    freshFacts,
    expectedLength: expectedLength.choice,
  }).pipe(
    Effect.mapError(
      () => new ClassifierInvalidResponse({ message: "Assessment failed runtime validation" }),
    ),
  );
});

const mapTimeout = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  timeoutMs: number,
): Effect.Effect<A, E | ClassifierTimeout, R> =>
  effect.pipe(
    Effect.timeout(Duration.millis(timeoutMs)),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(
        new ClassifierTimeout({
          message: "Classifier exceeded its time budget",
          timeoutMs,
        }),
      ),
    ),
  );

const jsonRequest = Effect.fn("jsonRequest")(function* (
  fetchImpl: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
): Effect.fn.Return<{ readonly status: number; readonly body: unknown }, ClassifierUnavailable> {
  return yield* Effect.tryPromise({
    try: async (signal) => {
      const response = await fetchImpl(url, { ...init, signal, redirect: "error" });
      const body: unknown = await response.json();
      return { status: response.status, body };
    },
    catch: () =>
      new ClassifierUnavailable({ message: "Classifier transport or JSON response failed" }),
  });
});

const contextFailure = (
  source: ClassifierSource,
  inputTokens: number | null,
  maxLen: number | null,
  headBudget: number | null,
): ClassifierError => {
  if (source === "full-input") {
    return new BriefRequired({
      message: "Classifier context exceeded; supply routing.taskBrief at a safe boundary",
      inputTokens,
      maxLen,
    });
  }
  return new ClassifierContextExceeded({
    message: "Classifier context exceeded and the supplied brief still does not fit",
    inputTokens,
    maxLen,
    headBudget,
  });
};

const parseContextError = (
  body: unknown,
): {
  readonly inputTokens: number | null;
  readonly maxLen: number | null;
  readonly headBudget: number | null;
} => {
  if (
    typeof body !== "object" ||
    body === null ||
    !("error" in body) ||
    typeof body.error !== "object" ||
    body.error === null
  ) {
    return { inputTokens: null, maxLen: null, headBudget: null };
  }
  const error = body.error as Record<string, unknown>;
  return {
    inputTokens: typeof error.input_tokens === "number" ? error.input_tokens : null,
    maxLen: typeof error.max_len === "number" ? error.max_len : null,
    headBudget: typeof error.head_budget === "number" ? error.head_budget : null,
  };
};

const readLayaHealth = Effect.fn("readLayaHealth")(function* (
  fetchImpl: typeof globalThis.fetch,
  layaUrl: string,
): Effect.fn.Return<LayaHealth, ClassifierError> {
  const healthResult = yield* jsonRequest(fetchImpl, joinLaya(layaUrl, "healthz"), {
    method: "GET",
    headers: { accept: "application/json" },
  });
  const health: LayaHealth = yield* decodeLayaHealth(healthResult.body).pipe(
    Effect.mapError(
      () => new ClassifierUnavailable({ message: "Laya healthz failed runtime validation" }),
    ),
  );
  if (healthResult.status !== 200 || !health.ok || !health.ready) {
    return yield* new ClassifierUnavailable({ message: "Laya classifier is not ready" });
  }
  return health;
});

const layaClassify = Effect.fn("layaClassify")(function* (
  fetchImpl: typeof globalThis.fetch,
  layaUrl: string,
  input: ClassifyInput,
  health: LayaHealth,
  expectedRevision?: string,
): Effect.fn.Return<
  Omit<ClassifiedAssessment, "elapsedMs" | "cacheHit" | "reuse">,
  ClassifierError
> {
  if (expectedRevision !== undefined && health.model_revision !== expectedRevision) {
    return yield* new ClassifierUnavailable({
      message: "Laya model revision differs from configured revision",
    });
  }
  const payload = {
    state: classifierState(input),
    questions: assessmentQuestions,
  };
  const budgetResult = yield* jsonRequest(fetchImpl, joinLaya(layaUrl, "v1/budget"), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(payload),
  });
  const budget: LayaBudget = yield* decodeLayaBudget(budgetResult.body).pipe(
    Effect.mapError(
      () => new ClassifierUnavailable({ message: "Laya budget failed runtime validation" }),
    ),
  );
  if (budgetResult.status !== 200 || !budget.fits) {
    return yield* contextFailure(
      input.source,
      budget.input_tokens,
      budget.max_len,
      budget.head_budget ?? null,
    );
  }

  const decideResult = yield* jsonRequest(fetchImpl, joinLaya(layaUrl, "v1/decide"), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(payload),
  });
  if (decideResult.status === 413) {
    const details = parseContextError(decideResult.body);
    return yield* contextFailure(
      input.source,
      details.inputTokens,
      details.maxLen,
      details.headBudget,
    );
  }
  if (decideResult.status === 400) {
    return yield* new ClassifierInvalidResponse({ message: "Laya decide rejected the result" });
  }
  if (decideResult.status !== 200) {
    return yield* new ClassifierUnavailable({ message: "Laya decide failed" });
  }
  const decoded = yield* decodeLayaResponse(decideResult.body).pipe(
    Effect.mapError(
      () => new ClassifierInvalidResponse({ message: "Laya decide failed runtime validation" }),
    ),
  );
  const assessment = yield* answersToAssessment(decoded.answers);
  return {
    assessment,
    backend: "laya",
    modelRevision: health.model_revision,
    usage: {
      input_tokens: decoded.usage.input_tokens,
      output_tokens: decoded.usage.output_tokens,
    },
    source: input.source,
  };
});

const utf8JsonBytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).length;

const jevBudgetFailure = (input: ClassifyInput): ClassifierError | null => {
  const stateBytes = utf8JsonBytes(classifierState(input));
  let questionsBytes = 0;
  let longestQuestionBytes = 0;
  for (const [name, question] of Object.entries(assessmentQuestions)) {
    const bytes = utf8JsonBytes({ [name]: question });
    questionsBytes += bytes;
    if (bytes > longestQuestionBytes) longestQuestionBytes = bytes;
  }
  const total = stateBytes + questionsBytes;
  if (
    stateBytes + longestQuestionBytes <= JEV_STATE_PLUS_LONGEST_QUESTION_LIMIT &&
    total <= JEV_TOTAL_TOKEN_LIMIT
  ) {
    return null;
  }
  return contextFailure(
    input.source,
    total,
    JEV_TOTAL_TOKEN_LIMIT,
    JEV_STATE_PLUS_LONGEST_QUESTION_LIMIT,
  );
};

const mapJevError = (error: unknown): ClassifierError => {
  if (typeof error !== "object" || error === null || !("_tag" in error)) {
    return new ClassifierUnavailable({ message: "Jev classification failed" });
  }
  const tag = error._tag;
  if (tag === "APITimeoutError") {
    const timeoutMs =
      "timeoutMs" in error && typeof error.timeoutMs === "number"
        ? error.timeoutMs
        : CLASSIFIER_ATTEMPT_TIMEOUT_MS;
    return new ClassifierTimeout({ message: "Jev classification timed out", timeoutMs });
  }
  if (tag === "ResponseValidationError") {
    return new ClassifierInvalidResponse({ message: "Jev response failed validation" });
  }
  if (
    tag === "InvalidRequestError" ||
    tag === "UnprocessableEntityError" ||
    tag === "BadRequestError"
  ) {
    const message = "message" in error && typeof error.message === "string" ? error.message : "";
    if (/token|context|size|too large|limit|budget/i.test(message)) {
      return new ClassifierContextExceeded({
        message: "Jev rejected the request as over documented context",
        inputTokens: null,
        maxLen: JEV_TOTAL_TOKEN_LIMIT,
        headBudget: JEV_STATE_PLUS_LONGEST_QUESTION_LIMIT,
      });
    }
    return new ClassifierInvalidResponse({ message: "Jev rejected the request" });
  }
  return new ClassifierUnavailable({ message: "Jev classification failed" });
};

const jevClassify = Effect.fn("jevClassify")(function* (
  client: TypeSafeClientService,
  input: ClassifyInput,
  model: string,
): Effect.fn.Return<
  Omit<ClassifiedAssessment, "elapsedMs" | "cacheHit" | "reuse">,
  ClassifierError
> {
  const oversize = jevBudgetFailure(input);
  if (oversize !== null) {
    return yield* oversize;
  }
  const result = yield* client
    .systemOne(
      {
        state: classifierState(input),
        questions: assessmentQuestions,
        model,
      },
      {
        timeout: CLASSIFIER_ATTEMPT_TIMEOUT_MS,
        retry: { maxRetries: CLASSIFIER_MAX_RETRIES, backoffInitialMs: 0, backoffMaxMs: 0 },
      },
    )
    .pipe(Effect.mapError(mapJevError));
  if (result.model !== model) {
    return yield* new ClassifierInvalidResponse({
      message: "Jev returned a different model revision",
    });
  }
  const assessment = yield* answersToAssessment(result.answers);
  return {
    assessment,
    backend: "jev",
    modelRevision: result.model,
    usage: {
      input_tokens: result.usage.input_tokens,
      output_tokens: result.usage.output_tokens,
    },
    source: input.source,
  };
});

export class RouterClassifier extends Context.Service<RouterClassifier, RouterClassifierService>()(
  "dymoo/llm-router/src/classifier/RouterClassifier",
) {
  static layer(
    options: ClassifierLayerOptions,
  ): Layer.Layer<RouterClassifier, ClassifierUnavailable> {
    const fetchImpl = options.fetch ?? globalThis.fetch;
    const cache = new Map<string, CacheRecord>();
    const ttl = options.cacheTtlMs ?? CLASSIFICATION_CACHE_TTL_MS;
    const maxEntries = options.cacheMaxEntries ?? CLASSIFICATION_CACHE_MAX_ENTRIES;
    let layaRevision = options.layaModelRevision ?? "unobserved";
    const make = (jevClient?: TypeSafeClientService) =>
      Effect.gen(function* () {
        const classify = Effect.fn("RouterClassifier.classify")(function* (
          input: ClassifyInput,
        ): Effect.fn.Return<ClassifiedAssessment, ClassifierError> {
          if (
            options.mode === "laya" &&
            (options.layaUrl === undefined || options.layaUrl === null || options.layaUrl === "")
          ) {
            return yield* new ClassifierUnavailable({ message: "LAYA_URL is not configured" });
          }
          if (options.mode === "jev" && jevClient === undefined) {
            return yield* new ClassifierUnavailable({ message: "Jev client is not configured" });
          }

          const started = yield* Clock.currentTimeMillis;
          const jevModel = options.jevModel ?? JEV_MODEL_ID;
          const modelRevision = options.mode === "laya" ? layaRevision : jevModel;
          const key = cacheKey(input, options.mode, modelRevision);
          const cached = cache.get(key);
          if (cached !== undefined && cached.expiresAt > started) {
            return {
              ...cached.value,
              elapsedMs: 0,
              usage: { input_tokens: 0, output_tokens: 0 },
              cacheHit: true,
              reuse: "exact-cache",
            };
          }

          return yield* mapTimeout(
            Effect.gen(function* () {
              const classified =
                options.mode === "laya"
                  ? yield* layaClassify(
                      fetchImpl,
                      options.layaUrl as string,
                      input,
                      yield* readLayaHealth(fetchImpl, options.layaUrl as string),
                      options.layaModelRevision,
                    )
                  : yield* jevClassify(jevClient as TypeSafeClientService, input, jevModel);
              if (options.mode === "laya" && classified.modelRevision !== null) {
                layaRevision = classified.modelRevision;
              }
              const finished = yield* Clock.currentTimeMillis;
              const complete: ClassifiedAssessment = {
                ...classified,
                elapsedMs: Math.max(0, finished - started),
                cacheHit: false,
                reuse: "classified",
              };
              if (cache.size >= maxEntries) {
                const oldest = cache.keys().next().value;
                if (oldest !== undefined) cache.delete(oldest);
              }
              cache.set(
                cacheKey(input, options.mode, options.mode === "laya" ? layaRevision : jevModel),
                { value: complete, expiresAt: finished + ttl },
              );
              return complete;
            }),
            CLASSIFIER_TOTAL_TIMEOUT_MS,
          );
        });

        return RouterClassifier.of({ classify });
      });

    if (options.mode === "jev" && options.jev === undefined) {
      return Layer.effect(RouterClassifier, Effect.flatMap(TypeSafeClient, make)).pipe(
        Layer.provide(
          TypeSafeClient.layerFetch({ apiKey: options.jevApiKey, baseURL: options.jevBaseUrl }),
        ),
        Layer.catch(() =>
          Layer.effect(
            RouterClassifier,
            Effect.fail(new ClassifierUnavailable({ message: "Jev configuration is invalid" })),
          ),
        ),
      );
    }
    return Layer.effect(RouterClassifier, make(options.jev));
  }
}

export const routerClassifierLayer = RouterClassifier.layer;
