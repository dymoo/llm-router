import "server-only";
import type { ManagedRuntime } from "effect";
import type { Deployment } from "../src/domain.ts";
import type { AuxiliaryDeployment } from "../src/auxiliary.ts";
import type { ClassifierUnavailable, SchemaVersionMismatch } from "../src/errors.ts";
import type { HealthMonitor } from "../src/health.ts";
import type { FinalizeOutcome, QueueHooks } from "../src/http/contracts.ts";
import { createStatusStore, type RequestStatusStore } from "../src/http/status.ts";
import type { ApiKeys } from "../src/keys/api-keys.ts";
import type { KeyRepository, RepoError } from "../src/keys/repository.ts";
import type { Admission } from "../src/keys/types.ts";
import { createCapacityPool, type CapacityPool } from "../src/router/capacity.ts";
import type { ModelRouter } from "../src/router/model-router.ts";

export interface InferenceRuntime {
  runtime: ManagedRuntime.ManagedRuntime<ModelRouter, ClassifierUnavailable>;
  catalogue: readonly Deployment[];
}

interface ProcessState {
  control?: ManagedRuntime.ManagedRuntime<
    ApiKeys | KeyRepository,
    RepoError | SchemaVersionMismatch
  >;
  inference?: InferenceRuntime;
  leases: Map<string, Admission>;
  admissionsStarting: number;
  queueHooks: Map<string, QueueHooks>;
  observed: Map<string, Omit<FinalizeOutcome, "status">>;
  status: RequestStatusStore;
  auxiliary?: readonly AuxiliaryDeployment[];
  auxiliaryPool: CapacityPool;
  health?: HealthMonitor;
  stopping: boolean;
  shutdown?: Promise<void>;
  signalsRegistered: boolean;
}

declare global {
  var __dymooLlmRouterProcess: ProcessState | undefined;
}

// Next's instrumentation and route bundles can have separate module caches.
// Admission, permits, health and disposal must share process identity, not bundle identity.
// Restart the gateway after server code/configuration changes; don't hot-swap live ownership.
export const processState: ProcessState = (globalThis.__dymooLlmRouterProcess ??= {
  leases: new Map(),
  admissionsStarting: 0,
  queueHooks: new Map(),
  observed: new Map(),
  status: createStatusStore(),
  auxiliaryPool: createCapacityPool(),
  stopping: false,
  signalsRegistered: false,
});
