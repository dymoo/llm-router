import "server-only";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Schema } from "effect";
import { getEnv } from "../env.ts";
import { openControlPlaneSqlite, type SqliteDatabase } from "../src/db/index.ts";
import { Catalogue, type Deployment } from "../src/domain.ts";
import { createBatchLedger, type BatchLedger } from "../src/batch/ledger.ts";
import {
  aggregateBatchUsage,
  openRouterBatchSpill,
  type BatchIntentState,
  type BatchSubmitIntent,
} from "../src/batch/openrouter.ts";
import { createBatchResultStore } from "../src/batch/results.ts";
import {
  createBatchScheduler,
  type BatchScheduler,
  type BatchSpillItem,
  type BatchSpillPort,
  type BatchSpillResult,
  type BatchSpillResume,
} from "../src/batch/scheduler.ts";
import type { BatchDeps } from "../src/http/contracts.ts";
import { batchKeyService, batchKeys } from "./control.ts";
import { assertAcceptingWork } from "./lifecycle.ts";
import { batchInferencePort } from "./runtime.ts";
import { processState } from "./state.ts";

/** BATCH_CATALOG is deliberately separate from MODEL_CATALOG. It may contain only operator-
 * approved batch deployments, and every item carries the selected id through defer/recovery. */
function loadBatchCatalogue(path: string): readonly Deployment[] {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  return Schema.decodeUnknownSync(Catalogue)(parsed);
}

function endpointParts(endpoint: string): { origin: string; basePath: string } {
  const parsed = new URL(endpoint);
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("batch deployment endpoint must be an http(s) base URL");
  }
  const path = parsed.pathname.replace(/\/+$/, "") || "/api/v1";
  return {
    origin: parsed.origin,
    basePath: path.endsWith("/batches") ? path : `${path}/batches`,
  };
}

/** Adapter intent mapping onto durable BatchRemote rows: one intent per compatibility group.
 * beginRemote persists the exact item membership before the adapter performs its POST. */
function intentStateFor(
  ledger: BatchLedger,
  jobId: string,
  intent: BatchSubmitIntent,
): BatchIntentState {
  const prior = ledger.remoteByToken(intent.key);
  if (prior === undefined) {
    ledger.beginRemote(jobId, {
      groupKey: intent.key,
      submitToken: intent.key,
      itemIds: intent.itemIds,
      createdAt: intent.at,
    });
    return { phase: "none" };
  }
  if (prior.intent === "confirmed" && prior.remoteBatchId !== null) {
    return { phase: "submitted", remoteBatchId: prior.remoteBatchId };
  }
  if (prior.intent === "abandoned") {
    ledger.beginRemote(jobId, {
      groupKey: intent.key,
      submitToken: intent.key,
      itemIds: intent.itemIds,
      createdAt: intent.at,
    });
    return { phase: "none" };
  }
  return { phase: "prepared" };
}

function confirmIntent(ledger: BatchLedger, key: string, remoteBatchId: string): void {
  const prior = ledger.remoteByToken(key);
  if (prior === undefined) throw new Error(`unknown batch intent ${key}`);
  ledger.confirmRemote(prior.id, remoteBatchId);
}

function abandonIntent(ledger: BatchLedger, key: string): void {
  const prior = ledger.remoteByToken(key);
  if (prior !== undefined && prior.intent !== "abandoned") ledger.abandonRemote(prior.id);
}

