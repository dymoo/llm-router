"use client";

import { ChevronRightIcon } from "lucide-react";
import { useId } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { policySummary } from "./explain";
import { filterLoadedKeys, LOADED_FILTER_HINT, LOADED_FILTER_LABEL } from "./filter";
import { formatCount, formatEpoch, keyLifecycle } from "./format";
import type { PublicKey } from "./types";

export function KeyTable({
  keys,
  query,
  nextCursor,
  loadingMore,
  onQuery,
  onLoadMore,
  onEdit,
}: {
  keys: PublicKey[];
  query: string;
  nextCursor: string | null;
  loadingMore: boolean;
  onQuery: (value: string) => void;
  onLoadMore: () => void;
  onEdit: (key: PublicKey) => void;
}) {
  const visible = filterLoadedKeys(keys, query);
  const searchId = useId();
  const hintId = useId();

  return (
    <div className="space-y-4">
      <div>
        <Label htmlFor={searchId} className="sr-only">
          {LOADED_FILTER_LABEL}
        </Label>
        <Input
          id={searchId}
          type="search"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder="Filter by name or prefix"
          autoComplete="off"
          spellCheck={false}
          aria-describedby={hintId}
          className="h-11 rounded-xl border-0 bg-fill px-4 text-[1rem] placeholder:text-label-3 focus-visible:ring-0 focus-visible:inset-ring-[1.5px] focus-visible:inset-ring-label-3 md:text-[1rem]"
        />
        <p id={hintId} className="type-footnote mt-2 text-label-2">
          {LOADED_FILTER_HINT}
        </p>
      </div>
      <Card className="gap-0 rounded-[20px] bg-surface py-0 ring-0">
        {visible.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <p className="type-headline">No loaded keys match</p>
            <p className="type-footnote mt-1 text-label-2">
              The filter only covers keys already on this page.
            </p>
          </div>
        ) : (
          <ul>
            {visible.map((key, index) => (
              <li key={key.id}>
                <KeyRow keyRecord={key} first={index === 0} onEdit={onEdit} />
              </li>
            ))}
          </ul>
        )}
      </Card>
      {nextCursor ? (
        <Button
          variant="secondary"
          className="w-full sm:w-auto"
          onClick={onLoadMore}
          disabled={loadingMore}
        >
          {loadingMore ? "Loading…" : "Load More Keys"}
        </Button>
      ) : null}
    </div>
  );
}

function KeyRow({
  keyRecord,
  first,
  onEdit,
}: {
  keyRecord: PublicKey;
  first: boolean;
  onEdit: (key: PublicKey) => void;
}) {
  const status = keyLifecycle(keyRecord);
  const revoked = status === "revoked";
  const usage = `${counterLabel(keyRecord)} · Last used ${formatEpoch(keyRecord.lastUsedAt)}`;
  const body = (
    <span
      className={`flex min-h-[76px] min-w-0 flex-1 items-center gap-3 py-3 pr-4 ${first ? "" : "border-t border-separator"}`}
    >
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className={`type-headline truncate ${revoked ? "text-label-2" : ""}`}>
            {keyRecord.name}
          </span>
          {status === "active" ? null : (
            <Badge
              variant={revoked ? "destructive" : "secondary"}
              className="h-6 shrink-0 px-2.5 text-xs font-semibold"
            >
              {revoked ? "Revoked" : "Expired"}
            </Badge>
          )}
        </span>
        <span className="type-footnote mt-0.5 block truncate text-label-2">
          {policySummary(keyRecord.policy)} · <span className="font-mono">{keyRecord.prefix}</span>
        </span>
        <span className="type-footnote mt-0.5 block truncate text-label-2 sm:hidden">{usage}</span>
      </span>
      <span className="type-footnote hidden shrink-0 text-right text-label-2 sm:block">
        {counterLabel(keyRecord)}
        <br />
        Last used {formatEpoch(keyRecord.lastUsedAt)}
      </span>
      {revoked ? (
        <span className="size-[18px] shrink-0" aria-hidden="true" />
      ) : (
        <ChevronRightIcon
          size={18}
          strokeWidth={1.8}
          className="shrink-0 text-label-3"
          aria-hidden="true"
        />
      )}
    </span>
  );

  if (revoked) {
    return <div className="flex pl-4">{body}</div>;
  }
  return (
    <button
      type="button"
      onClick={() => onEdit(keyRecord)}
      className="flex w-full pl-4 text-left transition-colors hover:bg-fill focus-visible:bg-fill focus-visible:-outline-offset-2 active:bg-fill"
    >
      <span className="sr-only">Edit </span>
      {body}
    </button>
  );
}

function counterLabel(key: PublicKey): string {
  const running = key.runningCount > 0 ? ` · ${formatCount(key.runningCount)} running` : "";
  return `${formatCount(key.requestCount)} requests${running} · ${formatCount(key.successCount)} ok · ${formatCount(key.errorCount)} errors`;
}
