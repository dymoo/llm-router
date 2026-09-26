import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, after, type TestContext } from "node:test";
import type { Deployment } from "../../src/domain.ts";
import { frontier } from "../router/fixtures.ts";
import { openControlPlaneSqlite, type SqliteDatabase } from "../../src/db/sqlite.ts";
import { createBatchLedger, type BatchLedger } from "../../src/batch/ledger.ts";
import {
  createBatchResultStore,
  type BatchResultRow,
  type BatchResultStore,
} from "../../src/batch/results.ts";
import {
  createBatchScheduler,
  type BatchDispatchResult,
  type BatchInferencePort,
  type BatchKeysPort,
  type BatchRoutedWork,
  type BatchScheduler,
  type BatchSpillItem,
  type BatchSpillPort,
  type BatchSpillResult,
} from "../../src/batch/scheduler.ts";
import type { Admission, FinalizeOutcome } from "../../src/keys/types.ts";
import type { KeyPolicy } from "../../src/http/contracts.ts";
import { ConcurrentLimit } from "../../src/errors.ts";
import { processState } from "../../server/state.ts";
import { register } from "../../instrumentation.ts";
import {
  BatchSpillAborted,
  BatchSubmitRejected,
  BatchSubmitUnknown,
} from "../../src/batch/openrouter.ts";

const NOW = 1_000_000;
const WINDOW = 24 * 60 * 60 * 1000;
const dirs: string[] = [];

after(() => {
  for (const directory of dirs) rmSync(directory, { recursive: true, force: true });
});

const policy: KeyPolicy = {
  priority: "low",
  localityBias: 0.5,
  contextLimitTokens: 200_000,
  maxCompletionTokens: 4_096,
  maxWaitMs: 250,
  overloadAction: "report",
  maxConcurrent: 8,
  requestsPerMinute: 600,
  allowedModels: null,
  maxEstimatedUsd: null,
  bias: { cost: 0.5, quality: 0.5, latency: 0.5 },
};

const requestBody = (id: string): Readonly<Record<string, unknown>> => ({
  model: "auto",
  messages: [{ role: "user", content: id }],
});

