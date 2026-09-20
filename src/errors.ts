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

export class EmptyAllowlist extends Schema.TaggedError<EmptyAllowlist>()(
  "EmptyAllowlist",
  Message,
) {}

export class ImpossibleLimits extends Schema.TaggedError<ImpossibleLimits>()(
  "ImpossibleLimits",
  Message,
) {}

export class UnsupportedCapabilities extends Schema.TaggedError<UnsupportedCapabilities>()(
  "UnsupportedCapabilities",
  Message,
) {}

export class NoEligibleModel extends Schema.TaggedError<NoEligibleModel>()(
  "NoEligibleModel",
  Message,
) {}

export class ClassifierUnavailable extends Schema.TaggedError<ClassifierUnavailable>()(
  "ClassifierUnavailable",
  Message,
) {}

export class ClassifierTimeout extends Schema.TaggedError<ClassifierTimeout>()(
  "ClassifierTimeout",
  {
    message: Schema.String,
    timeoutMs: Schema.Finite,
  },
) {}

export class ClassifierInvalidResponse extends Schema.TaggedError<ClassifierInvalidResponse>()(
  "ClassifierInvalidResponse",
  Message,
) {}

export class ClassifierInputTooLarge extends Schema.TaggedError<ClassifierInputTooLarge>()(
  "ClassifierInputTooLarge",
  {
    message: Schema.String,
    maxChars: Schema.Int,
    actualChars: Schema.Int,
  },
) {}

export class ClassifierContextExceeded extends Schema.TaggedError<ClassifierContextExceeded>()(
  "ClassifierContextExceeded",
  {
    message: Schema.String,
    inputTokens: Schema.NullOr(Schema.Int),
    maxLen: Schema.NullOr(Schema.Int),
    headBudget: Schema.NullOr(Schema.Int),
  },
) {}

export class BriefRequired extends Schema.TaggedError<BriefRequired>()("BriefRequired", {
  message: Schema.String,
  inputTokens: Schema.NullOr(Schema.Int),
  maxLen: Schema.NullOr(Schema.Int),
}) {}

export class RetrievalRequired extends Schema.TaggedError<RetrievalRequired>()(
  "RetrievalRequired",
  Message,
) {}

export class CatalogueInvalid extends Schema.TaggedError<CatalogueInvalid>()(
  "CatalogueInvalid",
  Message,
) {}

export class BoundaryRequired extends Schema.TaggedError<BoundaryRequired>()(
  "BoundaryRequired",
  Message,
) {}

export class MissingSession extends Schema.TaggedError<MissingSession>()(
  "MissingSession",
  Message,
) {}

export class CapacityBusy extends Schema.TaggedError<CapacityBusy>()("CapacityBusy", Message) {}

export class ProviderFailure extends Schema.TaggedError<ProviderFailure>()(
  "ProviderFailure",
  Message,
) {}

export class RequestTimeout extends Schema.TaggedError<RequestTimeout>()(
  "RequestTimeout",
  Message,
) {}

export class Cancelled extends Schema.TaggedError<Cancelled>()("Cancelled", Message) {}

export type FeasibilityError =
  | EmptyAllowlist
  | ImpossibleLimits
  | UnsupportedCapabilities
  | NoEligibleModel
  | CatalogueInvalid;

export type ClassifierError =
  | ClassifierUnavailable
  | ClassifierTimeout
  | ClassifierInvalidResponse
  | ClassifierInputTooLarge
  | ClassifierContextExceeded
  | BriefRequired;

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
  | FeasibilityError
  | ClassifierError
  | KeyLifecycleError
  | RetrievalRequired
  | BoundaryRequired
  | MissingSession
  | CapacityBusy
  | ProviderFailure
  | RequestTimeout
  | Cancelled;
