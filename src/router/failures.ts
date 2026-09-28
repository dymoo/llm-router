import { Data } from "effect";

export class QueueFull extends Data.TaggedError("QueueFull")<{
  readonly waiting: number;
  readonly limit: number;
}> {}
