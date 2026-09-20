"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AdminApiError,
  createKey,
  listKeys,
  loadHealth,
  loadRequests,
  loadUsage,
  revokeKey,
  rotateKey,
  unavailableHealth,
  unavailableUsage,
  updateKey,
} from "./api";
import { Dialog } from "./Dialog";
import { HealthStatus } from "./HealthStatus";
import { KeyEditor } from "./KeyEditor";
import { KeyTable } from "./KeyTable";
import { defaultDraft } from "./presets";
import { cloneDraft, draftFromKey, resolveStaleEdit } from "./policy";
import { SecretReveal } from "./SecretReveal";
import { UsageView } from "./UsageView";
import type {
  HealthSnapshot,
  KeyDraft,
  PublicKey,
  RequestPage,
  RevealedSecret,
  UsageQuery,
  UsageSnapshot,
} from "./types";

type Session = "checking" | "ready" | "error";
type Tab = "keys" | "usage";
type Editor =
  | { mode: "create"; draft: KeyDraft }
  | { mode: "edit"; id: string; expectedVersion: number; draft: KeyDraft; conflict: boolean };
type Confirm = { action: "revoke"; key: PublicKey } | { action: "rotate"; key: PublicKey };

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function defaultUsageQuery(): UsageQuery {
  const until = Date.now();
  return { since: until - WEEK_MS, until, keyId: null, priority: null, deploymentId: null };
}

