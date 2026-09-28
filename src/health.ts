import type { ClassifierHealth } from "./classifier.ts";
import type { DeploymentHealth, HealthSnapshot } from "./http/contracts.ts";

export type HealthProbes = {
  classifier: () => Promise<ClassifierHealth>;
  deployments: () => Promise<DeploymentHealth[]>;
  persistence: () => Promise<boolean>;
  now?: () => number;
  ttlMs?: number;
};

export interface HealthMonitor {
  stop(): void;
  snapshot(): Promise<HealthSnapshot>;
}

/** Concurrent callers share one bounded probe round; stale successes never survive a failed round. */
export function createHealthMonitor(probes: HealthProbes): HealthMonitor {
  const now = probes.now ?? Date.now;
  let cached: HealthSnapshot | undefined;
  let expiresAt = 0;
  let inFlight: Promise<HealthSnapshot> | undefined;
  let stopping = false;
  return {
    stop() {
      stopping = true;
      cached = undefined;
    },
    async snapshot(): Promise<HealthSnapshot> {
      if (stopping)
        return {
          ready: false,
          stopping: true,
          persistence: false,
          checkedAt: now(),
          classifier: { ready: false, backend: "stopped", local: false },
          deployments: [],
        };
      if (cached !== undefined && now() < expiresAt) return cached;
      if (inFlight !== undefined) return inFlight;
      inFlight = Promise.all([
        probes.classifier().catch(() => ({ ready: false, backend: "unknown", local: false })),
        probes.deployments().catch(() => []),
        probes.persistence().catch(() => false),
      ])
        .then(([classifier, deployments, persistence]) => {
          const snapshot: HealthSnapshot = {
            ready:
              !stopping &&
              persistence &&
              classifier.ready &&
              deployments.some((item) => !item.optional && item.ready),
            stopping,
            persistence,
            checkedAt: now(),
            classifier,
            deployments,
          };
          cached = snapshot;
          expiresAt = now() + (probes.ttlMs ?? 5_000);
          return snapshot;
        })
        .finally(() => {
          inFlight = undefined;
        });
      return inFlight;
    },
  };
}
