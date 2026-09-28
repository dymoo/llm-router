"use client";

import { ChevronRightIcon } from "lucide-react";
import { useId, useMemo, useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cachedInputRatio } from "./api";
import { AdminSheet } from "./AdminSheet";
import { Companion } from "./Companion";
import { formatCount, formatEpoch, formatRatio, formatUnknown, formatUsd } from "./format";
import type {
  BreakdownRow,
  CountRow,
  Priority,
  PublicKey,
  RequestPage,
  RoutingRow,
  TrendPoint,
  UsageQuery,
  UsageSnapshot,
} from "./types";

const PERIODS = [
  { id: "24h", label: "24 Hours", ms: 24 * 60 * 60 * 1000 },
  { id: "7d", label: "7 Days", ms: 7 * 24 * 60 * 60 * 1000 },
  { id: "30d", label: "30 Days", ms: 30 * 24 * 60 * 60 * 1000 },
] as const;

const PRIORITY_ITEMS: { value: Priority | null; label: string }[] = [
  { value: null, label: "All priorities" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
];

const listCard = "gap-0 rounded-[20px] bg-surface py-0 ring-0";

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
  const keyLabels = useMemo(() => new Map(keys.map((key) => [key.id, key.name])), [keys]);
  const periodId = useId();
  const a = usage.aggregates;

  return (
    <div className="space-y-8">
      <div className="space-y-4">
        <div>
          <p id={periodId} className="type-footnote font-semibold text-label-2">
            Period
          </p>
          <ToggleGroup
            aria-labelledby={periodId}
            className="mt-2 grid w-full grid-cols-3 gap-1 rounded-full bg-fill p-1 sm:w-fit sm:min-w-96"
            value={activePeriod ? [activePeriod.id] : []}
            onValueChange={(value: string[]) => {
              const period = PERIODS.find((item) => item.id === value[0]);
              if (!period) return;
              const until = Date.now();
              onQuery({ ...query, since: until - period.ms, until });
            }}
          >
            {PERIODS.map((period) => (
              <ToggleGroupItem
                key={period.id}
                value={period.id}
                className="type-subhead h-11 rounded-full px-4 font-semibold text-label-2 hover:bg-transparent hover:text-label aria-pressed:bg-raised aria-pressed:text-label aria-pressed:shadow-sm"
              >
                {period.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <FilterSelect
            label="Key"
            value={query.keyId}
            items={[
              { value: null, label: "All keys" },
              ...keys.map((key) => ({ value: key.id, label: key.name })),
            ]}
            onChange={(keyId) => onQuery({ ...query, keyId })}
          />
          <FilterSelect
            label="Priority"
            value={query.priority}
            items={PRIORITY_ITEMS}
            onChange={(priority) => onQuery({ ...query, priority })}
          />
          <FilterSelect
            label="Deployment"
            value={query.deploymentId}
            items={[
              { value: null, label: "All deployments" },
              ...usage.breakdowns.byDeployment.map((item) => ({
                value: item.id,
                label: item.label,
              })),
            ]}
            onChange={(deploymentId) => onQuery({ ...query, deploymentId })}
          />
        </div>
      </div>

      {!usage.available ? (
        <Card className={`${listCard} items-center px-6 py-10 text-center`}>
          <Companion mood="sad" size={56} />
          <p className="type-headline mt-3">Analytics are unavailable</p>
          <p className="type-footnote mt-1 max-w-sm text-label-2">
            Missing measurements stay unknown. They’re never filled with demo data.
          </p>
        </Card>
      ) : (
        <>
          <div className="space-y-3">
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              <Stat label="Requests" value={formatCount(a.requestCount)} />
              <Stat
                label="HTTP errors"
                value={formatCount(a.errorCount)}
                hint={`Cancelled ${formatUnknown(a.cancelCount)} · Saturated ${formatUnknown(a.saturationCount)}`}
              />
              <Stat
                label="Cached input"
                value={formatRatio(ratio)}
                hint="Observed cached input / prompt tokens"
              />
              <Stat
                label="Local share"
                value={formatRatio(localShare(a.localRequests, a.cloudRequests))}
                hint="Known locations only."
              />
              <Stat
                label="Token estimate"
                value={formatUsd(a.estimatedUsd)}
                hint={`Unknown usage ${formatUnknown(a.unknownUsageCount)}`}
              />
              <Stat
                label="Provider reported"
                value={formatUsd(a.actualUsd)}
                hint="Billed API spend. $0 is a real price, not free electricity."
              />
              <Stat
                label="Local COGS"
                value={formatUsd(a.localComputeUsd)}
                hint="Notional cost from configured local token rates."
              />
              <Stat
                label="Queue wait · P50"
                value={formatUnknown(a.queueWaitMs, ms)}
                hint={`P95 ${formatUnknown(a.p95QueueWaitMs, ms)}`}
              />
              <Stat
                label="TTFT · P50"
                value={formatUnknown(a.ttftMs, ms)}
                hint={`P95 ${formatUnknown(a.p95TtftMs, ms)}`}
              />
              <Stat
                label="Generation · P50"
                value={formatUnknown(a.elapsedMs, ms)}
                hint={`P95 ${formatUnknown(a.p95ElapsedMs, ms)}`}
              />
              <Stat
                label="Cache savings"
                value={formatUsd(a.cacheSavingsUsd)}
                hint="Observed cached tokens × configured rate difference."
              />
              <Stat
                label="Decode TPS"
                value={formatUnknown(a.decodeTps, (value) => value.toFixed(1))}
              />
            </dl>
            <p className="type-footnote max-w-2xl text-label-2">
              HTTP success isn’t task success, and transcripts aren’t collected. Provider billed
              spend, token estimate and local COGS are separate: $0 billed isn’t free compute, local
              COGS can be above zero while billed spend is zero, and unknown prices stay unknown.
            </p>
          </div>
          <TrendChart points={usage.series} />
          <BreakdownSection
            title="By key"
            rows={usage.breakdowns.byKey.map((row) => ({
              ...row,
              label: keyLabels.get(row.id) ?? row.label,
            }))}
          />
          <BreakdownSection title="By priority" rows={usage.breakdowns.byPriority} />
          <BreakdownSection title="By deployment" rows={usage.breakdowns.byDeployment} />
          <CountSection title="Errors" rows={usage.errors} empty="No recorded errors." />
        </>
      )}

      <Section title="Requests">
        {rows.length === 0 ? (
          <Card className={`${listCard} items-center px-6 py-10 text-center`}>
            <Companion size={56} />
            <p className="type-headline mt-3">No requests yet</p>
            <p className="type-footnote mt-1 max-w-sm text-label-2">
              Completed requests appear here, without prompts, completions or secrets.
            </p>
          </Card>
        ) : (
          <Card className={listCard}>
            <ul>
              {rows.map((row, index) => (
                <li key={row.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(row)}
                    className="flex w-full pl-4 text-left transition-colors hover:bg-fill focus-visible:bg-fill focus-visible:-outline-offset-2 active:bg-fill"
                  >
                    <span
                      className={`flex min-h-16 min-w-0 flex-1 items-center gap-3 py-3 pr-4 ${index === 0 ? "" : "border-t border-separator"}`}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="type-headline truncate">
                            {(row.keyName === null ? undefined : keyLabels.get(row.keyName)) ??
                              row.keyName ??
                              row.keyPrefix ??
                              row.id}
                          </span>
                          <Badge
                            variant={/error|fail/i.test(row.outcome) ? "destructive" : "secondary"}
                            className="h-6 shrink-0 px-2.5 text-xs font-semibold"
                          >
                            {row.outcome}
                          </Badge>
                        </span>
                        <span className="type-footnote mt-0.5 block truncate text-label-2">
                          {[
                            formatEpoch(row.createdAt),
                            row.deploymentId,
                            row.decisionReason,
                            row.cacheHit === null
                              ? null
                              : row.cacheHit
                                ? "Cache hit"
                                : "Cache miss",
                          ]
                            .filter((part) => part !== null)
                            .join(" · ")}
                        </span>
                      </span>
                      <ChevronRightIcon
                        size={18}
                        strokeWidth={1.8}
                        className="shrink-0 text-label-3"
                        aria-hidden="true"
                      />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        )}
        {requests.nextCursor ? (
          <Button
            variant="secondary"
            className="mt-4 w-full sm:w-auto"
            onClick={onLoadMore}
            disabled={loadingMore}
          >
            {loadingMore ? "Loading…" : "Load More Requests"}
          </Button>
        ) : null}
      </Section>

      {selected ? (
        <AdminSheet
          title="Request"
          description="Metadata only. Prompts, completions and reasoning aren’t stored, and task success isn’t inferred from HTTP success."
          onClose={() => setSelected(null)}
        >
          <dl className="divide-y divide-white/10">
            <Item label="ID" value={selected.id} />
            <Item label="When" value={formatEpoch(selected.createdAt)} />
            <Item
              label="Key"
              value={
                (selected.keyName === null ? undefined : keyLabels.get(selected.keyName)) ??
                selected.keyName ??
                selected.keyPrefix ??
                "—"
              }
            />
            <Item
              label="App"
              value={
                [selected.appTitle, selected.appUrl].filter((part) => part !== null).join(" · ") ||
                "—"
              }
            />
            <Item label="Priority" value={selected.priority ?? "—"} />
            <Item label="Deployment" value={selected.deploymentId ?? "—"} />
            <Item label="Location" value={selected.location ?? "—"} />
            <Item label="HTTP outcome" value={selected.outcome} />
            <Item label="Task success" value="—" />
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
        </AdminSheet>
      ) : null}
    </div>
  );
}

function FilterSelect<T extends string>({
  label,
  value,
  items,
  onChange,
}: {
  label: string;
  value: T | null;
  items: { value: T | null; label: string }[];
  onChange: (value: T | null) => void;
}) {
  const labelId = useId();
  return (
    <div className="min-w-0">
      <p id={labelId} className="type-footnote font-semibold text-label-2">
        {label}
      </p>
      <Select items={items} value={value} onValueChange={(next) => onChange(next as T | null)}>
        <SelectTrigger
          aria-labelledby={labelId}
          className="mt-2 w-full rounded-xl border-0 bg-fill px-3 text-[1rem] hover:bg-white/10 data-[size=default]:h-11"
        >
          <SelectValue className="min-w-0 truncate" />
        </SelectTrigger>
        <SelectContent className="glass glass-thick rounded-[22px] p-1.5">
          {items.map((item) => (
            <SelectItem
              key={item.value ?? ""}
              value={item.value}
              className="min-h-11 rounded-2xl px-3 text-[0.9375rem]"
            >
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id}>
      <h2 id={id} className="type-title-2 mb-3">
        {title}
      </h2>
      {children}
    </section>
  );
}

function TrendChart({ points }: { points: TrendPoint[] }) {
  const chart = useMemo(() => {
    if (points.length === 0) {
      return null;
    }
    const max = Math.max(...points.map((point) => point.requests), 1);
    const width = 640;
    const height = 120;
    const gap = 2;
    const barWidth = Math.max(2, (width - gap * (points.length - 1)) / points.length);
    return { max, width, height, gap, barWidth };
  }, [points]);

  return (
    <Section title="Requests over time">
      {chart ? (
        <Card className={`${listCard} p-4`}>
          <svg
            role="img"
            aria-label="Requests over the selected window"
            viewBox={`0 0 ${chart.width} ${chart.height}`}
            className="block h-auto w-full"
          >
            {points.map((point, index) => {
              const barHeight = (point.requests / chart.max) * chart.height;
              return (
                <rect
                  key={point.t}
                  x={index * (chart.barWidth + chart.gap)}
                  y={chart.height - barHeight}
                  width={chart.barWidth}
                  height={barHeight}
                  rx={1}
                  className="fill-label-2"
                >
                  <title>
                    {formatEpoch(point.t)} · {formatCount(point.requests)} requests
                  </title>
                </rect>
              );
            })}
          </svg>
        </Card>
      ) : (
        <p className="type-footnote text-label-2">No trend for this window.</p>
      )}
    </Section>
  );
}

function BreakdownSection({ title, rows }: { title: string; rows: BreakdownRow[] }) {
  return (
    <Section title={title}>
      {rows.length === 0 ? (
        <p className="type-footnote text-label-2">No breakdown for this window.</p>
      ) : (
        <Card className={listCard}>
          <ul>
            {rows.map((row, index) => (
              <li key={row.id} className="px-4">
                <div className={`py-3 ${index === 0 ? "" : "border-t border-separator"}`}>
                  <p className="type-headline truncate">{row.label}</p>
                  <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3 lg:grid-cols-6">
                    <Pair label="Requests" value={formatCount(row.requests)} />
                    <Pair
                      label="Local / cloud"
                      value={`${formatUnknown(row.local)} / ${formatUnknown(row.cloud)}`}
                    />
                    <Pair label="Estimate" value={formatUsd(row.estimatedUsd)} />
                    <Pair label="Billed" value={formatUsd(row.actualUsd)} />
                    <Pair label="Local COGS" value={formatUsd(row.localComputeUsd)} />
                    <Pair
                      label="Errors · cancel · sat"
                      value={`${formatUnknown(row.errors)} · ${formatUnknown(row.cancels)} · ${formatUnknown(row.saturation)}`}
                    />
                  </dl>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </Section>
  );
}

function CountSection({ title, rows, empty }: { title: string; rows: CountRow[]; empty: string }) {
  return (
    <Section title={title}>
      {rows.length === 0 ? (
        <p className="type-footnote text-label-2">{empty}</p>
      ) : (
        <Card className={listCard}>
          <ul>
            {rows.map((row, index) => (
              <li key={row.id} className="px-4">
                <div
                  className={`flex min-h-12 items-center justify-between gap-4 py-2 ${index === 0 ? "" : "border-t border-separator"}`}
                >
                  <span className="type-subhead min-w-0 [overflow-wrap:anywhere]">{row.label}</span>
                  <span className="type-subhead text-label-2 tabular-nums">
                    {formatCount(row.count)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </Section>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0 rounded-[20px] bg-surface p-4">
      <dt className="type-footnote text-label-2">{label}</dt>
      <dd className="mt-1">
        <span className="type-title-2 block tabular-nums [overflow-wrap:anywhere]">{value}</span>
        {hint ? <span className="type-caption mt-1 block text-label-2">{hint}</span> : null}
      </dd>
    </div>
  );
}

function Pair({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="type-caption text-label-2">{label}</dt>
      <dd className="type-subhead tabular-nums [overflow-wrap:anywhere]">{value}</dd>
    </div>
  );
}

function Item({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] gap-3 py-2.5">
      <dt className="type-footnote font-semibold text-glass-label-2">{label}</dt>
      <dd className="type-subhead [overflow-wrap:anywhere]">{value}</dd>
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
