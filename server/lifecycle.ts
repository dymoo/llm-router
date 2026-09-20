import "server-only";
import { setTimeout as delay } from "node:timers/promises";
import { HttpFailure } from "../src/http/errors.ts";
import { stopHealth } from "./health.ts";
import { pendingAdmissions } from "./control.ts";
import { disposeGateway } from "./runtime.ts";
import { processState } from "./state.ts";

export function assertAcceptingWork(): void {
  if (processState.stopping) throw new HttpFailure(503, "unavailable", "Gateway is draining");
}

async function performDrain(): Promise<void> {
  processState.stopping = true;
  stopHealth();
  const deadline = Date.now() + 11 * 60_000;
  while (pendingAdmissions() > 0 && Date.now() < deadline) await delay(100);
  await disposeGateway();
}

export function drainGateway(): Promise<void> {
  return (processState.shutdown ??= performDrain());
}

export function registerShutdown(): void {
  if (processState.signalsRegistered) return;
  processState.signalsRegistered = true;
  const stop = () => {
    void drainGateway().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
