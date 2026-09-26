import type { HealthSnapshot } from "./types";

export function HealthStatus({ health }: { health: HealthSnapshot }) {
  const readyCount = health.deployments.filter((item) => item.ready).length;
  const total = health.deployments.length;
  const rules = health.classifier.backend === "rules";
  const classifierTone = health.classifier.ready ? "ok" : "warn";
  const readyTone = health.ready ? "ok" : "warn";

  return (
    <div className="health" aria-label="Readiness">
      <span className="pill" data-tone={readyTone}>
        <span className="dot" aria-hidden="true" />
        {health.ready ? "Ready" : "Not ready"}
      </span>
      <span>
        {rules ? (
          <>
            Routing mode <strong>Rules</strong>
          </>
        ) : (
          <>
            Classifier <strong>{health.classifier.backend}</strong>
          </>
        )}
        {health.classifier.ready
          ? ""
          : health.classifier.evidence === "unqualified"
            ? " unqualified"
            : " unavailable"}
      </span>
      <span className="pill" data-tone={classifierTone}>
        {rules ? "Deterministic" : health.classifier.local ? "Local" : "Remote"}
      </span>
      <span>
        {total === 0 ? "No deployments reported" : `${readyCount} of ${total} deployments ready`}
      </span>
      {!rules && health.classifier.evidence === "unqualified" ? (
        <p className="health-note">
          No qualifying calibration record; assessment use fails closed.
        </p>
      ) : !rules && !health.classifier.local ? (
        <p className="health-note">
          {health.classifier.evidence === "configuration-only"
            ? "Jev is configured; health checks do not make paid classification calls."
            : "Task assessments use the configured remote classifier."}
        </p>
      ) : null}
    </div>
  );
}