function makeSpillPort(
  ledger: BatchLedger,
  catalogue: readonly Deployment[],
): (BatchSpillPort & BatchSpillResume) | undefined {
  const env = getEnv();
  if (env.OPENROUTER_API_KEY === undefined || catalogue.length === 0) return undefined;
  const apiKey = env.OPENROUTER_API_KEY;

  const adapterFor = (deployment: Deployment, jobId: string) => {
    if (deployment.transport !== "openrouter") {
      throw new Error(`batch deployment ${deployment.id} is not an OpenRouter deployment`);
    }
    const { origin, basePath } = endpointParts(deployment.endpoint);
    const providerOnly =
      deployment.providerRestriction === null ? undefined : [deployment.providerRestriction];
    return openRouterBatchSpill({
      apiKey,
      origin,
      basePath,
      providerOnly,
      prepare: (intent) => intentStateFor(ledger, jobId, intent),
      confirm: (key, remoteBatchId) => confirmIntent(ledger, key, remoteBatchId),
      abandon: (key) => abandonIntent(ledger, key),
    });
  };

  const deploymentFor = (items: readonly BatchSpillItem[]): Deployment => {
    const deploymentId = items[0]?.deploymentId;
    if (deploymentId === undefined || deploymentId.length === 0) {
      throw new Error("batch spill item is missing deploymentId");
    }
    if (items.some((item) => item.deploymentId !== deploymentId)) {
      throw new Error("batch spill group mixes deployment ids");
    }
    const deployment = catalogue.find((entry) => entry.id === deploymentId);
    if (deployment === undefined) throw new Error(`unknown batch deployment ${deploymentId}`);
    return deployment;
  };

  return {
    spill: async (
      items: readonly BatchSpillItem[],
      signal?: AbortSignal,
    ): Promise<BatchSpillResult> => {
      if (items.length === 0) return { rows: [], usage: null, groups: [] };
      const groups = new Map<string, BatchSpillItem[]>();
      for (const item of items) {
        const group = groups.get(item.deploymentId);
        if (group === undefined) groups.set(item.deploymentId, [item]);
        else group.push(item);
      }
      const results: BatchSpillResult[] = [];
      for (const group of groups.values()) {
        const deployment = deploymentFor(group);
        results.push(await adapterFor(deployment, group[0]!.jobId).spill(group, signal));
      }
      return {
        rows: results.flatMap((result) => result.rows),
        usage: aggregateBatchUsage(
          results.flatMap((result) => result.groups.map((fact) => fact.usage)),
        ),
        groups: results.flatMap((result) => result.groups),
      };
    },
    pollKnown: async (
      remoteBatchId: string,
      items: readonly BatchSpillItem[],
      deadlineAt: number,
      signal?: AbortSignal,
    ): Promise<BatchSpillResult> => {
      const deployment = deploymentFor(items);
      return adapterFor(deployment, items[0]!.jobId).pollKnown(
        remoteBatchId,
        items,
        deadlineAt,
        signal,
      );
    },
  };
}

function ensureBatch(): { scheduler: BatchScheduler; deps: BatchDeps } {
  if (processState.batch !== undefined) return processState.batch;
  const env = getEnv();
  let database: SqliteDatabase["Service"] | undefined;
  try {
    database = openControlPlaneSqlite(env.SQLITE_PATH);
    const ledger = createBatchLedger(database.db);
    const opened = database;
    const batchCatalogue =
      env.BATCH_CATALOG === undefined ? [] : loadBatchCatalogue(env.BATCH_CATALOG);
    const results = createBatchResultStore({
      directory: env.BATCH_RESULTS_DIR ?? join(dirname(env.SQLITE_PATH), "batch-content"),
      jobInfo: (jobId) => {
        const job = ledger.job(jobId);
        return job === undefined
          ? undefined
          : {
              keyId: job.keyId,
              status: job.status,
              finalizedAt: job.finalizedAt,
              requestCount: job.requestCounts.total,
            };
      },
    });
    const scheduler = createBatchScheduler({
      ledger,
      results,
      inference: batchInferencePort(),
      keys: batchKeys,
      now: Date.now,
      intervalMs: 1_000,
      batchCatalogue,
      spill: makeSpillPort(ledger, batchCatalogue),
    });
    const deps: BatchDeps = {
      ledger,
      results,
      keys: batchKeyService,
      assertAccepting: assertAcceptingWork,
      kick: () => scheduler.kick(),
    };
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      try {
        opened.sqlite.close();
      } catch {
        // Closing an already-closed SQLite handle is harmless during process teardown.
      }
    };
    processState.batch = { scheduler, deps, close };
    return processState.batch;
  } catch (error) {
    try {
      database?.sqlite.close();
    } catch {
      // Preserve the original startup/configuration error.
    }
    throw error;
  }
}

export function getBatchDeps(): BatchDeps {
  return ensureBatch().deps;
}

/** Boot-time scheduler start + confirmed-remote poll resume. */
export function startBatch(): void {
  ensureBatch().scheduler.start();
}

/** Drain local work, abort remote contact, then close this module's extra SQLite handle once. */
export async function drainBatch(): Promise<void> {
  const batch = processState.batch;
  if (batch === undefined) return;
  await batch.scheduler.drain();
  batch.close?.();
}
