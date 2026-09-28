import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBatchResultStore } from "../../src/batch/results.ts";
import {
  handleCreateBatch,
  handleDeleteBatch,
  handleGetBatch,
  handleListBatches,
} from "../../src/http/batch.ts";
import type { BatchDeps, KeyService } from "../../src/http/contracts.ts";
import { batchDeps, jsonRequest, samplePolicy, ORIGIN } from "./helpers.ts";

const MODEL = "vendor/model";
const AUTH = { authorization: "Bearer test-key" };

const submitReq = (json: unknown): Request =>
  jsonRequest(`${ORIGIN}/v1/batches`, { method: "POST", headers: AUTH, json });
const listReq = (query = ""): Request =>
  jsonRequest(`${ORIGIN}/v1/batches${query}`, { headers: AUTH });
const getReq = (id: string): Request =>
  jsonRequest(`${ORIGIN}/v1/batches/${id}`, { headers: AUTH });
const deleteReq = (id: string): Request =>
  jsonRequest(`${ORIGIN}/v1/batches/${id}`, { method: "DELETE", headers: AUTH });

const entry = (customId: string, bodyOverrides: Record<string, unknown> = {}): unknown => ({
  custom_id: customId,
  body: { model: MODEL, messages: [{ role: "user", content: "hi" }], ...bodyOverrides },
});

const envelope = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  endpoint: "/v1/chat/completions",
  model: MODEL,
  requests: [entry("a")],
  ...overrides,
});

/** Narrow an unknown `error` payload to its code — response bodies are network input. */
function codeOf(error: unknown): string | undefined {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}

/** Read `{ error: { code } }` out of a response body without unchecked casts. */
function errorCode(body: unknown): string | undefined {
  if (body !== null && typeof body === "object" && "error" in body) {
    return codeOf(body.error);
  }
  return undefined;
}

