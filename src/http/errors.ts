export type HttpErrorCode =
  | "invalid"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "stale_version"
  | "rate_limited"
  | "unavailable"
  | "classifier_unavailable"
  | "classifier_context_exceeded"
  | "classifier_unqualified"
  | "no_eligible_model"
  | "busy"
  | "local_overloaded"
  | "resource_unavailable"
  | "provider_failure"
  | "timeout"
  | "cancelled"
  | "boundary_required"
  | "missing_session"
  | "retrieval_required"
  | "brief_required"
  | "unknown";

export type HttpErrorBody = {
  error: {
    code: HttpErrorCode;
    message: string;
  };
};

export class HttpFailure extends Error {
  readonly status: number;
  readonly code: HttpErrorCode;
  readonly retryAfterSeconds: number | null;

  constructor(
    status: number,
    code: HttpErrorCode,
    message: string,
    retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "HttpFailure";
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class InvalidInput extends HttpFailure {
  constructor(message: string) {
    super(400, "invalid", message);
    this.name = "InvalidInput";
  }
}

const TAG_MAP: Record<string, { status: number; code: HttpErrorCode; message: string }> = {
  InvalidInput: { status: 400, code: "invalid", message: "invalid request" },
  AuthFailed: { status: 401, code: "unauthorized", message: "authentication failed" },
  KeyRevoked: { status: 401, code: "unauthorized", message: "key revoked" },
  KeyExpired: { status: 401, code: "unauthorized", message: "key expired" },
  EmptyAllowlist: { status: 403, code: "forbidden", message: "no deployments are allowed" },
  KeyNotFound: { status: 404, code: "not_found", message: "key not found" },
  Conflict: { status: 409, code: "conflict", message: "conflict" },
  StaleVersion: { status: 409, code: "stale_version", message: "resource version conflict" },
  BoundaryRequired: {
    status: 409,
    code: "boundary_required",
    message: "a safe session boundary is required",
  },
  MissingSession: {
    status: 409,
    code: "missing_session",
    message: "session pin is missing or expired",
  },
  RateLimited: { status: 429, code: "rate_limited", message: "rate limit exceeded" },
  ConcurrentLimit: { status: 429, code: "rate_limited", message: "concurrency limit exceeded" },
  ImpossibleLimits: { status: 422, code: "invalid", message: "request exceeds configured limits" },
  UnsupportedCapabilities: {
    status: 422,
    code: "invalid",
    message: "requested capabilities are unsupported",
  },
  NoEligibleModel: { status: 422, code: "no_eligible_model", message: "no eligible deployment" },
  RetrievalRequired: {
    status: 422,
    code: "retrieval_required",
    message: "trusted retrieval evidence is required",
  },
  ClassifierContextExceeded: {
    status: 422,
    code: "classifier_context_exceeded",
    message: "classifier context exceeded; supply routing.taskBrief",
  },
  BriefRequired: {
    status: 422,
    code: "brief_required",
    message: "routing.taskBrief is required for this request",
  },
  ClassifierInputTooLarge: {
    status: 422,
    code: "classifier_context_exceeded",
    message: "classifier input is too large",
  },
  DatabaseError: { status: 500, code: "unavailable", message: "persistence unavailable" },
  PepperMismatch: { status: 500, code: "unavailable", message: "control plane unavailable" },
  SchemaVersionMismatch: { status: 500, code: "unavailable", message: "control plane unavailable" },
  ClassifierUnavailable: {
    status: 503,
    code: "classifier_unavailable",
    message: "classifier unavailable",
  },
  ClassifierUnqualified: {
    status: 503,
    code: "classifier_unqualified",
    message: "classifier is not qualified for production routing",
  },
  ClassifierInvalidResponse: {
    status: 503,
    code: "classifier_unavailable",
    message: "classifier unavailable",
  },
  LocalOverloaded: {
    status: 503,
    code: "local_overloaded",
    message: "local deployment overloaded",
  },
  CapacityBusy: { status: 503, code: "busy", message: "deployment capacity is busy" },
  QueueFull: { status: 503, code: "busy", message: "inference queue is full" },
  LockTimeout: { status: 503, code: "busy", message: "session already has in-flight work" },
  CatalogueInvalid: {
    status: 503,
    code: "unavailable",
    message: "deployment catalogue is not configured for inference",
  },
  ProviderFailure: { status: 502, code: "provider_failure", message: "upstream provider failed" },
  ClassifierTimeout: { status: 504, code: "timeout", message: "classifier timed out" },
  RequestTimeout: { status: 504, code: "timeout", message: "request timed out" },
  TimeoutError: { status: 504, code: "timeout", message: "request timed out" },
  Cancelled: { status: 499, code: "cancelled", message: "request cancelled" },
};

const SECRET_PATTERNS = [
  /jrv_[0-9a-f]{24}\.[A-Za-z0-9_-]{43}/g,
  /Bearer\s+\S+/gi,
  /pepper/gi,
  /digest/gi,
];

function sanitizeMessage(message: string): string {
  let next = message;
  for (const pattern of SECRET_PATTERNS) {
    next = next.replace(pattern, "[redacted]");
  }
  return next;
}

function tagOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  if ("_tag" in error && typeof error._tag === "string") {
    return error._tag;
  }
  if ("cause" in error) {
    const nested = tagOf(error.cause);
    if (nested !== undefined) {
      return nested;
    }
  }
  if ("error" in error) {
    const nested = tagOf(error.error);
    if (nested !== undefined) {
      return nested;
    }
  }
  if (error instanceof Error) {
    return error.name;
  }
  return undefined;
}

function messageOf(error: unknown, fallback: string): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message: unknown }).message;
    if (typeof message === "string" && message.length > 0) {
      return sanitizeMessage(message);
    }
  }
  return fallback;
}

