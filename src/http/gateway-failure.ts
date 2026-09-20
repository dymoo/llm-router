import type { FinalizeOutcome } from "../keys/types.ts";

/** Internal metadata only. Public errors still come from the original typed cause. */
export class GatewayFailure extends Error {
  constructor(
    cause: unknown,
    readonly metadata: Omit<FinalizeOutcome, "status">,
  ) {
    super("Inference failed", { cause });
  }
}