export function AdminApp() {
  const [session, setSession] = useState<Session>("checking");
  const [tab, setTab] = useState<Tab>("keys");
  const [keys, setKeys] = useState<PublicKey[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [health, setHealth] = useState<HealthSnapshot>(unavailableHealth);
  const [usage, setUsage] = useState<UsageSnapshot>(unavailableUsage);
  const [requests, setRequests] = useState<RequestPage>({
    available: false,
    items: [],
    nextCursor: null,
  });
  const [usageQuery, setUsageQuery] = useState<UsageQuery>(defaultUsageQuery);
  const analyticsGeneration = useRef(0);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [revealed, setRevealed] = useState<RevealedSecret | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [live, setLive] = useState("");

  const announce = useCallback((message: string) => {
    setLive(message);
  }, []);

  const loadConsole = useCallback(async (nextUsage: UsageQuery) => {
    const generation = ++analyticsGeneration.current;
    const [page, snapshot, usagePage, requestPage] = await Promise.all([
      listKeys(null),
      loadHealth(),
      loadUsage(nextUsage),
      loadRequests(nextUsage, null),
    ]);
    setKeys(page.items);
    setNextCursor(page.nextCursor);
    setHealth(snapshot);
    if (generation === analyticsGeneration.current) {
      setUsage(usagePage);
      setRequests(requestPage);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        await loadConsole(defaultUsageQuery());
        setSession("ready");
      } catch (error) {
        setBanner(error instanceof AdminApiError ? error.message : "Could not load the console.");
        setSession("error");
      }
    })();
  }, [loadConsole]);

  const refresh = useCallback(async () => {
    const until = Date.now();
    const duration =
      usageQuery.until !== null && usageQuery.since !== null
        ? usageQuery.until - usageQuery.since
        : WEEK_MS;
    const next = { ...usageQuery, since: until - duration, until };
    setUsageQuery(next);
    await loadConsole(next);
  }, [loadConsole, usageQuery]);

  const openCreate = () => {
    setEditorError(null);
    setEditor({ mode: "create", draft: defaultDraft() });
  };

  const saveEditor = async () => {
    if (!editor) {
      return;
    }
    setBusy(true);
    setEditorError(null);
    try {
      if (editor.mode === "create") {
        const created = await createKey(editor.draft);
        setRevealed(created);
        setEditor(null);
        await refresh();
        announce(`Created ${created.key.name}. Copy the secret now.`);
        return;
      }
      const updated = await updateKey(editor.id, editor.expectedVersion, editor.draft);
      setKeys((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setEditor(null);
      announce(`Saved ${updated.name}.`);
    } catch (error) {
      if (error instanceof AdminApiError && error.stale && editor.mode === "edit") {
        let latest: PublicKey | undefined;
        try {
          const page = await listKeys(null);
          setKeys(page.items);
          setNextCursor(page.nextCursor);
          latest = page.items.find((item) => item.id === editor.id);
        } catch {
          latest = keys.find((item) => item.id === editor.id);
        }
        const resolved = resolveStaleEdit(editor.draft, latest);
        setEditor({
          mode: "edit",
          id: editor.id,
          expectedVersion: resolved.expectedVersion ?? editor.expectedVersion,
          draft: resolved.draft,
          conflict: true,
        });
        setEditorError(
          resolved.missing
            ? "This key is no longer in the loaded list. Your draft is still here."
            : "This key was updated elsewhere. Your draft is still here.",
        );
        return;
      }
      if (error instanceof AdminApiError && error.unauthorized) {
        setBanner("Credentials required. Reload after the browser signs in.");
        setSession("error");
        return;
      }
      setEditorError(error instanceof AdminApiError ? error.message : "Could not save the key.");
    } finally {
      setBusy(false);
    }
  };

  const runConfirm = async () => {
    if (!confirm) {
      return;
    }
    setBusy(true);
    try {
      if (confirm.action === "revoke") {
        await revokeKey(confirm.key.id);
        setConfirm(null);
        await refresh();
        announce(`Revoked ${confirm.key.name}.`);
        return;
      }
      const rotated = await rotateKey(confirm.key.id, confirm.key.version);
      setConfirm(null);
      setRevealed(rotated);
      await refresh();
      announce(`Rotated ${rotated.key.name}. Copy the secret now.`);
    } catch (error) {
      if (error instanceof AdminApiError && error.stale && confirm.action === "rotate") {
        await refresh();
        setBanner("This key was updated elsewhere. Try Rotate again.");
        setConfirm(null);
        return;
      }
      if (error instanceof AdminApiError && error.unauthorized) {
        setBanner("Credentials required. Reload after the browser signs in.");
        setSession("error");
        return;
      }
      setBanner(
        error instanceof AdminApiError ? error.message : "The action could not be completed.",
      );
      setConfirm(null);
    } finally {
      setBusy(false);
    }
  };

  const loadMoreKeys = async () => {
    if (!nextCursor) {
      return;
    }
    setLoadingMore(true);
    try {
      const page = await listKeys(nextCursor);
      setKeys((current) => mergeKeys(current, page.items));
      setNextCursor(page.nextCursor);
    } catch (error) {
      setBanner(error instanceof AdminApiError ? error.message : "Could not load more keys.");
    } finally {
      setLoadingMore(false);
    }
  };

  const changeUsageQuery = async (next: UsageQuery) => {
    setUsageQuery(next);
    const generation = ++analyticsGeneration.current;
    try {
      const [usagePage, requestPage] = await Promise.all([
        loadUsage(next),
        loadRequests(next, null),
      ]);
      if (generation !== analyticsGeneration.current) return;
      setUsage(usagePage);
      setRequests(requestPage);
    } catch (error) {
      if (error instanceof AdminApiError && error.unauthorized) {
        setBanner("Credentials required. Reload after the browser signs in.");
        setSession("error");
      }
    }
  };

  const loadMoreRequests = async () => {
    if (!requests.nextCursor) {
      return;
    }
    setLoadingMore(true);
    const generation = analyticsGeneration.current;
    try {
      const page = await loadRequests(usageQuery, requests.nextCursor);
      if (generation !== analyticsGeneration.current) return;
      setRequests({
        available: page.available,
        items: mergeRequestRows(requests.items, page.items),
        nextCursor: page.nextCursor,
      });
    } catch (error) {
      setBanner(error instanceof AdminApiError ? error.message : "Could not load more requests.");
    } finally {
      setLoadingMore(false);
    }
  };

  const empty = session === "ready" && keys.length === 0;
  const confirmCopy = useMemo(() => {
    if (!confirm) {
      return null;
    }
    if (confirm.action === "revoke") {
      return {
        title: `Revoke ${confirm.key.name}?`,
        body: "Agents using this key will be denied. This cannot be undone.",
        action: "Revoke Key",
        danger: true,
      };
    }
    return {
      title: `Rotate ${confirm.key.name}?`,
      body: "The current secret stops working immediately. There is no overlap period.",
      action: "Rotate Key",
      danger: false,
    };
  }, [confirm]);

  if (session === "checking") {
    return (
      <div className="page" aria-busy="true">
        <header className="chrome">
          <h1>Keys</h1>
        </header>
        <main className="main">
          <div className="skeleton">
            <div className="skel title" />
            <div className="skel line" />
            <div className="skel line" />
          </div>
        </main>
      </div>
    );
  }

  if (session === "error") {
    return (
      <main className="error-page">
        <h1>The console could not be shown</h1>
        <p>{banner ?? "The admin API is unreachable."}</p>
        <button
          className="btn btn-primary"
          type="button"
          onClick={() => {
            setSession("checking");
            setBanner(null);
            void (async () => {
              try {
                await loadConsole(defaultUsageQuery());
                setSession("ready");
              } catch (error) {
                setBanner(
                  error instanceof AdminApiError ? error.message : "Could not load the console.",
                );
                setSession("error");
              }
            })();
          }}
        >
          Try Again
        </button>
      </main>
    );
  }

  return (
    <div className="page">
      <div className="live" aria-live="polite">
        {live}
      </div>
      <header className="chrome">
        <h1>{tab === "keys" ? "Keys" : "Usage"}</h1>
        <nav className="tabs" aria-label="Console">
          <button
            type="button"
            aria-current={tab === "keys" ? "page" : undefined}
            onClick={() => setTab("keys")}
          >
            Keys
          </button>
          <button
            type="button"
            aria-current={tab === "usage" ? "page" : undefined}
            onClick={() => setTab("usage")}
          >
            Usage
          </button>
        </nav>
        <div className="chrome-spacer" />
        <HealthStatus health={health} />
        {tab === "keys" ? (
          <button className="btn btn-primary" type="button" onClick={openCreate}>
            Create Key
          </button>
        ) : null}
        <button
          className="btn btn-secondary"
          type="button"
          onClick={() => {
            void refresh().then(() => announce("Refreshed."));
          }}
        >
          Refresh
        </button>
      </header>
      <main className="main" id="main">
        {banner ? (
          <div className="banner" role="alert">
            <div>
              <h2>Something went wrong</h2>
              <p>{banner}</p>
            </div>
            <button className="btn btn-ghost" type="button" onClick={() => setBanner(null)}>
              Dismiss
            </button>
          </div>
        ) : null}
        {tab === "keys" ? (
          empty ? (
            <div className="panel">
              <div className="empty">
                <h2>No keys yet</h2>
                <p>Create a key to admit coding agents through the router.</p>
                <button className="btn btn-primary" type="button" onClick={openCreate}>
                  Create Key
                </button>
              </div>
            </div>
          ) : (
            <KeyTable
              keys={keys}
              query={query}
              nextCursor={nextCursor}
              loadingMore={loadingMore}
              onQuery={setQuery}
              onLoadMore={() => void loadMoreKeys()}
              onEdit={(key) => {
                setEditorError(null);
                setEditor({
                  mode: "edit",
                  id: key.id,
                  expectedVersion: key.version,
                  draft: draftFromKey(key),
                  conflict: false,
                });
              }}
              onRotate={(key) => setConfirm({ action: "rotate", key })}
              onRevoke={(key) => setConfirm({ action: "revoke", key })}
            />
          )
        ) : (
          <UsageView
            keys={keys}
            query={usageQuery}
            usage={usage}
            requests={requests}
            loadingMore={loadingMore}
            onQuery={(next) => void changeUsageQuery(next)}
            onLoadMore={() => void loadMoreRequests()}
          />
        )}
      </main>
      {editor ? (
        <KeyEditor
          mode={editor.mode}
          draft={editor.draft}
          busy={busy}
          error={editorError}
          conflict={editor.mode === "edit" && editor.conflict}
          onChange={(draft) => setEditor({ ...editor, draft: cloneDraft(draft) })}
          onClose={() => {
            if (!busy) {
              setEditor(null);
              setEditorError(null);
            }
          }}
          onSubmit={() => void saveEditor()}
        />
      ) : null}
      {confirm && confirmCopy ? (
        <Dialog
          open
          title={confirmCopy.title}
          description={confirmCopy.body}
          onClose={busy ? undefined : () => setConfirm(null)}
          footer={
            <>
              <button
                className="btn btn-secondary"
                type="button"
                disabled={busy}
                onClick={() => setConfirm(null)}
              >
                Cancel
              </button>
              <button
                className={confirmCopy.danger ? "btn btn-danger" : "btn btn-primary"}
                type="button"
                disabled={busy}
                onClick={() => void runConfirm()}
              >
                {confirmCopy.action}
              </button>
            </>
          }
        >
          {null}
        </Dialog>
      ) : null}
      {revealed ? (
        <SecretReveal
          revealed={revealed}
          onDismiss={() => {
            setRevealed(null);
            announce("Secret dismissed.");
          }}
        />
      ) : null}
    </div>
  );
}

function mergeKeys(current: PublicKey[], incoming: PublicKey[]): PublicKey[] {
  const seen = new Set<string>();
  const merged: PublicKey[] = [];
  for (const item of [...current, ...incoming]) {
    if (seen.has(item.id)) {
      const index = merged.findIndex((row) => row.id === item.id);
      if (index >= 0) {
        merged[index] = item;
      }
      continue;
    }
    seen.add(item.id);
    merged.push(item);
  }
  return merged;
}

function mergeRequestRows(
  current: RequestPage["items"],
  incoming: RequestPage["items"],
): RequestPage["items"] {
  const seen = new Set<string>();
  const merged: RequestPage["items"] = [];
  for (const item of [...current, ...incoming]) {
    if (seen.has(item.id)) {
      continue;
    }
    seen.add(item.id);
    merged.push(item);
  }
  return merged;
}
