import { RULES_CLASSIFIER, type DeploymentHealth, type HealthSnapshot } from "./http/contracts.ts";

export type HealthProbes = {
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
          classifier: RULES_CLASSIFIER,
          deployments: [],
        };
      if (cached !== undefined && now() < expiresAt) return cached;
      if (inFlight !== undefined) return inFlight;
      inFlight = Promise.all([
        probes.deployments().catch(() => []),
        probes.persistence().catch(() => false),
      ])
        .then(([deployments, persistence]) => {
          const snapshot: HealthSnapshot = {
            ready:
              !stopping && persistence && deployments.some((item) => !item.optional && item.ready),
            stopping,
            persistence,
            checkedAt: now(),
            classifier: RULES_CLASSIFIER,
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