const localCompletion = (id: string): BatchDispatchResult => ({
  body: { id: `chatcmpl-${id}`, choices: [] },
  deploymentId: "local-1",
  metadata: () => ({ promptTokens: 3, completionTokens: 5, estimatedCostUsd: 0.01 }),
});
function resultErrorCode(row: BatchResultRow | undefined): string | undefined {
  const error = row?.error;
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

const batchDeployment: Deployment = frontier;

function tempResults(): string {
  const directory = mkdtempSync(join(tmpdir(), "llm-router-scheduler-"));
  dirs.push(directory);
  return directory;
}

function insertKey(opened: SqliteDatabase["Service"]): void {
  opened.sqlite
    .prepare(
      "INSERT INTO api_keys (id, prefix, digest, name, policy_json, created_at, expires_at, revoked_at, last_used_at, version) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 1)",
    )
    .run("key-1", "jrv_test", "digest-test", "test", JSON.stringify(policy), NOW);
}

class TestKeys implements BatchKeysPort {
  readonly admitted: Admission[] = [];
  readonly finalized: { requestId: string; outcome: FinalizeOutcome }[] = [];
  readonly deferred: { requestId: string; itemId: string }[] = [];
  readonly interrupted: { keyId: string; itemId: string }[] = [];
  failFinalizeCount = 0;
  failDeferredFinalizeCount = 0;
  failRecheckCount = 0;
  enforceConcurrentLimit = false;
  concurrentLimit = policy.maxConcurrent;
  private sequence = 0;

  constructor(private readonly opened: SqliteDatabase["Service"]) {}

  async admitByKeyId(keyId: string): Promise<Admission> {
    if (this.enforceConcurrentLimit) {
      const running = this.opened.sqlite
        .prepare(
          "SELECT count(*) AS n FROM requests WHERE key_id = ? AND status = 'running' AND deferred = 0",
        )
        .get(keyId) as { n: number };
      if (running.n >= this.concurrentLimit) {
        throw new ConcurrentLimit({ message: "concurrent request limit reached" });
      }
    }
    const admission: Admission = {
      requestId: `request-${++this.sequence}`,
      keyId,
      prefix: "jrv_test",
      name: "test",
      policy,
      version: 1,
      leaseExpiresAt: NOW + 10 * 60_000,
      admittedAt: NOW,
    };
    this.opened.sqlite
      .prepare(
        "INSERT INTO requests (id, key_id, started_at, lease_expires_at, status) VALUES (?, ?, ?, ?, 'running')",
      )
      .run(admission.requestId, keyId, NOW, admission.leaseExpiresAt);
    this.admitted.push(admission);
    return admission;
  }

  async attach(admission: Admission, itemId: string): Promise<void> {
    this.opened.sqlite
      .prepare("UPDATE batch_items SET request_id = ? WHERE id = ? AND request_id IS NULL")
      .run(admission.requestId, itemId);
  }

  async recheck(admission: Admission): Promise<Admission> {
    return admission;
  }

  async recheckDeferred(_admission: Admission): Promise<void> {
    if (this.failRecheckCount > 0) {
      this.failRecheckCount--;
      throw Object.assign(new Error("deferred admission rejected"), { _tag: "RateLimited" });
    }
  }

  async defer(
    admission: Admission,
    itemId: string,
    metadata: Omit<FinalizeOutcome, "status">,
    _deadlineAt: number,
  ): Promise<void> {
    this.deferred.push({ requestId: admission.requestId, itemId });
    this.opened.sqlite
      .prepare("UPDATE requests SET deferred = 1 WHERE id = ? AND key_id = ?")
      .run(admission.requestId, admission.keyId);
    this.opened.sqlite
      .prepare("UPDATE batch_items SET deployment_id = ? WHERE id = ?")
      .run(metadata.deploymentId ?? null, itemId);
  }

  async finalize(admission: Admission, outcome: FinalizeOutcome): Promise<void> {
    if (this.failFinalizeCount > 0) {
      this.failFinalizeCount--;
      throw new Error("accounting unavailable");
    }
    this.opened.sqlite
      .prepare(
        "UPDATE requests SET status = ?, finished_at = ?, error_code = ?, deferred = 0 WHERE id = ? AND key_id = ? AND status = 'running'",
      )
      .run(outcome.status, NOW, outcome.errorCode ?? null, admission.requestId, admission.keyId);
    this.finalized.push({ requestId: admission.requestId, outcome });
  }

  async finalizeDeferred(
    keyId: string,
    requestId: string,
    outcome: FinalizeOutcome,
  ): Promise<void> {
    if (this.failDeferredFinalizeCount > 0) {
      this.failDeferredFinalizeCount--;
      throw new Error("deferred accounting unavailable");
    }
    this.opened.sqlite
      .prepare(
        "UPDATE requests SET status = ?, finished_at = ?, error_code = ?, deferred = 0 WHERE id = ? AND key_id = ? AND status = 'running'",
      )
      .run(outcome.status, NOW, outcome.errorCode ?? null, requestId, keyId);
    this.finalized.push({ requestId, outcome });
  }

  async finalizeInterrupted(keyId: string, itemId: string): Promise<void> {
    this.opened.sqlite
      .prepare(
        "UPDATE requests SET status = 'abandoned', finished_at = ?, error_code = 'batch_interrupted', deferred = 0 WHERE id = (SELECT request_id FROM batch_items WHERE id = ?) AND key_id = ? AND status = 'running'",
      )
      .run(NOW, itemId, keyId);
    this.interrupted.push({ keyId, itemId });
  }
}

class TestInference implements BatchInferencePort {
  idle = true;
  readonly localCalls: BatchRoutedWork[] = [];
  readonly spillPlans: BatchRoutedWork[] = [];
  constructor(
    private readonly completion: (
      work: BatchRoutedWork,
    ) => BatchDispatchResult | Promise<BatchDispatchResult> = (work) =>
      localCompletion(work.requestId),
  ) {}

  interactiveIdle(): boolean {
    return this.idle;
  }

  complete(work: BatchRoutedWork): Promise<BatchDispatchResult> {
    this.localCalls.push(work);
    return Promise.resolve().then(() => this.completion(work));
  }

  prepareSpill(work: BatchRoutedWork): Promise<{
    deployment: Deployment;
    body: Record<string, unknown>;
    metadata: Omit<FinalizeOutcome, "status">;
  }> {
    this.spillPlans.push(work);
    return Promise.resolve({
      deployment: batchDeployment,
      body: { model: batchDeployment.modelId, messages: work.messages },
      metadata: { deploymentId: batchDeployment.id, location: "cloud", transport: "openrouter" },
    });
  }
}

class TestSpill implements BatchSpillPort {
  readonly posts: BatchSpillItem[][] = [];
  readonly polls: { remoteBatchId: string; items: BatchSpillItem[]; deadlineAt: number }[] = [];
  rejectMixed = false;
  blockUntilAbort = false;
  started = false;
  constructor(private readonly ledger: BatchLedger) {}
  pollResult?: BatchSpillResult | Error;
  spillResult?: BatchSpillResult | Error;
  beforeReject?: () => void;

  async spill(items: readonly BatchSpillItem[], signal?: AbortSignal): Promise<BatchSpillResult> {
    this.posts.push([...items]);
    const first = items[0];
    if (first === undefined) return { rows: [], usage: null, groups: [] };
    if (this.rejectMixed) {
      for (const [index, item] of items.entries()) {
        const remote = this.ledger.beginRemote(item.jobId, {
          groupKey: `group-${item.id}`,
          submitToken: `token-${item.jobId}-${item.id}`,
          itemIds: [item.id],
          createdAt: NOW,
        });
        if (index === 0) this.ledger.confirmRemote(remote.id, `provider-${item.id}`);
        else this.ledger.abandonRemote(remote.id);
      }
      throw new BatchSubmitRejected({
        message: "one group was rejected",
        status: 429,
        detail: null,
      });
    }
    const remote = this.ledger.beginRemote(first.jobId, {
      groupKey: `group-${first.deploymentId}`,
      submitToken: `token-${first.jobId}-${first.deploymentId}`,
      itemIds: items.map((item) => item.id),
      createdAt: NOW,
    });
    if (this.blockUntilAbort) {
      this.started = true;
      await new Promise<never>((_resolve, reject) => {
        const abort = (): void => reject(new BatchSpillAborted({ message: "aborted" }));
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
    }
    if (this.spillResult instanceof BatchSubmitUnknown) throw this.spillResult;
    if (this.spillResult instanceof BatchSubmitRejected) {
      this.beforeReject?.();
      this.ledger.abandonRemote(remote.id);
      throw this.spillResult;
    }
    this.ledger.confirmRemote(remote.id, "provider-batch-1");
    if (this.spillResult instanceof Error) throw this.spillResult;
    return (
      this.spillResult ?? {
        rows: items.map((item): BatchResultRow => ({
          id: item.id,
          custom_id: item.customId,
          response: {
            status_code: 200,
            request_id: null,
            body: { usage: { prompt_tokens: 2, completion_tokens: 3 } },
          },
          error: null,
        })),
        usage: null,
        groups: [
          {
            remoteBatchId: "provider-batch-1",
            itemIds: items.map((item) => item.id),
            usage: null,
          },
        ],
      }
    );
  }

  async pollKnown(
    remoteBatchId: string,
    items: readonly BatchSpillItem[],
    deadlineAt: number,
  ): Promise<BatchSpillResult> {
    this.polls.push({ remoteBatchId, items: [...items], deadlineAt });
    if (this.pollResult instanceof Error) throw this.pollResult;
    return (
      this.pollResult ?? {
        rows: items.map((item): BatchResultRow => ({
          id: item.id,
          custom_id: item.customId,
          response: { status_code: 200, request_id: null, body: {} },
          error: null,
        })),
        usage: null,
        groups: [{ remoteBatchId, itemIds: items.map((item) => item.id), usage: null }],
      }
    );
  }
}

type Harness = {
  opened: SqliteDatabase["Service"];
  ledger: BatchLedger;
  results: BatchResultStore;
  keys: TestKeys;
  inference: TestInference;
  spill: TestSpill;
  scheduler: BatchScheduler;
  jobId: string;
  itemId: string;
  itemIds: string[];
  resultDirectory: string;
  now: { value: number };
};

function harness(
  t: TestContext,
  options: {
    spillAt?: number;
    withSpill?: boolean;
    itemCount?: number;
    batchCatalogue?: readonly Deployment[];
    completion?: (work: BatchRoutedWork) => BatchDispatchResult | Promise<BatchDispatchResult>;
    intervalMs?: number;
    onTickError?: () => void;
  } = {},
): Harness {
  const opened = openControlPlaneSqlite(":memory:");
  insertKey(opened);
  const now = { value: NOW };
  const ledger = createBatchLedger(opened.db, { now: () => now.value });
  const created = ledger.create({
    job: {
      keyId: "key-1",
      model: "auto",
      completionWindowMs: WINDOW,
      spillAt: options.spillAt ?? NOW + WINDOW,
      createdAt: NOW,
    },
    items: Array.from({ length: options.itemCount ?? 1 }, (_unused, index) => ({
      customId: `item-${index + 1}`,
    })),
  });
  const resultDirectory = tempResults();
  const results = createBatchResultStore({
    directory: resultDirectory,
    jobInfo: (jobId) => {
      const job = ledger.job(jobId);
      return job === undefined
        ? undefined
        : { keyId: job.keyId, status: job.status, finalizedAt: job.finalizedAt };
    },
  });
  results.saveInputs(
    created.job.id,
    created.job.keyId,
    created.items.map((item) => ({ itemId: item.id, body: requestBody(item.customId) })),
  );
  const keys = new TestKeys(opened);
  const inference = new TestInference(options.completion);
  const spill = new TestSpill(ledger);
  const scheduler = createBatchScheduler({
    ledger,
    results,
    inference,
    keys,
    now: () => now.value,
    intervalMs: options.intervalMs ?? 60_000,
    batchCatalogue: options.batchCatalogue ?? [batchDeployment],
    ...(options.withSpill === false ? {} : { spill }),
    onTickError: options.onTickError,
  });
  const h: Harness = {
    opened,
    ledger,
    results,
    keys,
    inference,
    spill,
    scheduler,
    jobId: created.job.id,
    itemId: created.items[0]!.id,
    itemIds: created.items.map((item) => item.id),
    resultDirectory,
    now,
  };
  t.after(() => closeHarness(h));
  return h;
}
async function attachDeferred(h: Harness, itemId: string): Promise<void> {
  const admission = await h.keys.admitByKeyId("key-1");
  await h.keys.attach(admission, itemId);
  await h.keys.defer(
    admission,
    itemId,
    { deploymentId: batchDeployment.id, location: "cloud", transport: "openrouter" },
    NOW + WINDOW,
  );
}

async function waitFor(predicate: () => boolean, message: string | (() => string)): Promise<void> {
  for (let turn = 0; turn < 200; turn++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(typeof message === "string" ? message : message());
}

async function within<T>(promise: Promise<T>, message: string): Promise<T> {
  let result: { value: T } | { error: unknown } | undefined;
  void promise.then(
    (value) => {
      result = { value };
    },
    (error: unknown) => {
      result = { error };
    },
  );
  for (let turn = 0; turn < 200; turn++) {
    if (result !== undefined) {
      if ("error" in result) throw result.error;
      return result.value;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

async function closeHarness(h: Harness): Promise<void> {
  try {
    await h.scheduler.drain();
  } finally {
    h.opened.sqlite.close();
  }
}

function settle(h: Harness): Promise<void> {
  h.scheduler.kick();
  return new Promise((resolve) => setImmediate(resolve));
}

test("claims local work only while interactive runtime is idle", { timeout: 5_000 }, async (t) => {
  const h = harness(t);
  h.inference.idle = false;
  await settle(h);
  assert.equal(h.inference.localCalls.length, 0);
  h.inference.idle = true;
  await settle(h);
  assert.equal(h.ledger.items(h.jobId)[0]?.status, "completed");
  assert.equal(h.inference.localCalls.length, 1);
});

test("remote preparation waits until spillAt", { timeout: 5_000 }, async (t) => {
  const h = harness(t, { spillAt: NOW + 100 });
  h.inference.idle = false;
  await settle(h);
  assert.equal(h.inference.spillPlans.length, 0);
  h.now.value = NOW + 100;
  await settle(h);
  await waitFor(() => h.spill.posts.length === 1, "due remote preparation did not run");
  assert.equal(h.inference.spillPlans.length, 1);
  assert.equal(h.spill.posts[0]?.[0]?.deploymentId, batchDeployment.id);
});

test(
  "confirmed polling uses the persisted provider id and never invokes a new spill",
  { timeout: 5_000 },
  async (t) => {
    const h = harness(t, { spillAt: NOW });
    const item = h.ledger.items(h.jobId)[0]!;
    await attachDeferred(h, item.id);
    const remote = h.ledger.beginRemote(h.jobId, {
      groupKey: "resume",
      submitToken: "resume-token",
      itemIds: [item.id],
      createdAt: NOW,
    });
    h.ledger.confirmRemote(remote.id, "known-provider-id");
    h.spill.pollResult = {
      rows: [
        {
          id: item.id,
          custom_id: item.customId,
          response: { status_code: 200, request_id: null, body: {} },
          error: null,
        },
      ],
      usage: null,
      groups: [{ remoteBatchId: "known-provider-id", itemIds: [item.id], usage: null }],
    };
    h.scheduler.start();
    await waitFor(
      () => h.ledger.items(h.jobId)[0]?.status === "completed",
      "confirmed remote result was not applied",
    );
    assert.equal(h.spill.posts.length, 0);
    assert.equal(h.spill.polls[0]?.remoteBatchId, "known-provider-id");
  },
);

test(
  "ambiguous contact terminalizes for inspection without another POST",
  { timeout: 5_000 },
  async (t) => {
    const h = harness(t, { spillAt: NOW });
    h.spill.spillResult = new BatchSubmitUnknown({ message: "ambiguous", key: "intent" });
    await settle(h);
    await waitFor(
      () => h.ledger.job(h.jobId)?.status === "failed",
      () =>
        "unknown submission did not terminalize: " +
        JSON.stringify({
          job: h.ledger.job(h.jobId)?.status,
          item: h.ledger.items(h.jobId)[0],
          remotes: h.ledger.remotes(h.jobId),
          interrupted: h.keys.interrupted,
          rows: h.results.rows(h.jobId),
        }),
    );
    assert.equal(h.spill.posts.length, 1);
    assert.equal(h.ledger.remotes(h.jobId)[0]?.intent, "unknown");
    assert.equal(h.ledger.items(h.jobId)[0]?.status, "interrupted");
    assert.equal(resultErrorCode(h.results.rows(h.jobId)[0]), "batch_submit_unknown");
    assert.deepEqual(h.keys.interrupted, [{ keyId: "key-1", itemId: h.itemId }]);
    const deferred = h.keys.deferred[0];
    assert.ok(deferred, "ambiguous submission must retain its linked request");
    const request = h.opened.sqlite
      .prepare("SELECT status FROM requests WHERE id = ? AND key_id = ?")
      .get(deferred.requestId, "key-1");
    assert.ok(request && typeof request === "object" && "status" in request);
    assert.equal(request.status, "abandoned");
  },
);

test(
  "transient local capacity failure is requeued for a later idle tick",
  { timeout: 5_000 },
  async (t) => {
    let attempts = 0;
    const h = harness(t, {
      completion: () => {
        attempts++;
        if (attempts === 1) throw Object.assign(new Error("busy"), { _tag: "CapacityBusy" });
        return localCompletion("retry");
      },
    });
    await settle(h);
    assert.equal(h.ledger.items(h.jobId)[0]?.status, "queued");
    assert.equal(h.results.rows(h.jobId).length, 0);
    await settle(h);
    assert.equal(h.ledger.items(h.jobId)[0]?.status, "completed");
    assert.equal(attempts, 2);
    assert.equal(h.results.rows(h.jobId).length, 1);
  },
);

test("a failed tick is reported and later ticks still dispatch", { timeout: 5_000 }, async (t) => {
  let metricErrors = 0;
  const h = harness(t, {
    onTickError: () => {
      metricErrors++;
    },
  });
  const claim = h.ledger.claim;
  h.ledger.claim = () => {
    h.ledger.claim = claim;
    throw new Error("transient ledger fault");
  };
  const logged: unknown[][] = [];
  const originalLog = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };
  t.after(() => {
    console.error = originalLog;
  });
  await settle(h);
  assert.equal(h.ledger.items(h.jobId)[0]?.status, "queued");
  assert.equal(metricErrors, 1);
  assert.equal(logged[0]?.[0], "batch scheduler tick failed");
  assert.match(String(logged[0]?.[1]), /transient ledger fault/);
  await settle(h);
  assert.equal(h.ledger.items(h.jobId)[0]?.status, "completed");
});

test(
  "eight local items complete with two provider slots and no foreground traffic",
  { timeout: 5_000 },
  async (t) => {
    let active = 0;
    let peak = 0;
    const h = harness(t, {
      itemCount: 8,
      intervalMs: 5,
      withSpill: false,
      completion: async (work) => {
        if (active >= 2) throw Object.assign(new Error("busy"), { _tag: "CapacityBusy" });
        active++;
        peak = Math.max(peak, active);
        try {
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
          return localCompletion(work.requestId);
        } finally {
          active--;
        }
      },
    });
    h.keys.enforceConcurrentLimit = true;
    h.keys.concurrentLimit = 2;
    const previousBatch = processState.batch;
    const envKeys = [
      "NODE_ENV",
      "NEXT_RUNTIME",
      "NEXT_MANUAL_SIG_HANDLE",
      "APP_ORIGIN",
      "SQLITE_PATH",
      "API_KEY_PEPPER",
      "MODEL_CATALOG",
      "CLASSIFIER_MODE",
    ];
    const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    t.after(() => {
      processState.batch = previousBatch;
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    Object.assign(process.env, {
      NODE_ENV: "production",
      NEXT_RUNTIME: "nodejs",
      APP_ORIGIN: "http://127.0.0.1:14300",
      SQLITE_PATH: ":memory:",
      API_KEY_PEPPER: "fixture",
      MODEL_CATALOG: "fixture",
      CLASSIFIER_MODE: "laya",
    });
    delete process.env.NEXT_MANUAL_SIG_HANDLE;
    processState.batch = {
      scheduler: h.scheduler,
      deps: {} as NonNullable<typeof processState.batch>["deps"],
    };
    await register();
    h.scheduler.kick(); // Submission kicks once; boot must supply subsequent ticks.
    for (let turn = 0; turn < 40 && h.ledger.job(h.jobId)?.status !== "completed"; turn++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    const items = h.ledger.items(h.jobId);
    assert.equal(peak, 2);
    assert.equal(
      items.filter((item) => item.status === "completed").length,
      8,
      "scheduled items: " + items.map((item) => item.status).join(","),
    );
    assert.equal(h.ledger.job(h.jobId)?.status, "completed");
    assert.equal(h.results.rows(h.jobId).length, 8);
    assert.equal(new Set(h.results.rows(h.jobId).map((row) => row.id)).size, 8);
    const accounting = h.opened.sqlite.prepare("SELECT id FROM requests").all() as { id: string }[];
    assert.equal(accounting.length, 8);
    assert.equal(new Set(accounting.map((row) => row.id)).size, 8);
    assert.equal(h.keys.finalized.filter((row) => row.outcome.status === "success").length, 8);
  },
);

test(
  "due remote spill proceeds while foreground inference is active",
  { timeout: 5_000 },
  async (t) => {
    const h = harness(t, { spillAt: NOW });
    h.inference.idle = false;
    await settle(h);
    await waitFor(() => h.spill.posts.length === 1, "due spill waited for foreground idle");
    assert.equal(h.inference.localCalls.length, 0);
    assert.equal(h.inference.spillPlans.length, 1);
  },
);

test(
  "due remote spill waits for same-key foreground capacity, then posts once before its deadline",
  { timeout: 5_000 },
  async (t) => {
    const h = harness(t, { spillAt: NOW });
    h.inference.idle = false;
    h.keys.enforceConcurrentLimit = true;
    const foreground = h.opened.sqlite.prepare(
      "INSERT INTO requests (id, key_id, started_at, lease_expires_at, status) VALUES (?, 'key-1', ?, ?, 'running')",
    );
    for (let i = 0; i < policy.maxConcurrent; i++) {
      foreground.run("foreground-" + i, NOW, NOW + WINDOW);
    }

    await settle(h);
    await waitFor(
      () => h.ledger.items(h.jobId)[0]?.status !== "running",
      "busy-key admission did not settle",
    );
    assert.equal(h.ledger.items(h.jobId)[0]?.status, "queued");
    assert.equal(h.ledger.job(h.jobId)?.status, "in_progress");
    assert.deepEqual(h.results.rows(h.jobId), []);
    assert.equal(h.spill.posts.length, 0);
    assert.equal(h.ledger.items(h.jobId)[0]?.requestId, null);

    h.opened.sqlite
      .prepare("UPDATE requests SET status = 'success', finished_at = ? WHERE id = 'foreground-0'")
      .run(NOW + 1);
    h.now.value = NOW + WINDOW - 1;
    await settle(h);
    await waitFor(
      () => h.ledger.items(h.jobId)[0]?.status === "completed",
      "released key capacity did not complete remote spill",
    );
    assert.equal(h.spill.posts.length, 1);
    assert.equal(h.spill.posts[0]?.[0]?.id, h.itemId);
    assert.equal(h.results.rows(h.jobId)[0]?.response?.status_code, 200);
    await waitFor(() => h.ledger.job(h.jobId)?.status === "completed", "job did not finalize");
  },
);

test(
  "drain aborts and settles local-fallback spill without awaiting provider deadline",
  { timeout: 5_000 },
  async (t) => {
    const h = harness(t, {
      completion: () => {
        throw Object.assign(new Error("no local candidate"), { _tag: "NoEligibleModel" });
      },
    });
    h.spill.blockUntilAbort = true;
    await settle(h);
    await waitFor(() => h.spill.started, "remote submission did not start");
    await within(h.scheduler.drain(), "drain waited for the unresolved provider call");
    assert.equal(h.spill.posts.length, 1);
    assert.equal(
      h.ledger.remotes(h.jobId)[0]?.intent,
      "unknown",
      JSON.stringify({
        job: h.ledger.job(h.jobId)?.status,
        item: h.ledger.items(h.jobId)[0],
        interrupted: h.keys.interrupted,
      }),
    );
    assert.deepEqual(h.keys.interrupted, [{ keyId: "key-1", itemId: h.itemId }]);
    assert.equal(h.ledger.job(h.jobId)?.status, "failed");
    assert.equal(resultErrorCode(h.results.rows(h.jobId)[0]), "batch_submit_unknown");
  },
);

test(
  "rejected sibling is finalized and requeued while confirmed sibling is polled, never replayed",
  { timeout: 5_000 },
  async (t) => {
    const h = harness(t, { spillAt: NOW, itemCount: 2 });
    h.spill.rejectMixed = true;
    await settle(h);
    await waitFor(() => h.spill.posts.length === 1, "mixed compatibility submission did not begin");
    const [confirmedItem, rejectedItem] = h.spill.posts[0]!;
    assert.ok(confirmedItem);
    assert.ok(rejectedItem);
    await waitFor(
      () =>
        h.ledger.items(h.jobId).find((item) => item.id === rejectedItem.id)?.status === "queued" &&
        h.ledger.items(h.jobId).find((item) => item.id === rejectedItem.id)?.requestId === null,
      "definitely rejected group was not safely requeued",
    );
    const remotes = h.ledger.remotes(h.jobId);
    const confirmed = remotes.find(
      (remote) => remote.remoteBatchId === "provider-" + confirmedItem.id,
    );
    const abandoned = remotes.find((remote) => remote.intent === "abandoned");
    assert.equal(confirmed?.intent, "confirmed");
    assert.deepEqual(confirmed && h.ledger.itemsForRemote(confirmed.id).map((item) => item.id), [
      confirmedItem.id,
    ]);
    assert.equal(abandoned?.intent, "abandoned");
    const rejectedRequest = h.keys.deferred.find(
      (entry) => entry.itemId === rejectedItem.id,
    )?.requestId;
    assert.ok(rejectedRequest);
    assert.ok(
      h.keys.finalized.some(
        (entry) => entry.requestId === rejectedRequest && entry.outcome.status === "abandoned",
      ),
    );

    h.spill.rejectMixed = false;
    await settle(h);
    await waitFor(
      () => h.ledger.items(h.jobId).every((item) => item.status === "completed"),
      () =>
        "confirmed/retried groups did not finish: " +
        JSON.stringify({
          job: h.ledger.job(h.jobId)?.status,
          items: h.ledger.items(h.jobId),
          remotes: h.ledger.remotes(h.jobId),
          posts: h.spill.posts.map((batch) => batch.map((item) => item.id)),
          polls: h.spill.polls.map((poll) => poll.remoteBatchId),
          finalized: h.keys.finalized,
        }),
    );
    assert.equal(h.spill.polls[0]?.remoteBatchId, "provider-" + confirmedItem.id);
    assert.equal(h.spill.posts.length, 2);
    assert.deepEqual(
      h.spill.posts[1]?.map((item) => item.id),
      [rejectedItem.id],
    );
  },
);

test(
  "preflight failure settles one item while eligible survivors are still spilled",
  { timeout: 5_000 },
  async (t) => {
    const h = harness(t, { spillAt: NOW, itemCount: 2 });
    h.keys.failRecheckCount = 1;
    await settle(h);
    await waitFor(
      () =>
        h.ledger.items(h.jobId).filter((item) => item.status === "failed").length === 1 &&
        h.ledger.items(h.jobId).filter((item) => item.status === "completed").length === 1,
      "eligible survivor was blocked by a sibling preflight failure",
    );
    const failed = h.ledger.items(h.jobId).find((item) => item.status === "failed")!;
    const succeeded = h.ledger.items(h.jobId).find((item) => item.status === "completed")!;
    assert.deepEqual(
      h.spill.posts[0]?.map((item) => item.id),
      [succeeded.id],
    );
    assert.equal(
      resultErrorCode(h.results.rows(h.jobId).find((row) => row.id === failed.id)),
      "RateLimited",
    );
  },
);

test(
  "confirmed recovery with missing input fails, but missing catalogue remains resumable",
  { timeout: 5_000 },
  async (t) => {
    for (const missing of ["input", "catalogue"] as const) {
      const h = harness(t, {
        spillAt: NOW,
        ...(missing === "catalogue" ? { batchCatalogue: [] } : {}),
      });
      const item = h.ledger.items(h.jobId)[0]!;
      h.ledger.claim(1);
      await attachDeferred(h, item.id);
      const remote = h.ledger.beginRemote(h.jobId, {
        groupKey: `recovery-${missing}`,
        submitToken: `recovery-token-${missing}`,
        itemIds: [item.id],
        createdAt: NOW,
      });
      h.ledger.confirmRemote(remote.id, `known-${missing}`);
      if (missing === "input") h.results.removeInputs(h.jobId, "key-1", item.id);
      await settle(h);
      if (missing === "input") {
        await waitFor(
          () => h.ledger.items(h.jobId)[0]?.status === "failed",
          "missing input did not fail",
        );
        assert.equal(resultErrorCode(h.results.rows(h.jobId)[0]), "batch_recovery_unavailable");
        assert.notEqual(h.ledger.remotes(h.jobId)[0]?.harvestedAt, null);
      } else {
        assert.equal(h.ledger.items(h.jobId)[0]?.status, "running");
        assert.deepEqual(h.results.rows(h.jobId), []);
        assert.equal(h.ledger.remotes(h.jobId)[0]?.harvestedAt, null);
        assert.equal(h.keys.finalized.length, 0);
      }
      assert.equal(h.spill.polls.length, 0);
      assert.equal(h.spill.posts.length, 0);
      if (missing === "catalogue") {
        await h.scheduler.drain();
        const resumed = createBatchScheduler({
          ledger: h.ledger,
          results: h.results,
          inference: h.inference,
          keys: h.keys,
          now: () => h.now.value,
          intervalMs: 60_000,
          batchCatalogue: [batchDeployment],
          spill: h.spill,
        });
        try {
          resumed.start();
          await waitFor(
            () => h.ledger.items(h.jobId)[0]?.status === "completed",
            "restored catalogue did not poll",
          );
          assert.equal(h.spill.polls[0]?.remoteBatchId, "known-catalogue");
          assert.equal(h.spill.posts.length, 0);
          assert.notEqual(h.ledger.remotes(h.jobId)[0]?.harvestedAt, null);
        } finally {
          await resumed.drain();
        }
      }
    }
  },
);

test("corrupt input read does not strand a claimed local item", { timeout: 5_000 }, async (t) => {
  const h = harness(t);
  writeFileSync(join(h.resultDirectory, `${h.jobId}.inputs`, `${h.itemId}.json`), "{");
  await settle(h);
  assert.equal(h.ledger.items(h.jobId)[0]?.status, "failed");
  assert.equal(resultErrorCode(h.results.rows(h.jobId)[0]), "batch_payload_unavailable");
  assert.equal(h.inference.localCalls.length, 0);
});

test(
  "local response survives accounting failure and retries finalization without redispatch",
  { timeout: 5_000 },
  async (t) => {
    const h = harness(t);
    h.keys.failFinalizeCount = 1;
    await settle(h);
    assert.equal(h.inference.localCalls.length, 1);
    assert.equal(h.ledger.items(h.jobId)[0]?.status, "running");
    await settle(h);
    assert.equal(h.ledger.items(h.jobId)[0]?.status, "completed");
    assert.equal(h.inference.localCalls.length, 1);
    assert.equal(h.results.rows(h.jobId)[0]?.response?.status_code, 200);
    assert.equal(h.keys.finalized.length, 1);
  },
);

test(
  "running local completion that drains past the deadline is expired after it settles",
  { timeout: 5_000 },
  async (t) => {
    let h!: Harness;
    h = harness(t, {
      completion: () => {
        h.now.value = NOW + 2 * WINDOW + 1;
        return localCompletion("late");
      },
    });
    await settle(h);
    assert.equal(h.ledger.items(h.jobId)[0]?.status, "completed");
    assert.equal(h.ledger.job(h.jobId)?.status, "expired");
  },
);

test(
  "recovers a persisted finalizing job without replaying its completed item",
  { timeout: 5_000 },
  async (t) => {
    const h = harness(t);
    const [claimed] = h.ledger.claim(1);
    assert.ok(claimed);
    assert.equal(claimed.id, h.itemId);
    const admission = await h.keys.admitByKeyId("key-1");
    await h.keys.attach(admission, h.itemId);
    await h.keys.finalize(admission, { status: "success", deploymentId: "local-1" });
    h.results.append(h.jobId, {
      id: h.itemId,
      custom_id: claimed.customId,
      response: {
        status_code: 200,
        request_id: admission.requestId,
        body: localCompletion("persisted").body,
      },
      error: null,
    });
    h.ledger.completeItem(h.itemId, {
      status: "completed",
      requestId: admission.requestId,
      deploymentId: "local-1",
    });
    h.ledger.setJobStatus(h.jobId, "finalizing");

    await settle(h);
    await waitFor(
      () => h.ledger.job(h.jobId)?.status === "completed",
      "persisted finalizing job did not close",
    );
    assert.equal(h.inference.localCalls.length, 0);
    assert.equal(h.spill.posts.length, 0);
    assert.equal(h.results.rows(h.jobId)[0]?.response?.status_code, 200);
  },
);

test(
  "cancelling a rejected remote keeps its linked request until accounting settles",
  { timeout: 5_000 },
  async (t) => {
    const h = harness(t, { spillAt: NOW });
    h.spill.spillResult = new BatchSubmitRejected({
      message: "rejected before execution",
      status: 429,
      detail: null,
    });
    h.spill.beforeReject = () => h.ledger.setJobStatus(h.jobId, "cancelling");
    h.keys.failDeferredFinalizeCount = 1;

    await settle(h);
    await waitFor(
      () => h.keys.failDeferredFinalizeCount === 0,
      "rejected request accounting was not attempted",
    );
    const requestId = h.ledger.items(h.jobId)[0]?.requestId;
    assert.ok(requestId);
    assert.equal(h.ledger.remotes(h.jobId)[0]?.intent, "abandoned");
    assert.equal(h.ledger.items(h.jobId)[0]?.status, "running");
    assert.equal(h.ledger.job(h.jobId)?.status, "cancelling");
    const requestStatus = (): string | undefined =>
      (
        h.opened.sqlite
          .prepare("SELECT status FROM requests WHERE id = ? AND key_id = ?")
          .get(requestId, "key-1") as { status: string } | undefined
      )?.status;
    assert.equal(requestStatus(), "running", "the live linked request must not be orphaned");
    assert.deepEqual(h.ledger.claimDue(1, NOW), [], "cancelling work is never dispatched again");

    await settle(h);
    await waitFor(
      () => h.ledger.job(h.jobId)?.status === "cancelled",
      "cancelled request did not settle after accounting retry",
    );
    assert.equal(requestStatus(), "abandoned");
    assert.equal(h.ledger.items(h.jobId)[0]?.status, "cancelled");
    assert.equal(resultErrorCode(h.results.rows(h.jobId)[0]), "batch_cancelled");
    assert.equal(h.spill.posts.length, 1, "definitely rejected work must not be submitted again");
  },
);

test(
  "boot reconciles a cancelling abandoned remote only after linked request settlement",
  { timeout: 5_000 },
  async (t) => {
    const h = harness(t, { spillAt: NOW });
    const [item] = h.ledger.claim(1);
    assert.ok(item);
    assert.equal(item.id, h.itemId);
    await attachDeferred(h, item.id);
    const requestId = h.ledger.items(h.jobId)[0]?.requestId;
    assert.ok(requestId);
    const remote = h.ledger.beginRemote(h.jobId, {
      groupKey: "cancelled-before-restart",
      submitToken: "cancelled-before-restart",
      itemIds: [item.id],
      createdAt: NOW,
    });
    h.ledger.setJobStatus(h.jobId, "cancelling");
    h.ledger.abandonRemote(remote.id);
    assert.equal(h.ledger.items(h.jobId)[0]?.status, "running");
    assert.equal(h.ledger.job(h.jobId)?.status, "cancelling");
    h.keys.failDeferredFinalizeCount = 1;

    await settle(h);
    await waitFor(
      () => h.keys.failDeferredFinalizeCount === 0,
      "boot did not attempt abandoned request finalization",
    );
    assert.equal(h.ledger.items(h.jobId)[0]?.status, "running");
    assert.equal(h.ledger.job(h.jobId)?.status, "cancelling");
    const requestStatus = (): string | undefined =>
      (
        h.opened.sqlite
          .prepare("SELECT status FROM requests WHERE id = ? AND key_id = ?")
          .get(requestId, "key-1") as { status: string } | undefined
      )?.status;
    assert.equal(requestStatus(), "running");

    await settle(h);
    await waitFor(
      () => h.ledger.job(h.jobId)?.status === "cancelled",
      "boot did not close cancellation after accounting recovered",
    );
    assert.equal(requestStatus(), "abandoned");
    assert.equal(h.ledger.items(h.jobId)[0]?.status, "cancelled");
    assert.equal(resultErrorCode(h.results.rows(h.jobId)[0]), "batch_cancelled");
    assert.equal(h.spill.posts.length, 0, "boot must not resubmit the abandoned remote");
  },
);

test(
  "restart polling uses the confirmed provider window with fresh-poll grace",
  { timeout: 5_000 },
  async (t) => {
    const h = harness(t, { spillAt: NOW });
    await attachDeferred(h, h.itemId);
    const remote = h.ledger.beginRemote(h.jobId, {
      groupKey: "late-confirmation",
      submitToken: "late-confirmation",
      itemIds: [h.itemId],
      createdAt: NOW,
    });
    h.now.value = NOW + WINDOW - 1_000;
    h.ledger.confirmRemote(remote.id, "late-provider-id");
    const confirmedAt = h.ledger.remotes(h.jobId)[0]?.confirmedAt;
    assert.equal(confirmedAt, h.now.value);
    await settle(h);
    await waitFor(() => h.spill.polls.length === 1, "known provider id was not polled");
    assert.ok(h.spill.polls[0]!.deadlineAt > confirmedAt! + WINDOW);
    assert.equal(h.spill.posts.length, 0);
    assert.equal(h.ledger.job(h.jobId)?.spillAt, NOW);
  },
);

test(
  "confirmed remote survives missing poll config and resumes without POST",
  { timeout: 5_000 },
  async (t) => {
    const h = harness(t, { spillAt: NOW, withSpill: false });
    h.ledger.claim(1);
    await attachDeferred(h, h.itemId);
    const remote = h.ledger.beginRemote(h.jobId, {
      groupKey: "restored-config",
      submitToken: "restored-config",
      itemIds: [h.itemId],
      createdAt: NOW,
    });
    h.ledger.confirmRemote(remote.id, "restored-provider-id");
    await settle(h);
    assert.equal(h.ledger.remotes(h.jobId)[0]?.harvestedAt, null);
    assert.equal(h.ledger.items(h.jobId)[0]?.status, "running");
    assert.deepEqual(h.results.rows(h.jobId), []);
    assert.equal(h.keys.finalized.length, 0);
    await h.scheduler.drain();
    const resumed = createBatchScheduler({
      ledger: h.ledger,
      results: h.results,
      inference: h.inference,
      keys: h.keys,
      now: () => h.now.value,
      intervalMs: 60_000,
      batchCatalogue: [batchDeployment],
      spill: h.spill,
    });
    try {
      resumed.start();
      await waitFor(
        () => h.ledger.items(h.jobId)[0]?.status === "completed",
        "restored poll did not complete",
      );
      assert.equal(h.spill.posts.length, 0);
      assert.equal(h.spill.polls[0]?.remoteBatchId, "restored-provider-id");
      assert.notEqual(h.ledger.remotes(h.jobId)[0]?.harvestedAt, null);
    } finally {
      await resumed.drain();
    }
  },
);

test(
  "definitive submit rejection fails without retrying an unsupported pin",
  { timeout: 5_000 },
  async (t) => {
    for (const status of [400, 404]) {
      const h = harness(t, { spillAt: NOW });
      h.spill.spillResult = new BatchSubmitRejected({
        message: "unsupported pin",
        status,
        detail: null,
      });
      await settle(h);
      await waitFor(
        () => h.ledger.items(h.jobId)[0]?.status === "failed",
        status + " did not fail",
      );
      assert.equal(resultErrorCode(h.results.rows(h.jobId)[0]), "http_" + status);
      assert.equal(h.keys.finalized[0]?.outcome.status, "error");
      assert.equal(h.ledger.remotes(h.jobId)[0]?.intent, "abandoned");
      await settle(h);
      assert.equal(h.spill.posts.length, 1);
    }
  },
);

function corruptSiblingResult(h: Harness, siblingId: string): void {
  h.results.append(h.jobId, {
    id: siblingId,
    custom_id: "item-2",
    response: null,
    error: { code: "already_settled", message: "already settled" },
  });
  h.ledger.completeItem(siblingId, { status: "failed", errorCode: "already_settled" });
  const rowFile = readdirSync(join(h.resultDirectory, h.jobId + ".results"))[0];
  assert.ok(rowFile);
  writeFileSync(join(h.resultDirectory, h.jobId + ".results", rowFile), "{");
}

test("failed settlement ignores unrelated corrupt sibling row", { timeout: 5_000 }, async (t) => {
  const h = harness(t, {
    itemCount: 2,
    completion: () => {
      throw Object.assign(new Error("failure"), { _tag: "FatalInference" });
    },
  });
  corruptSiblingResult(h, h.itemIds[1]!);
  await settle(h);
  assert.equal(h.ledger.items(h.jobId).find((item) => item.id === h.itemId)?.status, "failed");
  assert.equal(h.results.hasRow(h.jobId, h.itemId), true);
});

test("cancel settlement ignores unrelated corrupt sibling row", { timeout: 5_000 }, async (t) => {
  const h = harness(t, { spillAt: NOW, itemCount: 2 });
  const target = h.ledger.claim(2).find((item) => item.id === h.itemId);
  assert.ok(target);
  await attachDeferred(h, target.id);
  const remote = h.ledger.beginRemote(h.jobId, {
    groupKey: "cancel-corrupt-sibling",
    submitToken: "cancel-corrupt-sibling",
    itemIds: [target.id],
    createdAt: NOW,
  });
  corruptSiblingResult(h, h.itemIds[1]!);
  h.ledger.setJobStatus(h.jobId, "cancelling");
  h.ledger.abandonRemote(remote.id);
  await settle(h);
  assert.equal(h.ledger.items(h.jobId).find((item) => item.id === target.id)?.status, "cancelled");
  assert.equal(h.results.hasRow(h.jobId, target.id), true);
  assert.equal(h.spill.posts.length, 0);
});
