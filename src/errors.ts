import { Schema } from "effect";

const Message = { message: Schema.String } as const;

export class InvalidInput extends Schema.TaggedError<InvalidInput>()("InvalidInput", Message) {}

export class DatabaseError extends Schema.TaggedError<DatabaseError>()("DatabaseError", Message) {}

export class KeyNotFound extends Schema.TaggedError<KeyNotFound>()("KeyNotFound", Message) {}

export class StaleVersion extends Schema.TaggedError<StaleVersion>()("StaleVersion", Message) {}

export class Conflict extends Schema.TaggedError<Conflict>()("Conflict", Message) {}

export class AuthFailed extends Schema.TaggedError<AuthFailed>()("AuthFailed", Message) {}

export class RateLimited extends Schema.TaggedError<RateLimited>()("RateLimited", Message) {}

export class ConcurrentLimit extends Schema.TaggedError<ConcurrentLimit>()(
  "ConcurrentLimit",
  Message,
) {}

export class KeyRevoked extends Schema.TaggedError<KeyRevoked>()("KeyRevoked", Message) {}

export class KeyExpired extends Schema.TaggedError<KeyExpired>()("KeyExpired", Message) {}

export class PepperMismatch extends Schema.TaggedError<PepperMismatch>()(
  "PepperMismatch",
  Message,
) {}

export class SchemaVersionMismatch extends Schema.TaggedError<SchemaVersionMismatch>()(
  "SchemaVersionMismatch",
  Message,
) {}

export class NoEligibleModel extends Schema.TaggedError<NoEligibleModel>()(
  "NoEligibleModel",
  Message,
) {}

/** A pinned `model` the key's policy may not use (cloud for a cloud-off or low key). */
export class ModelNotAllowed extends Schema.TaggedError<ModelNotAllowed>()(
  "ModelNotAllowed",
  Message,
) {}

export class CatalogueInvalid extends Schema.TaggedError<CatalogueInvalid>()(
  "CatalogueInvalid",
  Message,
) {}

export class CapacityBusy extends Schema.TaggedError<CapacityBusy>()("CapacityBusy", Message) {}

export class ProviderFailure extends Schema.TaggedError<ProviderFailure>()(
  "ProviderFailure",
  Message,
) {}

export class LocalOverloaded extends Schema.TaggedError<LocalOverloaded>()("LocalOverloaded", {
  message: Schema.String,
  retryAfterSeconds: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  /** No spare capacity for a `service_tier: "flex"` request: Gufo refused it, or
   * the router's flex wait ran out. HTTP maps it to 429 `resource_unavailable`. */
  flexRefused: Schema.optional(Schema.Boolean),
}) {}

export class RequestTimeout extends Schema.TaggedError<RequestTimeout>()(
  "RequestTimeout",
  Message,
) {}

export class Cancelled extends Schema.TaggedError<Cancelled>()("Cancelled", Message) {}

export type KeyLifecycleError =
  | DatabaseError
  | KeyNotFound
  | StaleVersion
  | Conflict
  | AuthFailed
  | RateLimited
  | ConcurrentLimit
  | KeyRevoked
  | KeyExpired
  | PepperMismatch
  | SchemaVersionMismatch;

export type DomainError =
  | InvalidInput
  | NoEligibleModel
  | ModelNotAllowed
  | CatalogueInvalid
  | KeyLifecycleError
  | CapacityBusy
  | ProviderFailure
  | LocalOverloaded
  | RequestTimeout
  | Cancelled;
