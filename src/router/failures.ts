export {
  BoundaryRequired,
  Cancelled,
  CapacityBusy,
  ClassifierUnavailable,
  EmptyAllowlist,
  ImpossibleLimits,
  MissingSession,
  NoEligibleModel,
  ProviderFailure,
  RequestTimeout,
  RetrievalRequired,
  UnsupportedCapabilities,
} from "../errors.ts";

import { Data } from "effect";

export class QueueFull extends Data.TaggedError("QueueFull")<{
  readonly waiting: number;
  readonly limit: number;
}> {}

export class LockTimeout extends Data.TaggedError("LockTimeout")<{
  readonly sessionId: string;
}> {}
