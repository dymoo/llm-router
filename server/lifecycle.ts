import "server-only";
import { setTimeout as delay } from "node:timers/promises";
import { HttpFailure } from "../src/http/errors.ts";
import { stopHealth } from "./health.ts";
import { pendingAdmissions } from "./control.ts";
import { drainBatch, startBatch } from "./batch.ts";
import { disposeGateway } from "./runtime.ts";
import { processState } from "./state.ts";

export function assertAcceptingWork(): void {
  if (processState.stopping) throw new HttpFailure(503, "unavailable", "Gateway is draining");
}

async function performDrain(): Promise<void> {
  processState.stopping = true;
  stopHealth();
  // Batch drains its in-flight LOCAL items. Remote polling tasks are aborted and settled
  // before database disposal; unfinished durable intents resume at the next boot.
  await drainBatch();
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
  // Process boot hook (instrumentation calls registerShutdown): the deferred-lane
  // scheduler recovers here — not on the first batch HTTP request.
  startBatch();
  const stop = () => {
    void drainGateway().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
