"use client";

import { useMemo, useState } from "react";
import { cachedInputRatio } from "./api";
import { Dialog } from "./Dialog";
import { formatCount, formatEpoch, formatRatio, formatUnknown, formatUsd } from "./format";
import type {
  BreakdownRow,
  CountRow,
  PublicKey,
  RequestPage,
  RoutingRow,
  TrendPoint,
  UsageQuery,
  UsageSnapshot,
} from "./types";

const PERIODS = [
  { id: "24h", label: "24 hours", ms: 24 * 60 * 60 * 1000 },
  { id: "7d", label: "7 days", ms: 7 * 24 * 60 * 60 * 1000 },
  { id: "30d", label: "30 days", ms: 30 * 24 * 60 * 60 * 1000 },
] as const;

export function UsageView({
  keys,
  query,
  usage,
  requests,
  loadingMore,
  onQuery,
  onLoadMore,
}: {
  keys: PublicKey[];
  query: UsageQuery;
  usage: UsageSnapshot;
  requests: RequestPage;
  loadingMore: boolean;
  onQuery: (query: UsageQuery) => void;
  onLoadMore: () => void;
}) {
  const [selected, setSelected] = useState<RoutingRow | null>(null);
  const rows = requests.available && requests.items.length > 0 ? requests.items : usage.recent;
  const ratio = cachedInputRatio(usage.aggregates);
  const activePeriod = PERIODS.find((period) => {
    if (query.since === null || query.until === null) {
      return false;
    }
    return Math.abs(query.until - query.since - period.ms) < 60_000;
  });
  const deployments = usage.breakdowns.byDeployment;
  const keyLabels = useMemo(() => new Map(keys.map((key) => [key.id, key.name])), [keys]);

  return (
    <section aria-labelledby="usage-heading">
      <h2 id="usage-heading" className="sr-only">
        Analytics
      </h2>
      <div className="toolbar">
        <fieldset className="fieldset-plain">
          <legend className="field-label">Period</legend>
          <div className="chips">
            {PERIODS.map((period) => (
              <button
                key={period.id}
                type="button"
                className="chip"
                aria-pressed={activePeriod?.id === period.id}
                onClick={() => {
                  const until = Date.now();
                  onQuery({ ...query, since: until - period.ms, until });
                }}
              >
                {period.label}
              </button>
            ))}
          </div>
        </fieldset>
        <label className="field">
          <span>Key</span>
          <select
            value={query.keyId ?? ""}
            onChange={(event) =>
              onQuery({
                ...query,
                keyId: event.target.value.length === 0 ? null : event.target.value,
              })
            }
          >
            <option value="">All keys</option>
            {keys.map((key) => (
              <option key={key.id} value={key.id}>
                {key.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Priority</span>
          <select
            value={query.priority ?? ""}
            onChange={(event) =>
              onQuery({
                ...query,
                priority:
                  event.target.value === "high" ||
                  event.target.value === "medium" ||
                  event.target.value === "low"
                    ? event.target.value
                    : null,
              })
            }
          >
            <option value="">All tiers</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </label>
        <label className="field">
          <span>Deployment</span>
          <select
            value={query.deploymentId ?? ""}
            onChange={(event) =>
              onQuery({
                ...query,
                deploymentId: event.target.value.length === 0 ? null : event.target.value,
              })
            }
          >
            <option value="">All deployments</option>
            {deployments.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {!usage.available ? (
        <p className="usage-note">
          Analytics are unavailable. Missing measurements stay unknown — they are not filled with
          demo data.
        </p>
      ) : (
        <>
          <p className="usage-note">
            HTTP success is not task success. Transcripts are not collected. Provider billed spend,
            token estimate, and local COGS are separate. A billed amount of $0 is not free compute
            and is not an OpenRouter charge. Local notional COGS can be above zero while billed API
            spend is zero. Unknown prices stay unknown.
          </p>
          <dl className="stats">
            <Stat label="Requests" value={formatCount(usage.aggregates.requestCount)} />
            <Stat
              label="HTTP errors"
              value={formatCount(usage.aggregates.errorCount)}
              hint={`Cancel ${formatUnknown(usage.aggregates.cancelCount)} · Saturation ${formatUnknown(usage.aggregates.saturationCount)}`}
            />
            <Stat
              label="Classifier"
              value={formatUnknown(usage.aggregates.classifierCalls)}
              hint={`Exact cache ${formatUnknown(usage.aggregates.exactCacheHits)} · Session reuse ${formatUnknown(usage.aggregates.sessionReuse)}`}
            />
            <Stat
              label="Cached input"
              value={formatRatio(ratio)}
              hint="Observed cached input / prompt tokens"
            />
            <Stat
              label="Local share"
              value={formatRatio(
                localShare(usage.aggregates.localRequests, usage.aggregates.cloudRequests),
              )}
              hint="Known locations only. Not a localityBias percentage."
            />
            <Stat
              label="Token estimate"
              value={formatUsd(usage.aggregates.estimatedUsd)}
              hint={`Unknown usage ${formatUnknown(usage.aggregates.unknownUsageCount)}`}
            />
            <Stat
              label="Provider reported"
              value={formatUsd(usage.aggregates.actualUsd)}
              hint="Billed API spend. $0 is a real price, not free electricity."
            />
            <Stat
              label="Local COGS"
              value={formatUsd(usage.aggregates.localComputeUsd)}
              hint="Notional cost from configured local token rates. Unknown if the rate or tokens are missing."
            />
            <Stat
              label="Queue wait · P50"
              value={formatUnknown(usage.aggregates.queueWaitMs, ms)}
              hint={`P95 ${formatUnknown(usage.aggregates.p95QueueWaitMs, ms)}`}
            />
            <Stat
              label="TTFT · P50"
              value={formatUnknown(usage.aggregates.ttftMs, ms)}
              hint={`P95 ${formatUnknown(usage.aggregates.p95TtftMs, ms)}`}
            />
            <Stat
              label="Generation · P50"
              value={formatUnknown(usage.aggregates.elapsedMs, ms)}
              hint={`P95 ${formatUnknown(usage.aggregates.p95ElapsedMs, ms)}`}
            />
            <Stat
              label="Cache savings estimate"
              value={formatUsd(usage.aggregates.cacheSavingsUsd)}
              hint="Observed cached tokens × configured rate difference; not affinity."
            />
            <Stat
              label="Classifier input"
              value={formatUnknown(usage.aggregates.classifierInputTokens)}
              hint={`Jev estimate ${formatUsd(usage.aggregates.classifierEstimatedUsd)}; exact-cache and session reuse make no new classifier call.`}
            />
            <Stat
              label="Decode TPS"
              value={formatUnknown(usage.aggregates.decodeTps, (value) => value.toFixed(1))}
            />
          </dl>
          <TrendChart points={usage.series} />
          <BreakdownTable
            title="By key"
            rows={usage.breakdowns.byKey.map((row) => ({
              ...row,
              label: keyLabels.get(row.id) ?? row.label,
            }))}
          />
          <BreakdownTable title="By priority" rows={usage.breakdowns.byPriority} />
          <BreakdownTable title="By deployment" rows={usage.breakdowns.byDeployment} />
          <CountTable
            title="Selection reasons"
            rows={usage.decisions}
            empty="No decision-reason aggregates for this window."
          />
          <CountTable
            title="Candidate exclusions"
            rows={usage.exclusions}
            empty="No exclusion aggregates for this window."
          />
          <CountTable
            title="Requested effort"
            rows={usage.effort}
            empty="No effort distribution for this window."
          />
          <CountTable
            title="Difficulty"
            rows={usage.complexity}
            empty="No difficulty distribution for this window."
          />
          <CountTable
            title="Task or modality"
            rows={usage.tasks}
            empty="No task distribution for this window."
          />
          <CountTable
            title="Errors"
            rows={usage.errors}
            empty="No recorded errors for this window."
          />
        </>
      )}
      <div className="panel">
        {rows.length === 0 ? (
          <div className="empty">
            <h2>No request metadata</h2>
            <p>Completed routes appear here without prompts, completions, or secrets.</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="keys">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Key</th>
                  <th>Deployment</th>
                  <th>HTTP outcome</th>
                  <th>Reason</th>
                  <th>Cache</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td className="muted">{formatEpoch(row.createdAt)}</td>
                    <td>
                      <button
                        className="btn btn-ghost btn-row"
                        type="button"
                        onClick={() => setSelected(row)}
                      >
                        {(row.keyName === null ? undefined : keyLabels.get(row.keyName)) ??
                          row.keyName ??
                          row.keyPrefix ??
                          row.id}
                      </button>
                    </td>
                    <td className="muted">{row.deploymentId ?? "—"}</td>
                    <td>{row.outcome}</td>
                    <td className="muted">{row.decisionReason ?? "—"}</td>
                    <td className="muted">
                      {row.cacheHit === null
                        ? "—"
                        : row.cacheHit
                          ? "Observed hit"
                          : "Observed miss"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {requests.nextCursor ? (
          <div className="more">
            <button
              className="btn btn-secondary"
              type="button"
              onClick={onLoadMore}
              disabled={loadingMore}
            >
              {loadingMore ? "Loading…" : "Load More Requests"}
            </button>
          </div>
        ) : null}
      </div>
      {selected ? (
        <Dialog
          open
          title="Request"
          description="Metadata only. Prompts, completions, and reasoning text are not stored here. Task success is not inferred from HTTP success."
          onClose={() => setSelected(null)}
          footer={
            <button className="btn btn-primary" type="button" onClick={() => setSelected(null)}>
              Close
            </button>
          }
        >
          <dl className="drill">
            <Item label="ID" value={selected.id} />
            <Item label="When" value={formatEpoch(selected.createdAt)} />
            <Item label="Key" value={selected.keyName ?? selected.keyPrefix ?? "—"} />
            <Item label="Priority" value={selected.priority ?? "—"} />
            <Item label="Deployment" value={selected.deploymentId ?? "—"} />
            <Item label="Location" value={selected.location ?? "—"} />
            <Item label="HTTP outcome" value={selected.outcome} />
            <Item label="Task success" value="—" />
            <Item label="Task" value={selected.task ?? "—"} />
            <Item label="Difficulty" value={selected.assessmentDifficulty ?? "—"} />
            <Item label="Effort" value={selected.appliedEffort ?? "—"} />
            <Item label="Decision" value={selected.decisionReason ?? "—"} />
            <Item
              label="Exclusions"
              value={
                selected.exclusionReasons.length > 0 ? selected.exclusionReasons.join(", ") : "—"
              }
            />
            <Item
              label="Policy version"
              value={selected.policyVersion === null ? "—" : String(selected.policyVersion)}
            />
            <Item label="Catalogue" value={selected.catalogueVersion ?? "—"} />
            <Item label="Classifier" value={selected.classificationBackend ?? "—"} />
            <Item label="Classifier source" value={selected.classificationSource ?? "—"} />
            <Item
              label="Exact cache"
              value={selected.cacheHit === null ? "—" : selected.cacheHit ? "Yes" : "No"}
            />
            <Item label="Queue wait" value={formatUnknown(selected.queueWaitMs, ms)} />
            <Item label="TTFT" value={formatUnknown(selected.ttftMs, ms)} />
            <Item
              label="Decode TPS"
              value={formatUnknown(selected.decodeTps, (value) => value.toFixed(1))}
            />
            <Item label="Token estimate" value={formatUsd(selected.estimatedUsd)} />
            <Item label="Provider billed" value={formatUsd(selected.actualUsd)} />
            <Item label="Local COGS" value={formatUsd(selected.localComputeUsd)} />
          </dl>
        </Dialog>
      ) : null}
    </section>
  );
}

function TrendChart({ points }: { points: TrendPoint[] }) {
  const chart = useMemo(() => {
    if (points.length === 0) {
      return null;
    }
    const values = points.map((point) => point.requests);
    const max = Math.max(...values, 1);
    const width = 640;
    const height = 120;
    const gap = 2;
    const barWidth = Math.max(2, (width - gap * (points.length - 1)) / points.length);
    return { max, width, height, gap, barWidth, values };
  }, [points]);

  if (!chart) {
    return <p className="usage-note">No trend series for this window.</p>;
  }

  return (
    <figure className="chart">
      <figcaption>Requests over time</figcaption>
      <svg
        role="img"
        aria-label="Requests over the selected window"
        viewBox={`0 0 ${chart.width} ${chart.height}`}
        className="chart-svg"
      >
        {points.map((point, index) => {
          const barHeight = (point.requests / chart.max) * chart.height;
          const x = index * (chart.barWidth + chart.gap);
          return (
            <rect
              key={point.t}
              x={x}
              y={chart.height - barHeight}
              width={chart.barWidth}
              height={barHeight}
              rx={1}
              className="chart-bar"
            >
              <title>
                {formatEpoch(point.t)} · {formatCount(point.requests)} requests
              </title>
            </rect>
          );
        })}
      </svg>
    </figure>
  );
}

function BreakdownTable({ title, rows }: { title: string; rows: BreakdownRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="panel">
        <div className="empty">
          <h2>{title}</h2>
          <p>No breakdown for this window.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="panel">
      <h3 className="panel-title">{title}</h3>
      <div className="table-wrap">
        <table className="keys">
          <thead>
            <tr>
              <th>{title}</th>
              <th>Requests</th>
              <th>Local / cloud</th>
              <th>Estimate</th>
              <th>Billed</th>
              <th>Local COGS</th>
              <th>Errors</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td className="name">{row.label}</td>
                <td className="muted">{formatCount(row.requests)}</td>
                <td className="muted">
                  {formatUnknown(row.local)} / {formatUnknown(row.cloud)}
                </td>
                <td className="muted">{formatUsd(row.estimatedUsd)}</td>
                <td className="muted">{formatUsd(row.actualUsd)}</td>
                <td className="muted">{formatUsd(row.localComputeUsd)}</td>
                <td className="muted">
                  {formatUnknown(row.errors)} · cancel {formatUnknown(row.cancels)} · sat{" "}
                  {formatUnknown(row.saturation)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CountTable({ title, rows, empty }: { title: string; rows: CountRow[]; empty: string }) {
  if (rows.length === 0) {
    return (
      <div className="panel">
        <div className="empty">
          <h2>{title}</h2>
          <p>{empty}</p>
        </div>
      </div>
    );
  }
  return (
    <div className="panel">
      <h3 className="panel-title">{title}</h3>
      <div className="table-wrap">
        <table className="keys">
          <thead>
            <tr>
              <th>Reason</th>
              <th>Count</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{row.label}</td>
                <td className="muted">{formatCount(row.count)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="stat">
      <dt>{label}</dt>
      <dd>{value}</dd>
      {hint ? <p className="sub">{hint}</p> : null}
    </div>
  );
}

function Item({ label, value }: { label: string; value: string }) {
  return (
    <div className="drill-row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function localShare(localRequests: number | null, cloudRequests: number | null): number | null {
  if (localRequests === null || cloudRequests === null) {
    return null;
  }
  const total = localRequests + cloudRequests;
  if (total <= 0) {
    return null;
  }
  return localRequests / total;
}

function ms(value: number): string {
  return `${Math.round(value)}ms`;
}
