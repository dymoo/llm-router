"use client";

import { PlusIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import { AdminSheet } from "./AdminSheet";
import { Companion, COMPANION_NAME } from "./Companion";
import { HealthStatus } from "./HealthStatus";
import { KeyEditor } from "./KeyEditor";
import { KeyTable } from "./KeyTable";
import { defaultDraft } from "./presets";
import { cloneDraft, draftFromKey, resolveStaleEdit } from "./policy";
import { SecretReveal } from "./SecretReveal";
import { StatusScreen } from "./StatusScreen";
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
        body: "Apps and agents using this key are refused from now on. This can’t be undone.",
        action: "Revoke Key",
        danger: true,
      };
    }
    return {
      title: `Rotate the secret for ${confirm.key.name}?`,
      body: "The current secret stops working straight away. There’s no overlap period.",
      action: "Rotate Secret",
      danger: false,
    };
  }, [confirm]);

  if (session === "checking") {
    return <StatusScreen mood="sleepy" title={`${COMPANION_NAME} is fetching your keys…`} busy />;
  }

  if (session === "error") {
    return (
      <StatusScreen
        mood="sad"
        title="The console couldn’t load"
        detail={banner ?? "The admin API is unreachable. Your keys are unchanged."}
        action={
          <Button
            size="lg"
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
          </Button>
        }
      />
    );
  }

  const createButton = (className: string) => (
    <Button size="lg" className={className} onClick={openCreate}>
      <PlusIcon strokeWidth={1.8} aria-hidden="true" className="size-5" />
      Create Key
    </Button>
  );
  const editedKey =
    editor?.mode === "edit" ? keys.find((item) => item.id === editor.id) : undefined;
  const confirmFromEditor = (action: Confirm["action"]) =>
    editedKey
      ? () => {
          setEditor(null);
          setEditorError(null);
          setConfirm({ action, key: editedKey });
        }
      : undefined;

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => setTab(value === "usage" ? "usage" : "keys")}
      className="min-h-dvh gap-0"
    >
      <div className="sr-only" aria-live="polite">
        {live}
      </div>
      <header className="sticky top-0 z-30 bg-bg/80 pt-[var(--safe-top)] backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-2 pr-[max(1rem,var(--safe-right))] pl-[max(1rem,var(--safe-left))] sm:gap-3 sm:px-8">
          <Companion size={30} />
          <p className="font-display text-[1.125rem] font-extrabold tracking-[-0.02em] max-[23rem]:sr-only">
            LLM <span className="text-label-2">Router</span>
          </p>
          <div className="flex-1" />
          <TabsList
            aria-label="Console"
            className="rounded-full bg-fill p-0.5 group-data-horizontal/tabs:h-12"
          >
            <TabsTrigger value="keys" className={tabClass}>
              Keys
            </TabsTrigger>
            <TabsTrigger value="usage" className={tabClass}>
              Usage
            </TabsTrigger>
          </TabsList>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Refresh"
            title="Refresh"
            className="-mr-2 text-label-2"
            onClick={() => {
              void refresh().then(() => announce("Refreshed."));
            }}
          >
            <RefreshCwIcon strokeWidth={1.8} aria-hidden="true" className="size-[22px]" />
          </Button>
        </div>
      </header>
      <main
        id="main"
        className={`mx-auto w-full max-w-5xl px-4 pt-6 sm:px-8 sm:pb-16 ${tab === "keys" ? "pb-[calc(7rem+var(--safe-bottom))]" : "pb-[calc(3rem+var(--safe-bottom))]"}`}
      >
        <div className="flex items-end justify-between gap-4">
          <div className="min-w-0">
            <h1 className="type-title-1">{tab === "keys" ? "Keys" : "Usage"}</h1>
            <div className="mt-2">
              <HealthStatus health={health} />
            </div>
          </div>
          {tab === "keys" ? createButton("hidden sm:inline-flex") : null}
        </div>
        {banner ? (
          <Alert className="mt-6 flex items-center gap-3 rounded-[20px] border-0 bg-surface p-4">
            <Companion mood="sad" size={36} className="size-9" />
            <div className="min-w-0 flex-1">
              <AlertTitle className="type-headline">Something went wrong</AlertTitle>
              <AlertDescription className="type-footnote text-label-2">{banner}</AlertDescription>
            </div>
            <Button variant="ghost" className="-mr-2 text-label-2" onClick={() => setBanner(null)}>
              Dismiss
            </Button>
          </Alert>
        ) : null}
        <TabsContent value="keys" className="mt-6">
          {empty ? (
            <Card className="items-center gap-0 rounded-[28px] bg-surface px-6 py-12 text-center ring-0">
              <Companion size={92} />
              <h2 className="type-title-2 mt-5">No keys yet</h2>
              <p className="type-subhead mt-2 max-w-sm text-label-2">
                Create a key for each app or agent that should use the router. Its secret is shown
                once.
              </p>
            </Card>
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
            />
          )}
        </TabsContent>
        <TabsContent value="usage" className="mt-6">
          <UsageView
            keys={keys}
            query={usageQuery}
            usage={usage}
            requests={requests}
            loadingMore={loadingMore}
            onQuery={(next) => void changeUsageQuery(next)}
            onLoadMore={() => void loadMoreRequests()}
          />
        </TabsContent>
      </main>
      {tab === "keys" ? (
        <div className="fixed inset-x-0 bottom-0 z-20 bg-linear-to-t from-bg via-bg/90 to-transparent px-4 pt-6 pb-[max(1rem,var(--safe-bottom))] sm:hidden">
          {createButton("w-full shadow-[var(--glass-shadow)]")}
        </div>
      ) : null}
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
          onRotate={confirmFromEditor("rotate")}
          onRevoke={confirmFromEditor("revoke")}
        />
      ) : null}
      {confirm && confirmCopy ? (
        <AdminSheet
          title={confirmCopy.title}
          description={confirmCopy.body}
          onClose={busy ? undefined : () => setConfirm(null)}
          footer={
            <>
              <Button variant="secondary" disabled={busy} onClick={() => setConfirm(null)}>
                Cancel
              </Button>
              <Button
                variant={confirmCopy.danger ? "danger" : "default"}
                disabled={busy}
                onClick={() => void runConfirm()}
              >
                {confirmCopy.action}
              </Button>
            </>
          }
        />
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
    </Tabs>
  );
}

const tabClass =
  "type-subhead h-full rounded-full px-4 font-semibold text-label-2 hover:text-label data-active:bg-raised data-active:text-label";

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
