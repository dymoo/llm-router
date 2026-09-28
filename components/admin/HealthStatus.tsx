import type { HealthSnapshot } from "./types";

export function HealthStatus({ health }: { health: HealthSnapshot }) {
  const readyCount = health.deployments.filter((item) => item.ready).length;
  const total = health.deployments.length;

  return (
    <p className="type-footnote flex flex-wrap items-center gap-x-2 gap-y-1 text-label-2">
      <span className="relative flex size-2" aria-hidden="true">
        {health.ready ? (
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-60 motion-reduce:animate-none" />
        ) : null}
        <span
          className={`relative inline-flex size-2 rounded-full ${health.ready ? "bg-primary" : "bg-negative"}`}
        />
      </span>
      <span className="text-xs font-semibold tracking-[0.12em] text-label uppercase">
        {health.ready ? "Ready" : "Not ready"}
      </span>
      <span>
        {total === 0 ? "No deployments reported" : `${readyCount} of ${total} deployments ready`}
      </span>
    </p>
  );
}