function retryAfterOf(error: unknown): number {
  if (typeof error !== "object" || error === null) return 1;
  if ("_tag" in error && error._tag === "LocalOverloaded") {
    const value = "retryAfterSeconds" in error ? error.retryAfterSeconds : null;
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 1;
  }
  return "cause" in error ? retryAfterOf(error.cause) : 1;
}

/**
 * A `service_tier: "flex"` request refused for lack of local capacity, in
 * OpenAI Flex's shape: HTTP 429 `resource_unavailable`. Other failures pass through.
 */
export function flexFailure(error: unknown): unknown {
  const failure = toHttpFailure(error);
  return failure.code === "local_overloaded" || failure.code === "busy"
    ? new HttpFailure(
        429,
        "resource_unavailable",
        "no spare local capacity for a flex request",
        failure.retryAfterSeconds ?? 1,
      )
    : error;
}

export function toHttpFailure(error: unknown): HttpFailure {
  if (error instanceof HttpFailure) {
    return error;
  }
  const tag = tagOf(error);
  if (tag !== undefined && tag in TAG_MAP) {
    const mapped = TAG_MAP[tag]!;
    const message = tag === "InvalidInput" ? messageOf(error, mapped.message) : mapped.message;
    return new HttpFailure(
      mapped.status,
      mapped.code,
      message,
      mapped.code === "local_overloaded" ? retryAfterOf(error) : null,
    );
  }
  return new HttpFailure(500, "unknown", "internal error");
}

export function errorBody(error: HttpFailure): HttpErrorBody {
  return {
    error: {
      code: error.code,
      message: error.message,
    },
  };
}

export function noStoreHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  headers.set("cache-control", "no-store");
  headers.set("pragma", "no-cache");
  headers.set("x-content-type-options", "nosniff");
  return headers;
}

export function jsonResponse(status: number, body: unknown, extra?: HeadersInit): Response {
  const headers = noStoreHeaders(extra);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { status, headers });
}

export function emptyResponse(status: number, extra?: HeadersInit): Response {
  return new Response(null, { status, headers: noStoreHeaders(extra) });
}

export function failureResponse(error: unknown): Response {
  const failure = toHttpFailure(error);
  const status = failure.status === 499 ? 400 : failure.status;
  return jsonResponse(
    status,
    errorBody(failure),
    failure.code === "local_overloaded" || failure.code === "resource_unavailable"
      ? { "retry-after": String(failure.retryAfterSeconds ?? 1) }
      : undefined,
  );
}