async function submit(
  json: unknown,
  deps: BatchDeps,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await handleCreateBatch(submitReq(json), deps);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const submitOk = async (json: unknown, deps: BatchDeps): Promise<{ id: string }> => {
  const { status, body } = await submit(json, deps);
  assert.equal(status, 202);
  return { id: body.id as string };
};

/** Drive a job with one dispatched item to `completed` through the REAL ledger, appending
 * the result row the scheduler would have written. */
function finishJob(deps: BatchDeps, jobId: string, customId: string): void {
  const claimed = deps.ledger.claim(1);
  assert.equal(claimed.length, 1);
  deps.ledger.completeItem(claimed[0]!.id, { status: "completed" });
  deps.results.append(jobId, {
    id: claimed[0]!.id,
    custom_id: customId,
    response: { status_code: 200, request_id: "req-1", body: { choices: [] } },
    error: null,
  });
  deps.ledger.setJobStatus(jobId, "finalizing");
  deps.ledger.setJobStatus(jobId, "completed");
}

test("batch routes require bearer authentication", async () => {
  const deps = batchDeps();
  const post = await handleCreateBatch(
    jsonRequest(`${ORIGIN}/v1/batches`, { method: "POST", json: envelope() }),
    deps,
  );
  assert.equal(post.status, 401);
  const get = await handleGetBatch(
    jsonRequest(`${ORIGIN}/v1/batches/batch_x`, {}),
    deps,
    "batch_x",
  );
  assert.equal(get.status, 401);
  const list = await handleListBatches(jsonRequest(`${ORIGIN}/v1/batches`, {}), deps);
  assert.equal(list.status, 401);
  const del = await handleDeleteBatch(
    jsonRequest(`${ORIGIN}/v1/batches/batch_x`, { method: "DELETE" }),
    deps,
    "batch_x",
  );
  assert.equal(del.status, 401);
  assert.equal(deps.ledger.list("key-1", { limit: 10 }).length, 0);
});

test("a rejected key never has its payload read", async () => {
  const deps = batchDeps();
  deps.keys.authenticate = async () => {
    throw Object.assign(new Error("key revoked"), { _tag: "KeyRevoked" });
  };
  let bodyTouched = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull() {
        bodyTouched = true;
      },
    },
    { highWaterMark: 0 },
  );
  const request = new Request(`${ORIGIN}/v1/batches`, {
    method: "POST",
    headers: AUTH,
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  const response = await handleCreateBatch(request, deps);
  assert.equal(response.status, 401);
  assert.equal(bodyTouched, false, "payload must not be read before authentication");
  assert.equal(deps.ledger.list("key-1", { limit: 100 }).length, 0);
});

test("drain rejects submission before the payload is read", async () => {
  const deps = batchDeps();
  deps.accepting.value = false;

  // Auth semantics are preserved while drained: missing bearer is still 401 first.
  const unauth = await handleCreateBatch(
    jsonRequest(`${ORIGIN}/v1/batches`, { method: "POST", json: envelope() }),
    deps,
  );
  assert.equal(unauth.status, 401, "auth precedes the drain check");

  let bodyTouched = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull() {
        bodyTouched = true;
      },
    },
    { highWaterMark: 0 },
  );
  const request = new Request(`${ORIGIN}/v1/batches`, {
    method: "POST",
    headers: AUTH,
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  const response = await handleCreateBatch(request, deps);
  assert.equal(response.status, 503);
  assert.equal(bodyTouched, false, "a drained gateway never reads the payload");
  assert.equal(deps.ledger.list("key-1", { limit: 100 }).length, 0);
});

test("drain arriving during the body read creates no job", async () => {
  const deps = batchDeps();
  const payload = new TextEncoder().encode(JSON.stringify(envelope()));
  let flipped = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        // First pull happens inside readJsonObject — after drain-guard 1, before guard 2.
        if (!flipped) {
          flipped = true;
          deps.accepting.value = false;
        }
        controller.enqueue(payload);
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const request = new Request(`${ORIGIN}/v1/batches`, {
    method: "POST",
    headers: AUTH,
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  const response = await handleCreateBatch(request, deps);
  assert.equal(flipped, true, "the drain actually lands inside the body-read window");
  assert.equal(response.status, 503, "guard 2 catches a drain that races the body read");
  assert.equal(deps.ledger.list("key-1", { limit: 100 }).length, 0, "no durable job");
});

test("job-level submit violations are 400 invalid and persist nothing", async () => {
  const longId = "z".repeat(129);
  const cases: { name: string; body: Record<string, unknown> }[] = [
    { name: "unknown top-level field", body: envelope({ provider: { only: ["x"] } }) },
    { name: "wrong endpoint", body: envelope({ endpoint: "/v1/embeddings" }) },
    { name: "missing endpoint", body: { model: MODEL, requests: [entry("a")] } },
    {
      name: "missing model",
      body: { endpoint: "/v1/chat/completions", requests: [entry("a")] },
    },
    { name: "requests not an array", body: envelope({ requests: {} }) },
    { name: "empty requests", body: envelope({ requests: [] }) },
    { name: "bad completion window", body: envelope({ completion_window: "12h" }) },
    {
      name: "over 1000 items",
      body: envelope({ requests: Array.from({ length: 1_001 }, (_, i) => entry(`c${i}`)) }),
    },
    { name: "non-object entry", body: envelope({ requests: [entry("a"), "junk"] }) },
    {
      name: "missing custom_id",
      body: envelope({
        requests: [{ body: { model: MODEL, messages: [{ role: "user", content: "hi" }] } }],
      }),
    },
    {
      name: "non-string custom_id",
      body: envelope({
        requests: [
          { custom_id: 42, body: { model: MODEL, messages: [{ role: "user", content: "hi" }] } },
        ],
      }),
    },
    {
      name: "empty custom_id",
      body: envelope({
        requests: [
          { custom_id: "", body: { model: MODEL, messages: [{ role: "user", content: "hi" }] } },
        ],
      }),
    },
    { name: "overlong custom_id", body: envelope({ requests: [entry(longId)] }) },
    { name: "duplicate custom_id", body: envelope({ requests: [entry("a"), entry("a")] }) },
  ];
  for (const { name, body } of cases) {
    const deps = batchDeps();
    const { status, body: parsed } = await submit(body, deps);
    assert.equal(status, 400, name);
    assert.equal(errorCode(parsed), "invalid", name);
    assert.equal(deps.ledger.list("key-1", { limit: 100 }).length, 0, name);
  }
});

test("oversized submit payload is rejected without persisting", async () => {
  const deps = batchDeps();
  const { status, body } = await submit(
    envelope({
      requests: [
        entry("a"),
        entry("big", { messages: [{ role: "user", content: "y".repeat(33 * 1024 * 1024) }] }),
      ],
    }),
    deps,
  );
  assert.equal(status, 400);
  assert.equal(errorCode(body), "invalid");
  assert.equal(deps.ledger.list("key-1", { limit: 100 }).length, 0);
});

test("valid submit returns 202 with the OpenRouter-shaped batch object and durable inputs", async () => {
  const deps = batchDeps();
  const before = Math.floor(Date.now() / 1000);
  const { status, body } = await submit(envelope({ requests: [entry("a"), entry("b")] }), deps);
  assert.equal(status, 202);
  assert.equal(body.object, "batch");
  assert.equal(body.endpoint, "/v1/chat/completions");
  assert.equal(body.model, MODEL);
  assert.equal(body.completion_window, "24h");
  assert.equal(body.status, "validating");
  assert.equal(body.finalized_at, null);
  assert.equal(body.usage, null);
  assert.equal(body.results, null);
  assert.equal(body.error, null);
  assert.deepEqual(body.request_counts, { total: 2, completed: 0, failed: 0 });
  const id = body.id as string;
  assert.ok(id.startsWith("batch_"));
  assert.ok((body.created_at as number) >= before && (body.created_at as number) <= before + 2);

  const job = deps.ledger.job(id)!;
  assert.equal(Number.isInteger(job.spillAt), true);
  assert.ok(job.spillAt - job.createdAt <= 86_400_000 * 0.65);
  assert.ok(job.spillAt - job.createdAt > 86_400_000 * 0.65 - 2);
  assert.equal(body.created_at, Math.floor(job.createdAt / 1000));
  assert.equal(body.local_wait_until, Math.floor(job.spillAt / 1000));
  assert.equal(body.deadline_at, Math.floor((job.spillAt + job.completionWindowMs) / 1000));
  assert.equal((body.deadline_at as number) - (body.local_wait_until as number), 86_400);

  const items = deps.ledger.items(id);
  assert.equal(items.length, 2);
  assert.ok(items.every((item) => item.status === "queued"));
  const expectedBody = { model: MODEL, messages: [{ role: "user", content: "hi" }] };
  for (const item of items) {
    assert.deepEqual(deps.results.readInput(id, "key-1", item.id), expectedBody);
  }
});

test("invalid bodies become failed rows while valid work is accepted", async () => {
  const deps = batchDeps();
  const requests = [
    entry("ok"),
    entry("b", { stream: true }),
    entry("c", { messages: [] }),
    entry("d", { max_tokens: 0 }),
    entry("e", { model: "other/model" }),
    { custom_id: "f", body: { messages: [{ role: "user", content: "hi" }] } },
    { custom_id: "g", body: "not-an-object" },
    entry("h", { messages: [{ role: "user", content: "y".repeat(600 * 1024) }] }),
  ];
  const { status, body } = await submit(envelope({ requests }), deps);
  assert.equal(status, 202);
  assert.deepEqual(body.request_counts, { total: 8, completed: 0, failed: 6 });
  const jobId = body.id as string;
  const codes = [
    "stream_unsupported",
    "messages_invalid",
    "max_tokens_invalid",
    "model_mismatch",
    "invalid_body",
    "body_too_large",
  ];
  const rows = deps.results.rows(jobId);
  assert.deepEqual(
    rows.map((row) => row.custom_id),
    ["b", "c", "d", "e", "g", "h"],
  );
  assert.deepEqual(
    rows.map((row) => codeOf(row.error)),
    codes,
  );
  assert.ok(rows.every((row) => row.response === null && row.error !== null));
  assert.ok(rows.every((row) => row.id.startsWith("batch_req_")));

  const items = deps.ledger.items(jobId);
  const queued = items.filter((item) => item.status === "queued");
  const failed = items.filter((item) => item.status === "failed");
  assert.deepEqual(queued.map((item) => item.customId).sort(), ["f", "ok"]);
  assert.ok(
    queued.some((item) => item.customId === "f"),
    "an omitted body.model inherits the batch-level model",
  );
  assert.deepEqual(failed.map((item) => item.errorCode).sort(), [...codes].sort());
  for (const item of queued) {
    assert.notEqual(deps.results.readInput(jobId, "key-1", item.id), undefined);
  }
  assert.equal(deps.results.readInput(jobId, "key-1", failed[0]!.id), undefined);

  const inflight = await handleGetBatch(getReq(jobId), deps, jobId);
  assert.equal(inflight.status, 200);
  const inflightWire = (await inflight.json()) as { status: string; results: unknown };
  assert.equal(inflightWire.status, "validating");
  assert.equal(inflightWire.results, null, "results are not exposed before completion");
});

test("all-invalid body-level submit is 400 and persists nothing", async () => {
  const deps = batchDeps();
  const { status, body } = await submit(
    envelope({
      requests: [entry("a", { stream: true }), entry("b", { messages: [] })],
    }),
    deps,
  );
  assert.equal(status, 400);
  assert.equal(errorCode(body), "invalid");
  assert.equal(deps.ledger.list("key-1", { limit: 100 }).length, 0);
});

test("a key holds at most four in-flight batch jobs", async () => {
  const deps = batchDeps();
  const ids: string[] = [];
  for (let i = 0; i < 4; i += 1) {
    const { id } = await submitOk(envelope({ requests: [entry(`j${i}`)] }), deps);
    ids.push(id);
  }
  const capped = await submit(envelope({ requests: [entry("fifth")] }), deps);
  assert.equal(capped.status, 409);
  assert.equal(errorCode(capped.body), "conflict");
  assert.equal(deps.ledger.list("key-1", { limit: 100 }).length, 4);

  const cancelled = await handleDeleteBatch(deleteReq(ids[0]!), deps, ids[0]!);
  assert.equal(cancelled.status, 200);
  const freed = await submit(envelope({ requests: [entry("sixth")] }), deps);
  assert.equal(freed.status, 202);
  assert.equal(deps.ledger.list("key-1", { limit: 100 }).length, 5);
});

test("post-create row-append failure returns the accepted failed job, never 500", async () => {
  const deps = batchDeps();
  const realAppend = deps.results.append.bind(deps.results);
  let appended = 0;
  deps.results.append = (jobId, row) => {
    if (appended > 0) {
      throw new Error("result store write failed");
    }
    appended += 1;
    realAppend(jobId, row);
  };
  const { status, body } = await submit(
    envelope({
      requests: [entry("ok"), entry("b", { stream: true }), entry("c", { messages: [] })],
    }),
    deps,
  );
  assert.equal(status, 202, "an accepted job is never reported as an ambiguous 500");
  assert.equal(body.status, "failed");
  assert.equal(errorCode(body), "result_rows_rejected");
  const id = body.id as string;
  assert.equal(deps.ledger.job(id)!.status, "failed");
  assert.equal(deps.results.rows(id).length, 0, "the partial row set is purged");
  const item = deps.ledger.items(id)[0]!;
  assert.equal(deps.results.readInput(id, "key-1", item.id), undefined, "inputs are purged too");
});

test("a failing scheduler nudge still returns the accepted job", async () => {
  const deps = batchDeps();
  deps.kick = () => {
    throw new Error("nudge failed");
  };
  const { status, body } = await submit(envelope(), deps);
  assert.equal(status, 202);
  assert.equal(body.status, "validating");
  assert.equal(deps.ledger.job(body.id as string)!.status, "validating");
});

test("DELETE cancel persists even when the scheduler nudge fails", async () => {
  const deps = batchDeps();
  const { id } = await submitOk(envelope(), deps);
  deps.kick = () => {
    throw new Error("nudge failed");
  };
  const response = await handleDeleteBatch(deleteReq(id), deps, id);
  assert.equal(response.status, 200);
  assert.equal(deps.ledger.job(id)!.status, "cancelled");
});

test("input-store rejection fails the accepted job as input_store_rejected", async () => {
  const deps = batchDeps();
  deps.results.saveInputs = () => {
    throw new Error("store rejected the write");
  };
  const { status, body } = await submit(envelope(), deps);
  assert.equal(status, 202, "the job is durable; the caller reads the failure via GET");
  assert.equal(body.status, "failed");
  assert.equal(errorCode(body), "input_store_rejected");
  assert.deepEqual(body.request_counts, { total: 1, completed: 0, failed: 1 });
  assert.equal(deps.ledger.job(body.id as string)!.status, "failed");
  assert.ok(deps.ledger.items(body.id as string).every((item) => item.status === "failed"));
});

test("jobs are invisible to other keys", async () => {
  const deps = batchDeps();
  const { id } = await submitOk(envelope(), deps);

  const otherKeys: KeyService = {
    ...deps.keys,
    authenticate: async () => ({ keyId: "key-2", policy: samplePolicy() }),
  };
  const otherDeps: BatchDeps = { ...deps, keys: otherKeys };

  const get = await handleGetBatch(getReq(id), otherDeps, id);
  assert.equal(get.status, 404);
  assert.equal(errorCode(await get.json()), "not_found");
  const del = await handleDeleteBatch(deleteReq(id), otherDeps, id);
  assert.equal(del.status, 404);
  const list = await handleListBatches(listReq(), otherDeps);
  assert.equal(list.status, 200);
  assert.equal(((await list.json()) as { data: unknown[] }).data.length, 0);

  const owner = await handleGetBatch(getReq(id), deps, id);
  assert.equal(owner.status, 200);
});

test("completed GET serves results inline on every call until purged", async () => {
  const deps = batchDeps();
  const { id } = await submitOk(
    envelope({ requests: [entry("a"), entry("b", { stream: true })] }),
    deps,
  );
  finishJob(deps, id, "a");

  const first = await handleGetBatch(getReq(id), deps, id);
  assert.equal(first.status, 200);
  const wire = (await first.json()) as Record<string, unknown>;
  assert.equal(wire.status, "completed");
  assert.deepEqual(wire.request_counts, { total: 2, completed: 1, failed: 1 });
  const rows = wire.results as { custom_id: string; response: unknown; error: unknown }[];
  assert.equal(rows.length, 2);
  assert.ok(
    rows.some((row) => row.custom_id === "a" && row.response !== null && row.error === null),
  );
  assert.ok(
    rows.some((row) => row.custom_id === "b" && row.response === null && row.error !== null),
  );
  assert.equal(typeof wire.finalized_at, "number");

  const second = await handleGetBatch(getReq(id), deps, id);
  const retry = (await second.json()) as { results: unknown };
  assert.equal(second.status, 200);
  assert.deepEqual(retry.results, rows, "GET is retry-safe: rows are never consumed");

  const listed = (await (await handleListBatches(listReq(), deps)).json()) as {
    data: { id: string; results: unknown }[];
  };
  assert.equal(listed.data.find((row) => row.id === id)!.results, null);
});

test("completed GET rejects a partial result set reconstructed after restart", async () => {
  const base = batchDeps();
  const directory = mkdtempSync(join(tmpdir(), "llm-router-batch-omission-"));
  try {
    const jobInfo = (jobId: string) => {
      const job = base.ledger.job(jobId);
      return job === undefined
        ? undefined
        : {
            keyId: job.keyId,
            status: job.status,
            finalizedAt: job.finalizedAt,
            requestCount: job.requestCounts.total,
          };
    };
    const options = { directory, jobInfo };
    const deps: BatchDeps = { ...base, results: createBatchResultStore(options) };
    const { id } = await submitOk(
      envelope({ requests: [entry("a"), entry("b", { stream: true })] }),
      deps,
    );
    finishJob(deps, id, "a");
    const resultsDir = join(directory, id + ".results");
    unlinkSync(join(resultsDir, readdirSync(resultsDir)[0]!));

    const restarted: BatchDeps = { ...deps, results: createBatchResultStore(options) };
    const response = await handleGetBatch(getReq(id), restarted, id);
    assert.equal(response.status, 500, "GET must not serve a successful partial result");
    const failure = (await response.json()) as Record<string, unknown>;
    assert.equal("results" in failure, false, "no partial rows are exposed");
    await handleDeleteBatch(deleteReq(id), restarted, id);
    const afterPurge: BatchDeps = { ...deps, results: createBatchResultStore(options) };
    const after = await handleGetBatch(getReq(id), afterPurge, id);
    assert.equal(after.status, 200);
    assert.equal(((await after.json()) as { results: unknown }).results, null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("usage passes through with unknown kept distinct from zero", async () => {
  const deps = batchDeps();
  const { id } = await submitOk(envelope(), deps);
  deps.ledger.recordJobUsage(id, {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
    cost: null,
    is_byok: null,
  });
  let wire = (await (await handleGetBatch(getReq(id), deps, id)).json()) as {
    usage: Record<string, unknown>;
  };
  assert.equal(wire.usage.cost, null);
  assert.equal(wire.usage.is_byok, null);
  assert.equal(wire.usage.total_tokens, 15);

  deps.ledger.recordJobUsage(id, {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
    cost: 0,
    is_byok: false,
  });
  wire = (await (await handleGetBatch(getReq(id), deps, id)).json()) as {
    usage: Record<string, unknown>;
  };
  assert.equal(wire.usage.cost, 0, "a real zero is reported as zero, never null");
});

test("failed batch surfaces its error and never exposes results", async () => {
  const deps = batchDeps();
  const { id } = await submitOk(
    envelope({ requests: [entry("a"), entry("b", { stream: true })] }),
    deps,
  );
  assert.equal(deps.results.rows(id).length, 1, "pre-failed row is stored at submit");
  deps.ledger.setJobStatus(id, "failed", undefined, "no_eligible_model");
  const wire = (await (await handleGetBatch(getReq(id), deps, id)).json()) as Record<
    string,
    unknown
  >;
  assert.equal(wire.status, "failed");
  assert.equal(errorCode(wire), "no_eligible_model");
  assert.equal(wire.results, null, "only completed batches expose results");
  assert.equal(typeof wire.finalized_at, "number");
});

test("list paginates newest-first with a cursor and never inlines results", async () => {
  const deps = batchDeps();
  const base = Date.now();
  const ids: string[] = [];
  for (let i = 0; i < 21; i += 1) {
    const { job } = deps.ledger.create({
      job: {
        keyId: "key-1",
        model: MODEL,
        completionWindowMs: 86_400_000,
        spillAt: base + i + 300_000,
        createdAt: base + i,
      },
      items: [{ customId: `c${i}` }],
    });
    ids.push(job.id);
    deps.ledger.setJobStatus(job.id, "cancelling");
  }

  const first = (await (await handleListBatches(listReq(), deps)).json()) as {
    data: { id: string; results: unknown; local_wait_until: number; deadline_at: number }[];
    first_id: string | null;
    last_id: string | null;
    has_more: boolean;
  };
  assert.equal(first.data.length, 20, "default limit is 20");
  assert.equal(first.has_more, true);
  assert.deepEqual(
    first.data.map((row) => row.id),
    ids.slice(1, 21).reverse(),
  );
  assert.equal(first.first_id, ids[20]);
  assert.equal(first.last_id, ids[1]);
  assert.ok(first.data.every((row) => row.results === null));
  assert.ok(first.data.every((row) => row.deadline_at - row.local_wait_until === 86_400));

  const second = (await (
    await handleListBatches(listReq(`?after=${first.last_id}`), deps)
  ).json()) as { data: { id: string }[]; has_more: boolean };
  assert.deepEqual(
    second.data.map((row) => row.id),
    [ids[0]],
  );
  assert.equal(second.has_more, false);

  const bounded = (await (await handleListBatches(listReq("?limit=1"), deps)).json()) as {
    data: unknown[];
    has_more: boolean;
  };
  assert.equal(bounded.data.length, 1);
  assert.equal(bounded.has_more, true);

  for (const query of ["?limit=0", "?limit=101", "?limit=abc", "?after=batch_nope"]) {
    const bad = await handleListBatches(listReq(query), deps);
    assert.equal(bad.status, 400, query);
    assert.equal(errorCode(await bad.json()), "invalid", query);
  }
});

test("list rejects another key's cursor without changing own-key pagination", async () => {
  const deps = batchDeps();
  deps.keys.authenticate = async (token) => ({
    keyId: token === "other-key" ? "key-2" : "key-1",
    policy: samplePolicy(),
  });
  const base = Date.now();
  const create = (keyId: string, offset: number): string =>
    deps.ledger.create({
      job: {
        keyId,
        model: MODEL,
        completionWindowMs: 86_400_000,
        spillAt: base + offset + 300_000,
        createdAt: base + offset,
      },
      items: [{ customId: "c" + offset }],
    }).job.id;
  const older = create("key-1", 0);
  const foreign = create("key-2", 1);
  const newer = create("key-1", 2);

  const first = await handleListBatches(listReq("?limit=1"), deps);
  assert.equal(first.status, 200);
  const firstPage = (await first.json()) as {
    data: { id: string }[];
    has_more: boolean;
    last_id: string;
  };
  assert.deepEqual(
    firstPage.data.map((job) => job.id),
    [newer],
  );
  assert.equal(firstPage.has_more, true);
  const next = await handleListBatches(listReq("?limit=1&after=" + firstPage.last_id), deps);
  assert.equal(next.status, 200);
  const nextPage = (await next.json()) as { data: { id: string }[]; has_more: boolean };
  assert.deepEqual(
    nextPage.data.map((job) => job.id),
    [older],
  );
  assert.equal(nextPage.has_more, false);

  const unknown = await handleListBatches(listReq("?after=batch_nope"), deps);
  const other = await handleListBatches(listReq("?after=" + foreign), deps);
  assert.equal(other.status, 400);
  assert.equal(other.status, unknown.status);
  assert.deepEqual(await other.json(), await unknown.json());
  const ownOther = await handleListBatches(
    jsonRequest(ORIGIN + "/v1/batches?after=" + foreign, {
      headers: { authorization: "Bearer other-key" },
    }),
    deps,
  );
  assert.equal(ownOther.status, 200);
  assert.deepEqual(((await ownOther.json()) as { data: unknown[] }).data, []);
});

test("DELETE cancels undispatched items and lets in-flight work finish", async () => {
  const deps = batchDeps();
  const { id } = await submitOk(envelope({ requests: [entry("a"), entry("b")] }), deps);
  const claimed = deps.ledger.claim(1);
  assert.equal(claimed.length, 1);

  const response = await handleDeleteBatch(deleteReq(id), deps, id);
  assert.equal(response.status, 200);
  const wire = (await response.json()) as { status: string; results: unknown };
  assert.equal(wire.status, "cancelling");
  assert.equal(wire.results, null);

  const items = deps.ledger.items(id);
  assert.equal(items.filter((item) => item.status === "running").length, 1);
  assert.equal(items.filter((item) => item.status === "cancelled").length, 1);

  deps.ledger.completeItem(claimed[0]!.id, { status: "completed" });
  const after = (await (await handleGetBatch(getReq(id), deps, id)).json()) as {
    status: string;
    finalized_at: number | null;
  };
  assert.equal(after.status, "cancelled");
  assert.equal(typeof after.finalized_at, "number");
});

test("DELETE with nothing running lands cancelled immediately", async () => {
  const deps = batchDeps();
  const { id } = await submitOk(envelope(), deps);
  const response = await handleDeleteBatch(deleteReq(id), deps, id);
  assert.equal(response.status, 200);
  const wire = (await response.json()) as { status: string; finalized_at: number | null };
  assert.equal(wire.status, "cancelled");
  assert.equal(typeof wire.finalized_at, "number");
  assert.ok(deps.ledger.items(id).every((item) => item.status === "cancelled"));
  assert.equal(deps.ledger.job(id)!.status, "cancelled");
});

test("DELETE on a terminal batch purges results and stays idempotent", async () => {
  const deps = batchDeps();
  const { id } = await submitOk(
    envelope({ requests: [entry("a"), entry("b", { stream: true })] }),
    deps,
  );
  finishJob(deps, id, "a");
  assert.equal(deps.results.rows(id).length, 2);

  const response = await handleDeleteBatch(deleteReq(id), deps, id);
  assert.equal(response.status, 200);
  const wire = (await response.json()) as { status: string; results: unknown };
  assert.equal(wire.status, "completed");
  assert.equal(wire.results, null);
  assert.equal(deps.results.rows(id).length, 0, "purge removes stored rows");

  const after = (await (await handleGetBatch(getReq(id), deps, id)).json()) as {
    results: unknown;
  };
  assert.equal(after.results, null, "purged batch reports null results");

  const again = await handleDeleteBatch(deleteReq(id), deps, id);
  assert.equal(again.status, 200);
  assert.equal(deps.ledger.job(id)!.status, "completed");
});
