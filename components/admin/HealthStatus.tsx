import type { HealthSnapshot } from "./types";

export function HealthStatus({ health }: { health: HealthSnapshot }) {
  const readyCount = health.deployments.filter((item) => item.ready).length;
  const total = health.deployments.length;

  return (
    <div className="health" aria-label="Readiness">
      <span className="pill" data-tone={health.ready ? "ok" : "warn"}>
        <span className="dot" aria-hidden="true" />
        {health.ready ? "Ready" : "Not ready"}
      </span>
      <span>
        {total === 0 ? "No deployments reported" : `${readyCount} of ${total} deployments ready`}
      </span>
    </div>
  );
}
