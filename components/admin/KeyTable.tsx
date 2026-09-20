"use client";

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
  onRotate,
  onRevoke,
}: {
  keys: PublicKey[];
  query: string;
  nextCursor: string | null;
  loadingMore: boolean;
  onQuery: (value: string) => void;
  onLoadMore: () => void;
  onEdit: (key: PublicKey) => void;
  onRotate: (key: PublicKey) => void;
  onRevoke: (key: PublicKey) => void;
}) {
  const visible = filterLoadedKeys(keys, query);

  if (keys.length === 0) {
    return null;
  }

  return (
    <>
      <div className="toolbar">
        <label className="field toolbar-search">
          <span>{LOADED_FILTER_LABEL}</span>
          <input
            type="search"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            placeholder="Name or prefix"
            autoComplete="off"
            spellCheck={false}
          />
          <span className="hint">{LOADED_FILTER_HINT}</span>
        </label>
      </div>
      <div className="panel">
        <div className="table-wrap">
          <table className="keys">
            <thead>
              <tr>
                <th>Name</th>
                <th>Prefix</th>
                <th>Status</th>
                <th>Requests</th>
                <th>Last used</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((key) => (
                <tr key={key.id}>
                  <td>
                    <div className="name">{key.name}</div>
                    <div className="muted">{policySummary(key.policy)}</div>
                  </td>
                  <td className="mono">{key.prefix}</td>
                  <td>
                    <StatusPill keyRecord={key} />
                  </td>
                  <td className="muted">{counterLabel(key)}</td>
                  <td className="muted">{formatEpoch(key.lastUsedAt)}</td>
                  <td>
                    <RowActions
                      keyRecord={key}
                      onEdit={onEdit}
                      onRotate={onRotate}
                      onRevoke={onRevoke}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="cards">
          {visible.map((key) => (
            <article className="card" key={key.id}>
              <div className="card-head">
                <div>
                  <div className="name">{key.name}</div>
                  <div className="mono">{key.prefix}</div>
                </div>
                <StatusPill keyRecord={key} />
              </div>
              <p className="muted">{policySummary(key.policy)}</p>
              <p className="muted">{counterLabel(key)}</p>
              <p className="muted">Last used {formatEpoch(key.lastUsedAt)}</p>
              <RowActions keyRecord={key} onEdit={onEdit} onRotate={onRotate} onRevoke={onRevoke} />
            </article>
          ))}
        </div>
        {visible.length === 0 ? (
          <div className="empty">
            <h2>No loaded keys match</h2>
            <p>The filter only applies to keys already on this page.</p>
          </div>
        ) : null}
        {nextCursor ? (
          <div className="more">
            <button
              className="btn btn-secondary"
              type="button"
              onClick={onLoadMore}
              disabled={loadingMore}
            >
              {loadingMore ? "Loading…" : "Load More Keys"}
            </button>
          </div>
        ) : null}
      </div>
    </>
  );
}

function StatusPill({ keyRecord }: { keyRecord: PublicKey }) {
  const status = keyLifecycle(keyRecord);
  const tone = status === "active" ? "ok" : status === "expired" ? "warn" : "bad";
  const label = status === "active" ? "Active" : status === "expired" ? "Expired" : "Revoked";
  return (
    <span className="pill" data-tone={tone}>
      {label}
    </span>
  );
}

function RowActions({
  keyRecord,
  onEdit,
  onRotate,
  onRevoke,
}: {
  keyRecord: PublicKey;
  onEdit: (key: PublicKey) => void;
  onRotate: (key: PublicKey) => void;
  onRevoke: (key: PublicKey) => void;
}) {
  const revoked = keyRecord.revokedAt !== null;
  return (
    <div className="row-actions">
      <button
        className="btn btn-ghost btn-row"
        type="button"
        disabled={revoked}
        onClick={() => onEdit(keyRecord)}
      >
        Edit
      </button>
      <button
        className="btn btn-ghost btn-row"
        type="button"
        disabled={revoked}
        onClick={() => onRotate(keyRecord)}
      >
        Rotate
      </button>
      <button
        className="btn btn-danger-ghost btn-row"
        type="button"
        disabled={revoked}
        onClick={() => onRevoke(keyRecord)}
      >
        Revoke
      </button>
    </div>
  );
}

function counterLabel(key: PublicKey): string {
  const running = key.runningCount > 0 ? ` · ${formatCount(key.runningCount)} running` : "";
  return `${formatCount(key.requestCount)} req${running} · ${formatCount(key.successCount)} ok · ${formatCount(key.errorCount)} err`;
}
