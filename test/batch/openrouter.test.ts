import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FetchImpl } from "../../src/router/adapters/http.ts";
import type { BatchResultRow } from "../../src/batch/results.ts";
import type { BatchSpillItem } from "../../src/batch/scheduler.ts";
import {
  aggregateBatchUsage,
  BatchPollFailed,
  BatchProtocolError,
  BatchSubmitRejected,
  BatchSubmitUnknown,
  OPENROUTER_BATCH_BETA_BASE_PATH,
  SPILL_ROW_ERROR_CODES,
  openRouterBatchModelId,
  openRouterBatchSpill,
  type BatchIntentState,
  type BatchSubmitIntent,
  type OpenRouterBatchSpillOptions,
} from "../../src/batch/openrouter.ts";

interface RecordedCall {
  readonly method: string;
  readonly url: string;
  readonly body: string | null;
  readonly headers: Record<string, string>;
}

interface FakeBatch {
  id: string;
  status: string;
  model: string;
  endpoint: string;
  created_at: number;
  request_counts: { total: number; completed: number; failed: number };
  usage: unknown;
  results: unknown;
  error: unknown;
}

interface SubmittedPayload {
  endpoint: string;
  model: string;
  completion_window: string;
  requests: { custom_id: string; body: Record<string, unknown> }[];
}

const jsonRes = (status: number, value: unknown): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

const item = (n: number, overrides: Partial<BatchSpillItem> = {}): BatchSpillItem => ({
  id: `batch_req_${n}`,
  customId: `caller-${n}`,
  model: "openai/gpt-4o",
  jobId: "batch_job_1",
  deploymentId: "dep-a",
  body: {
    model: "openai/gpt-4o",
    messages: [{ role: "user", content: `m${n}` }],
    max_tokens: 64,
  },
  ...overrides,
});

interface IntentStore {
  readonly states: Map<string, BatchIntentState>;
  readonly events: string[];
  readonly intents: BatchSubmitIntent[];
  prepare(intent: BatchSubmitIntent): BatchIntentState;
  confirm(key: string, remoteBatchId: string): void;
  abandon(key: string, reason: string): void;
}

const intentStore = (): IntentStore => {
  const states = new Map<string, BatchIntentState>();
  const events: string[] = [];
  const intents: BatchSubmitIntent[] = [];
  return {
    states,
    events,
    intents,
    prepare(intent: BatchSubmitIntent): BatchIntentState {
      intents.push(intent);
      const existing = states.get(intent.key);
      if (existing !== undefined) {
        return existing;
      }
      states.set(intent.key, { phase: "prepared" });
      return { phase: "none" };
    },
    confirm(key: string, remoteBatchId: string): void {
      states.set(key, { phase: "submitted", remoteBatchId });
      events.push(`confirm:${remoteBatchId}`);
    },
    abandon(key: string, reason: string): void {
      states.delete(key);
      events.push(`abandon:${reason}`);
    },
  };
};

const sleepRecorder = () => {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number): Promise<void> => {
      delays.push(ms);
    },
  };
};

const spillOptions = (
  fetchImpl: FetchImpl,
  store: IntentStore,
  overrides: Partial<OpenRouterBatchSpillOptions> = {},
): OpenRouterBatchSpillOptions => ({
  apiKey: "sk-test",
  fetchImpl,
  sleep: async () => {},
  prepare: store.prepare,
  confirm: store.confirm,
  abandon: store.abandon,
  ...overrides,
});

const createUpstream = (
  decorate?: (batch: FakeBatch, payload: SubmittedPayload) => void,
): { calls: RecordedCall[]; fetchImpl: FetchImpl } => {
  const calls: RecordedCall[] = [];
  const batches = new Map<string, FakeBatch>();
  const created_at = Math.floor(Date.now() / 1000);
  let nextId = 1;
  const fetchImpl: FetchImpl = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : null;
    calls.push({
      method,
      url,
      body,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    if (method === "POST") {
      const payload = JSON.parse(body ?? "{}") as SubmittedPayload;
      const id = `batch_${nextId}`;
      nextId += 1;
      const batch: FakeBatch = {
        id,
        status: "completed",
        model: payload.model,
        endpoint: payload.endpoint,
        created_at,
        request_counts: {
          total: payload.requests.length,
          completed: payload.requests.length,
          failed: 0,
        },
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
          cost: 0.001,
          is_byok: false,
        },
        results: payload.requests.map((request, index) => ({
          id: `batch_req_up_${index}`,
          custom_id: request.custom_id,
          response: {
            status_code: 200,
            request_id: `gen-${index}`,
            body: {
              id: `gen-${index}`,
              object: "chat.completion",
              choices: [
                { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
              ],
            },
          },
          error: null,
        })),
        error: null,
      };
      decorate?.(batch, payload);
      batches.set(id, batch);
      return jsonRes(202, { id, status: "validating", usage: null, results: null });
    }
    if (url.includes("?")) {
      return jsonRes(200, { data: [...batches.values()] });
    }
    const id = decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
    const batch = batches.get(id);
    if (batch === undefined) {
      return new Response("Not Found", { status: 404 });
    }
    return jsonRes(200, { object: "batch", completion_window: "24h", ...batch });
  };
  return { calls, fetchImpl };
};

const rowErrorCode = (row: BatchResultRow | undefined): unknown => {
  const error = row?.error;
  if (error === null || typeof error !== "object") {
    return undefined;
  }
  return "code" in error ? error.code : undefined;
};

const assertXor = (row: BatchResultRow): void => {
  assert.notEqual(row.response === null, row.error === null, "response XOR error must hold");
};

const postCalls = (calls: readonly RecordedCall[]): RecordedCall[] =>
  calls.filter((call) => call.method === "POST");

const TERMINAL_ROW_CODE = {
  failed: SPILL_ROW_ERROR_CODES.batchFailed,
  expired: SPILL_ROW_ERROR_CODES.batchExpired,
  cancelled: SPILL_ROW_ERROR_CODES.batchCancelled,
} as const;

/** Real-timer + microtask drain: proves no task keeps running after a settled rejection. */
const drainSettle = async (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 25);
  await promise;
  for (let i = 0; i < 50; i += 1) {
    await Promise.resolve();
  }
};

describe("openrouter batch spill", () => {
  it("orders endpoint/model/completion_window before requests and omits provider by default", async () => {
    const upstream = createUpstream();
    const store = intentStore();
    const result = await openRouterBatchSpill(spillOptions(upstream.fetchImpl, store)).spill([
      item(1),
    ]);

    const posts = postCalls(upstream.calls);
    assert.equal(posts.length, 1);
    const post = posts[0];
    assert.ok(post !== undefined, "expected exactly one submit");
    const raw = post.body;
    assert.ok(raw !== null);
    const order = ['"endpoint"', '"model"', '"completion_window"', '"requests"'].map((token) =>
      raw.indexOf(token),
    );
    assert.ok(
      order.every((index) => index >= 0),
      `missing wire key in ${raw}`,
    );
    let previousKeyIndex = Number.NEGATIVE_INFINITY;
    for (const keyIndex of order) {
      assert.ok(keyIndex > previousKeyIndex, `wire keys out of order: ${raw}`);
      previousKeyIndex = keyIndex;
    }
    assert.ok(!raw.includes('"provider"'), "provider must be omitted unless configured");

    const payload = JSON.parse(raw) as SubmittedPayload;
    assert.equal(payload.endpoint, "/v1/chat/completions");
    assert.equal(payload.model, "openai/gpt-4o");
    assert.equal(payload.completion_window, "24h");
    assert.equal(payload.requests.length, 1);
    const firstRequest = payload.requests[0];
    assert.ok(firstRequest !== undefined);
    assert.equal(firstRequest.custom_id, "batch_req_1");
    assert.deepEqual(firstRequest.body.messages, [{ role: "user", content: "m1" }]);

    assert.equal(post.url, "https://openrouter.ai/api/v1/batches");
    assert.equal(post.headers.authorization, "Bearer sk-test");
    const gets = upstream.calls.filter((call) => call.method === "GET");
    assert.ok(gets.every((call) => call.url.startsWith("https://openrouter.ai/api/v1/batches/")));
    assert.ok(gets.every((call) => call.headers.authorization === "Bearer sk-test"));

    // custom_id round trip: we submit our globally unique item id, rows come back keyed by it,
    // and the served row restores the caller's custom_id with our item id as the row id.
    assert.equal(result.rows.length, 1);
    const firstRow = result.rows[0];
    assert.ok(firstRow !== undefined);
    assert.equal(firstRow.id, "batch_req_1");
    assert.equal(firstRow.custom_id, "caller-1");
    assertXor(firstRow);
    assert.deepEqual(result.groups, [
      {
        remoteBatchId: "batch_1",
        itemIds: ["batch_req_1"],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
          cost: 0.001,
          is_byok: false,
        },
      },
    ]);
    assert.deepEqual(store.events, ["confirm:batch_1"]);
    assert.equal(store.states.size, 1);
    // Exact item assignment travels on the intent for beginRemote persistence.
    const intent = store.intents[0];
    assert.ok(intent !== undefined);
    assert.deepEqual(intent.itemIds, ["batch_req_1"]);
    const state = [...store.states.values()][0];
    assert.ok(state !== undefined);
    assert.equal(state.phase, "submitted");
  });

  it("places an explicit provider pin before requests, strips :batch ids, honors the beta base path", async () => {
    const upstream = createUpstream();
    const store = intentStore();
    const spill = openRouterBatchSpill(
      spillOptions(upstream.fetchImpl, store, {
        providerOnly: ["openai"],
        basePath: OPENROUTER_BATCH_BETA_BASE_PATH,
      }),
    );
    await spill.spill([
      item(1, {
        model: "z-ai/glm-5.3-flash:batch",
        body: {
          model: "z-ai/glm-5.3-flash:batch",
          // Sync-encoder routing fields batch rejects — must never reach the wire and must
          // not override the selected deployment pin.
          provider: { allow_fallbacks: false, require_parameters: true, only: ["mistral"] },
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 32,
        },
      }),
    ]);

    const posts = postCalls(upstream.calls);
    assert.equal(posts.length, 1);
    const post = posts[0];
    assert.ok(post !== undefined, "expected exactly one submit");
    const raw = post.body;
    assert.ok(raw !== null);
    const order = ['"endpoint"', '"model"', '"provider"', '"completion_window"', '"requests"'].map(
      (token) => raw.indexOf(token),
    );
    assert.ok(
      order.every((index) => index >= 0),
      `missing wire key in ${raw}`,
    );
    let previousKeyIndex = Number.NEGATIVE_INFINITY;
    for (const keyIndex of order) {
      assert.ok(keyIndex > previousKeyIndex, `wire keys out of order: ${raw}`);
      previousKeyIndex = keyIndex;
    }
    const payload = JSON.parse(raw) as SubmittedPayload & { provider: unknown };
    assert.equal(payload.model, "z-ai/glm-5.3-flash");
    assert.deepEqual(payload.provider, { only: ["openai"] });
    // Per-request bodies never carry model or sync routing-only provider on the wire — they
    // inherit the batch-level model, and batch-level provider.only is the sole pin.
    const firstRequest = payload.requests[0];
    assert.ok(firstRequest !== undefined);
    assert.equal(firstRequest.body.model, undefined);
    assert.equal(firstRequest.body.provider, undefined);

    assert.equal(post.url, "https://openrouter.ai/api/beta/batches");

    // :batch variant resolution: we always send base ids; OpenRouter resolves the variant
    // endpoints server-side (no :batch endpoint → 400 at submit).
    assert.equal(openRouterBatchModelId("z-ai/glm-5.3-flash:batch"), "z-ai/glm-5.3-flash");
    assert.equal(openRouterBatchModelId("openai/gpt-4o"), "openai/gpt-4o");
    assert.equal(openRouterBatchModelId("  z-ai/glm-5.3:batch "), "z-ai/glm-5.3");
  });

  it("splits one upstream batch per compatibility key including the Google response_format rule", async () => {
    const schemaA = {
      type: "json_schema",
      json_schema: {
        name: "alpha",
        schema: { type: "object", properties: { a: { type: "string" } } },
      },
    };
    const schemaAFlipped = {
      json_schema: {
        schema: { properties: { a: { type: "string" } }, type: "object" },
        name: "alpha",
      },
      type: "json_schema",
    };
    const schemaB = {
      type: "json_schema",
      json_schema: {
        name: "beta",
        schema: { type: "object", properties: { b: { type: "number" } } },
      },
    };
    const jsonObject = { type: "json_object" };
    const withFormat = (n: number, model: string, response_format: unknown, reasoning: unknown) =>
      item(n, {
        model,
        body: {
          model,
          messages: [{ role: "user", content: `m${n}` }],
          max_tokens: 64,
          response_format,
          reasoning,
        },
      });

    const items = [
      withFormat(1, "openai/gpt-4o", schemaA, { effort: "low" }),
      // Same model/shapes as item 1 but a different deployment: never merged, so one group
      // is always one deployment under one provider pin.
      {
        ...withFormat(2, "openai/gpt-4o", schemaAFlipped, { effort: "low" }),
        deploymentId: "dep-b",
      },
      withFormat(3, "openai/gpt-4o", schemaA, { effort: "high" }),
      withFormat(4, "openai/gpt-4o", jsonObject, { effort: "low" }),
      withFormat(5, "z-ai/glm-5.3", schemaA, { effort: "low" }),
      withFormat(7, "google/gemini-2.5-pro", schemaA, { effort: "low" }),
      withFormat(8, "google/gemini-2.5-pro", schemaAFlipped, { effort: "low" }),
      withFormat(9, "google/gemini-2.5-pro", schemaB, { effort: "low" }),
      item(10, {
        model: "google/gemini-2.5-pro",
        body: {
          model: "google/gemini-2.5-pro",
          messages: [{ role: "user", content: "m10" }],
          max_tokens: 64,
        },
      }),
    ];

    const upstream = createUpstream();
    const store = intentStore();
    const result = await openRouterBatchSpill(spillOptions(upstream.fetchImpl, store)).spill(items);

    const posts = postCalls(upstream.calls);
    assert.equal(posts.length, 8);
    const groups = posts
      .map((post) => {
        const payload = JSON.parse(post.body ?? "{}") as SubmittedPayload;
        return {
          model: payload.model,
          ids: payload.requests.map((request) => request.custom_id).sort(),
        };
      })
      .sort((a, b) => a.ids.join("\0").localeCompare(b.ids.join("\0")));
    const expected = [
      ["batch_req_1"],
      ["batch_req_2"],
      ["batch_req_3"],
      ["batch_req_4"],
      ["batch_req_5"],
      ["batch_req_7", "batch_req_8"],
      ["batch_req_9"],
      ["batch_req_10"],
    ].sort((a, b) => a.join("\0").localeCompare(b.join("\0")));
    assert.deepEqual(
      groups.map((group) => group.ids),
      expected,
    );
    // Same-schema groups merge despite key order (Google's uniformity rule is satisfied by
    // the split: one schema per batch, and every Google request lives in a uniform group).
    const googleGroups = groups.filter((group) => group.model === "google/gemini-2.5-pro");
    assert.equal(googleGroups.length, 3);
    assert.equal(groups.filter((group) => group.model === "z-ai/glm-5.3").length, 1);

    assert.equal(result.rows.length, items.length);
    assert.deepEqual(
      result.rows.map((row) => row.id),
      items.map((entry) => entry.id),
    );
    // Job-level usage aggregates only when every remote batch reported it: seven identical
    // usage records sum exactly; cost and is_byok ride at batch level only.
    assert.deepEqual(result.usage, {
      prompt_tokens: 80,
      completion_tokens: 40,
      total_tokens: 120,
      cost: 0.008,
      is_byok: false,
    });
    // One absolute fact set per proven batch: per-group usage persists exactly once (keyed
    // by remoteBatchId) and every item id is attributed to exactly one group.
    assert.equal(result.groups.length, 8);
    for (const group of result.groups) {
      assert.ok(group.remoteBatchId.startsWith("batch_"));
      assert.deepEqual(group.usage, {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        cost: 0.001,
        is_byok: false,
      });
    }
    assert.deepEqual(
      result.groups
        .flatMap((group) => [...group.itemIds])
        .slice()
        .sort(),
      items
        .map((entry) => entry.id)
        .slice()
        .sort(),
    );
  });

  it("keeps batch-level BYOK unknown when one completed compatibility group lacks it", async () => {
    const upstream = createUpstream((batch) => {
      if (batch.id === "batch_1") {
        batch.usage = {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
          cost: 0.001,
          is_byok: null,
        };
      }
    });
    const result = await openRouterBatchSpill(
      spillOptions(upstream.fetchImpl, intentStore()),
    ).spill([
      item(1, {
        body: {
          ...(item(1).body as Record<string, unknown>),
          response_format: { type: "json_object" },
        },
      }),
      item(2),
    ]);
    assert.equal(postCalls(upstream.calls).length, 2);
    assert.equal(result.rows.length, 2);
    assert.deepEqual(
      result.groups.map((group) => group.usage?.is_byok),
      [null, false],
    );
    assert.deepEqual(result.usage, {
      prompt_tokens: 20,
      completion_tokens: 10,
      total_tokens: 30,
      cost: 0.002,
      is_byok: null,
    });
    assert.equal(
      aggregateBatchUsage([
        { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0, is_byok: true },
        { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0, is_byok: false },
      ])?.is_byok,
      null,
    );
  });

  it("maps failed/expired/cancelled terminals to one error row per item", async () => {
    for (const terminal of ["failed", "expired", "cancelled"] as const) {
      const upstream = createUpstream((batch) => {
        batch.status = terminal;
        batch.usage = null;
        batch.results = null;
        batch.error = { message: `${terminal} upstream`, detail: { ignored: true } };
      });
      const store = intentStore();
      const result = await openRouterBatchSpill(spillOptions(upstream.fetchImpl, store)).spill([
        item(1),
        item(2),
      ]);
      assert.equal(result.rows.length, 2);
      for (const row of result.rows) {
        assertXor(row);
        assert.equal(row.response, null);
        const error = row.error as Record<string, unknown>;
        assert.equal(error.code, TERMINAL_ROW_CODE[terminal]);
        assert.equal(error.message, `${terminal} upstream`);
        assert.equal(error.batch_id, "batch_1");
      }
      // Unknown ≠ zero: a failed batch reports no usage, so job usage stays unknown.
      assert.equal(result.usage, null);
    }
  });

  it("normalizes completed result rows defensively and enforces response XOR error", async () => {
    const upstream = createUpstream((batch, payload) => {
      const ids = payload.requests.map((request) => request.custom_id);
      batch.results = [
        // Success row whose chat body omits usage (unconfirmed upstream per research Q2).
        {
          id: "up_1",
          custom_id: ids[0],
          response: {
            status_code: 200,
            request_id: "gen-1",
            body: { id: "gen-1", object: "chat.completion", choices: [] },
          },
          error: null,
        },
        // Error row with undocumented, unknown fields.
        {
          id: "up_2",
          custom_id: ids[1],
          response: null,
          error: { code: "provider_error", message: "boom", nested: { weird: [1, 2] } },
        },
        // Clean success row (conflicting/foreign/duplicated rows are rejected upstream of
        // here as protocol errors — covered by the protocol-errors test).
        {
          id: "up_3",
          custom_id: ids[2],
          response: { status_code: 200, request_id: null, body: { choices: [] } },
          error: null,
        },
        // Neither side populated.
        { id: "up_4", custom_id: ids[3], response: null, error: null },
        // Unattributable garbage: no custom_id.
        { id: "up_5", response: { status_code: 200 }, error: null },
      ];
      batch.usage = null;
    });
    const store = intentStore();
    const result = await openRouterBatchSpill(spillOptions(upstream.fetchImpl, store)).spill([
      item(1),
      item(2),
      item(3),
      item(4),
      item(5),
    ]);

    assert.equal(result.rows.length, 5);
    const rows = new Map(result.rows.map((row) => [row.id, row]));
    for (const row of result.rows) {
      assertXor(row);
    }

    const success = rows.get("batch_req_1");
    assert.ok(success !== null && success !== undefined);
    assert.equal(success.response?.status_code, 200);
    assert.deepEqual(success.response?.body, {
      id: "gen-1",
      object: "chat.completion",
      choices: [],
    });

    const errored = rows.get("batch_req_2");
    assert.ok(errored !== null && errored !== undefined);
    assert.deepEqual(errored.error, {
      code: "provider_error",
      message: "boom",
      nested: { weird: [1, 2] },
    });

    const conflicted = rows.get("batch_req_3");
    assert.ok(conflicted !== null && conflicted !== undefined);
    assert.equal(conflicted.response?.status_code, 200);
    assert.equal(conflicted.error, null);

    const empty = rows.get("batch_req_4");
    assert.ok(empty !== null && empty !== undefined);
    assert.equal(rowErrorCode(empty), SPILL_ROW_ERROR_CODES.emptyResultRow);

    // The garbage row cannot be attributed, so its item falls back to missing_result_row.
    const missing = rows.get("batch_req_5");
    assert.ok(missing !== null && missing !== undefined);
    assert.equal(rowErrorCode(missing), SPILL_ROW_ERROR_CODES.missingResultRow);

    // Batch-level usage absent → unknown, never zero.
    assert.equal(result.usage, null);
  });

  it("fails closed on ambiguous contact: no list lookups, no lookalike adoption, no re-posts", async () => {
    const calls: RecordedCall[] = [];
    const batches = new Map<string, FakeBatch>();
    const fetchImpl: FetchImpl = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? init.body : null;
      calls.push({ method, url, body, headers: (init?.headers ?? {}) as Record<string, string> });
      if (method === "POST") {
        const payload = JSON.parse(body ?? "{}") as SubmittedPayload;
        // Server-side a perfectly matching batch exists before the response is lost —
        // similarity would attribute it to us, and that is exactly what must never happen.
        batches.set("batch_1", {
          id: "batch_1",
          status: "completed",
          model: payload.model,
          endpoint: payload.endpoint,
          created_at: Math.floor(Date.now() / 1000),
          request_counts: {
            total: payload.requests.length,
            completed: payload.requests.length,
            failed: 0,
          },
          usage: null,
          results: [],
          error: null,
        });
        throw new TypeError("socket hang up");
      }
      return jsonRes(200, { data: [...batches.values()] }); // would answer a list query
    };

    const store = intentStore();
    const spill = openRouterBatchSpill(spillOptions(fetchImpl, store));
    await assert.rejects(spill.spill([item(1), item(2)]), BatchSubmitUnknown);

    assert.equal(postCalls(calls).length, 1, "never re-post after ambiguous contact");
    assert.deepEqual(
      calls.filter((call) => call.method === "GET"),
      [],
      "list similarity can never prove ownership: zero GETs",
    );
    assert.deepEqual(store.events, [], "intent stays unresolved — no confirm, no abandon");
    const pendingState = [...store.states.values()][0];
    assert.ok(pendingState !== undefined);
    assert.equal(pendingState.phase, "prepared");

    // The ambiguous intent is kept indefinitely; later attempts fail closed without POST/GET.
    const retry = await spill.spill([item(1), item(2)]).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(retry instanceof BatchSubmitUnknown);
    assert.ok(retry.message.includes("never confirmed"));
    assert.equal(postCalls(calls).length, 1);
    assert.deepEqual(store.events, []);
  });

  it("settles every group before rejecting: original error kept, no late confirm or fetch", async () => {
    const store = intentStore();
    const calls: RecordedCall[] = [];
    let stallObservations = 0;
    const fetchImpl: FetchImpl = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? init.body : null;
      calls.push({ method, url, body, headers: (init?.headers ?? {}) as Record<string, string> });
      if (method === "POST") {
        const payload = JSON.parse(body ?? "{}") as SubmittedPayload;
        if (payload.requests.some((request) => request.custom_id === "batch_req_2")) {
          // Gate the definitive 400 on the sibling's confirm so the stall group is provably
          // confirmed-and-polling before the rejection that must abort it.
          for (
            let spin = 0;
            spin < 10_000 && !store.events.includes("confirm:batch_1");
            spin += 1
          ) {
            await Promise.resolve();
          }
          return jsonRes(400, { error: { message: "one group is definitively refused" } });
        }
        return jsonRes(202, { id: "batch_1", status: "validating", usage: null, results: null });
      }
      // Confirmed sibling: never terminal — it must be aborted, not left polling.
      stallObservations += 1;
      return jsonRes(200, {
        id: "batch_1",
        status: "in_progress",
        usage: null,
        results: null,
        error: null,
      });
    };

    // Two compatibility groups: item 1 carries a response_format, item 2 does not.
    const groupA = item(1, {
      body: {
        model: "openai/gpt-4o",
        messages: [{ role: "user", content: "a" }],
        max_tokens: 16,
        response_format: { type: "json_object" },
      },
    });
    const failure = await openRouterBatchSpill(spillOptions(fetchImpl, store))
      .spill([groupA, item(2)])
      .then(
        () => null,
        (error: unknown) => error,
      );

    // Original rejection retained — never replaced by the sibling's abort.
    assert.ok(failure instanceof BatchSubmitRejected);
    assert.equal(failure.status, 400);
    const eventsAtRejection = [...store.events].sort();
    assert.deepEqual(eventsAtRejection, ["abandon:http_400", "confirm:batch_1"]);
    const phasesAtRejection = [...store.states.values()].map((entry) => entry.phase);
    assert.deepEqual(phasesAtRejection, ["submitted"]);
    const callsAtRejection = calls.length;
    const stallsAtRejection = stallObservations;
    assert.ok(stallsAtRejection >= 1, "the confirmed sibling was polling before rejection");

    await drainSettle();

    // The boundary is settled: nothing runs after rejection — no further fetches, no live
    // body observation, no late confirmation, no intent mutation (no automatic repost).
    assert.equal(calls.length, callsAtRejection, "no live polling task after rejection");
    assert.equal(stallObservations, stallsAtRejection, "no live body after rejection");
    assert.deepEqual([...store.events].sort(), eventsAtRejection, "no late confirmation");
    assert.deepEqual(
      [...store.states.values()].map((entry) => entry.phase),
      phasesAtRejection,
      "no intent mutation after rejection",
    );
    assert.equal(store.states.size, 1, "only the confirmed intent survives");
  });

  it("abandons a definitive 4xx submit with the typed BatchSubmitRejected", async () => {
    const fetchImpl: FetchImpl = async (input, init) => {
      if ((init?.method ?? "GET") === "POST") {
        return jsonRes(400, { error: { message: "requests must come last" } });
      }
      return jsonRes(200, { data: [] });
    };
    const store = intentStore();
    await assert.rejects(
      openRouterBatchSpill(spillOptions(fetchImpl, store)).spill([item(1)]),
      BatchSubmitRejected,
    );
    assert.deepEqual(store.events, ["abandon:http_400"], "4xx is the only abandon path");
    assert.equal(store.states.size, 0, "rejected intents clear so a retry may submit fresh");
    const rejected = await openRouterBatchSpill(spillOptions(fetchImpl, intentStore()))
      .spill([item(1)])
      .then(
        () => null,
        (error: unknown) => error,
      );
    assert.ok(rejected instanceof BatchSubmitRejected);
    assert.equal(rejected.status, 400);
    assert.ok(rejected.detail?.includes("requests must come last"));
  });

  it("backs off from 30s to the 5min cap and harvests the completed observation once", async () => {
    const statuses = [
      "validating",
      "in_progress",
      "in_progress",
      null, // transient upstream 500
      "in_progress",
      "finalizing",
      "finalizing",
      "finalizing",
      "completed",
    ];
    const calls: RecordedCall[] = [];
    let detailObservations = 0;
    const fetchImpl: FetchImpl = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({
        method,
        url,
        body: typeof init?.body === "string" ? init.body : null,
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      if (method === "POST") {
        return jsonRes(202, { id: "batch_1", status: "validating", usage: null, results: null });
      }
      const status = statuses[detailObservations];
      detailObservations += 1;
      if (status === null) {
        return new Response("upstream exploded", { status: 500 });
      }
      return jsonRes(200, {
        id: "batch_1",
        object: "batch",
        endpoint: "/v1/chat/completions",
        model: "openai/gpt-4o",
        completion_window: "24h",
        status,
        created_at: Math.floor(Date.now() / 1000),
        request_counts: { total: 1, completed: status === "completed" ? 1 : 0, failed: 0 },
        usage:
          status === "completed"
            ? {
                prompt_tokens: 10,
                completion_tokens: 5,
                total_tokens: 15,
                cost: 0.001,
                is_byok: false,
              }
            : null,
        results:
          status === "completed"
            ? [
                {
                  id: "up_1",
                  custom_id: "batch_req_1",
                  response: { status_code: 200, request_id: "gen", body: { choices: [] } },
                  error: null,
                },
              ]
            : null,
        error: null,
      });
    };

    const store = intentStore();
    const recorder = sleepRecorder();
    const result = await openRouterBatchSpill(
      spillOptions(fetchImpl, store, { sleep: recorder.sleep }),
    ).spill([item(1)]);

    assert.deepEqual(
      recorder.delays,
      [30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000, 300_000],
    );
    assert.ok(recorder.delays.every((delay) => delay <= 300_000));
    assert.equal(detailObservations, statuses.length, "poll stops at the terminal observation");
    // Inline results: the completed observation carries them; no extra fetch happens after it.
    assert.equal(calls.filter((call) => call.method === "GET").length, statuses.length);
    assert.equal(result.rows.length, 1);
    const firstRow = result.rows[0];
    assert.ok(firstRow !== undefined);
    assertXor(firstRow);
    assert.equal(firstRow.response?.status_code, 200);
    assert.deepEqual(result.usage, {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      cost: 0.001,
      is_byok: false,
    });
  });

  it("rejects conflicting, foreign, and duplicated result rows as protocol errors", async () => {
    const upstreamWith = (buildRows: (ids: readonly string[]) => readonly unknown[]) =>
      createUpstream((batch, payload) => {
        batch.results = buildRows(payload.requests.map((request) => request.custom_id));
      });
    const success = (customId: string): Record<string, unknown> => ({
      id: "up",
      custom_id: customId,
      response: { status_code: 200, request_id: null, body: {} },
      error: null,
    });

    const duplicate = upstreamWith((ids) => {
      const firstId = ids[0];
      assert.ok(firstId !== undefined);
      return [success(firstId), success(firstId)];
    });
    await assert.rejects(
      openRouterBatchSpill(spillOptions(duplicate.fetchImpl, intentStore())).spill([
        item(1),
        item(2),
      ]),
      BatchProtocolError,
    );

    const conflict = upstreamWith((ids) => {
      const firstId = ids[0];
      assert.ok(firstId !== undefined);
      return [{ ...success(firstId), error: { code: "x" } }];
    });
    await assert.rejects(
      openRouterBatchSpill(spillOptions(conflict.fetchImpl, intentStore())).spill([item(1)]),
      BatchProtocolError,
    );

    const foreign = upstreamWith(() => [success("batch_req_ghost")]);
    const failure = await openRouterBatchSpill(spillOptions(foreign.fetchImpl, intentStore()))
      .spill([item(1)])
      .then(
        () => null,
        (error: unknown) => error,
      );
    assert.ok(failure instanceof BatchProtocolError);
    assert.equal(failure.reason, "foreign_custom_id");
  });

  it("never re-posts a confirmed intent across repeated spills and still redelivers rows", async () => {
    const upstream = createUpstream();
    const store = intentStore();
    const spill = openRouterBatchSpill(spillOptions(upstream.fetchImpl, store));
    const first = await spill.spill([item(1), item(2)]);
    const second = await spill.spill([item(1), item(2)]);

    assert.equal(postCalls(upstream.calls).length, 1, "second spill reuses the confirmed id");
    assert.deepEqual(store.events, ["confirm:batch_1"], "confirm runs exactly once");
    assert.equal(first.rows.length, 2);
    assert.equal(second.rows.length, 2, "rows redeliver for a caller that lost the first result");
    assert.deepEqual(
      second.rows.map((row) => row.custom_id),
      first.rows.map((row) => row.custom_id),
    );
  });

  it("pollKnown resumes a confirmed batch without any POST or new intent", async () => {
    const upstream = createUpstream();
    const store = intentStore();
    const spill = openRouterBatchSpill(spillOptions(upstream.fetchImpl, store));
    const first = await spill.spill([item(1), item(2)]);
    const resumed = await spill.pollKnown("batch_1", [item(1), item(2)], Date.now() + 60_000);

    assert.equal(postCalls(upstream.calls).length, 1, "resume never submits again");
    assert.equal(store.intents.length, 1, "resume never mints a new intent");
    assert.deepEqual(
      resumed,
      first,
      "terminal facts are absolute: identical on every resume (replace, never accumulate)",
    );
  });

  it("rejects a polled batch whose id does not equal the requested proven id", async () => {
    const fetchImpl: FetchImpl = async (input, init) => {
      if ((init?.method ?? "GET") === "POST") {
        return jsonRes(202, { id: "batch_1", status: "validating", usage: null, results: null });
      }
      return jsonRes(200, {
        id: "batch_evil",
        status: "in_progress",
        usage: { prompt_tokens: 9, completion_tokens: 9, total_tokens: 18 },
        results: [],
        error: null,
      });
    };
    const store = intentStore();
    const failure = await openRouterBatchSpill(spillOptions(fetchImpl, store))
      .spill([item(1)])
      .then(
        () => null,
        (error: unknown) => error,
      );
    assert.ok(failure instanceof BatchProtocolError);
    assert.equal(failure.reason, "id_mismatch");
    // The proven confirmed id is never replaced by whatever the wrong response claimed.
    assert.deepEqual(store.events, ["confirm:batch_1"]);
    const state = [...store.states.values()][0];
    assert.ok(state !== undefined);
    if (state.phase === "submitted") {
      assert.equal(state.remoteBatchId, "batch_1");
    } else {
      assert.fail("confirmed intent must stay submitted");
    }
  });

  it("bounds a stalled response body: the reader is cancelled, the poll window ends it", async () => {
    let cancels = 0;
    const fetchImpl: FetchImpl = async (input, init) => {
      if ((init?.method ?? "GET") === "POST") {
        return jsonRes(202, { id: "batch_1", status: "validating", usage: null, results: null });
      }
      // Headers arrive, then the body never produces a byte — only the composed per-request
      // signal's reader.cancel() can settle this read.
      return new Response(
        new ReadableStream<Uint8Array>({
          pull() {
            return new Promise<never>(() => {});
          },
          cancel() {
            cancels += 1;
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const store = intentStore();
    await assert.rejects(
      openRouterBatchSpill(
        spillOptions(fetchImpl, store, { requestTimeoutMs: 20, pollWindowMs: 60 }),
      ).spill([item(1)]),
      BatchPollFailed,
    );
    assert.ok(cancels >= 1, "stalled body reader must be cancelled, never leaked");
  });

  it("surfaces banned items as failed rows before any submit", async () => {
    const upstream = createUpstream();
    const store = intentStore();
    const result = await openRouterBatchSpill(spillOptions(upstream.fetchImpl, store)).spill([
      item(1),
      item(2, {
        body: { model: "openai/gpt-4o", messages: [{ role: "user", content: "x" }], stream: true },
      }),
      item(3, {
        body: { model: "openai/gpt-4o", messages: [{ role: "user", content: "x" }], max_tokens: 0 },
      }),
      item(4, { body: { model: "openai/gpt-4o", messages: [] } }),
      item(5, {
        body: { model: "mistral/mistral-large", messages: [{ role: "user", content: "x" }] },
      }),
    ]);

    const posts = postCalls(upstream.calls);
    assert.equal(posts.length, 1, "banned items never reach the wire");
    const post = posts[0];
    assert.ok(post !== undefined, "banned items never reach the wire");
    const payload = JSON.parse(post.body ?? "{}") as SubmittedPayload;
    assert.deepEqual(
      payload.requests.map((request) => request.custom_id),
      ["batch_req_1"],
    );
    // Bodies inherit the batch-level model; the disagreeing body never makes the wire.
    const firstRequest = payload.requests[0];
    assert.ok(firstRequest !== undefined);
    assert.equal(firstRequest.body.model, undefined);

    assert.equal(result.rows.length, 5);
    const rows = new Map(result.rows.map((row) => [row.id, row]));
    assert.equal(rowErrorCode(rows.get("batch_req_1")), undefined);
    assert.equal(rowErrorCode(rows.get("batch_req_2")), SPILL_ROW_ERROR_CODES.streamNotSupported);
    assert.equal(rowErrorCode(rows.get("batch_req_3")), SPILL_ROW_ERROR_CODES.maxTokensBelowOne);
    assert.equal(rowErrorCode(rows.get("batch_req_4")), SPILL_ROW_ERROR_CODES.emptyMessages);
    assert.equal(rowErrorCode(rows.get("batch_req_5")), SPILL_ROW_ERROR_CODES.modelMismatch);
    for (const row of result.rows) {
      assertXor(row);
    }
  });

  it("never posts when every item is banned, including the max_completion_tokens dialect", async () => {
    const upstream = createUpstream();
    const store = intentStore();
    const result = await openRouterBatchSpill(spillOptions(upstream.fetchImpl, store)).spill([
      item(1, {
        body: {
          model: "openai/gpt-4o",
          messages: [{ role: "user", content: "x" }],
          max_completion_tokens: 0,
        },
      }),
      item(2, {
        body: { model: "openai/gpt-4o", messages: [{ role: "user", content: "x" }], stream: true },
      }),
    ]);

    assert.equal(postCalls(upstream.calls).length, 0);
    assert.equal(result.rows.length, 2);
    assert.equal(rowErrorCode(result.rows[0]), SPILL_ROW_ERROR_CODES.maxTokensBelowOne);
    assert.equal(rowErrorCode(result.rows[1]), SPILL_ROW_ERROR_CODES.streamNotSupported);
    assert.equal(result.usage, null);
    assert.deepEqual(result.groups, []);
    assert.equal(store.events.length, 0, "no intent is recorded when nothing submits");
  });

  it("fails typed when polling is rejected, keeping the confirmed intent", async () => {
    const fetchImpl: FetchImpl = async (input, init) => {
      if ((init?.method ?? "GET") === "POST") {
        return jsonRes(202, { id: "batch_1", status: "validating", usage: null, results: null });
      }
      return new Response("Unauthorized", { status: 401 });
    };
    const store = intentStore();
    await assert.rejects(
      openRouterBatchSpill(spillOptions(fetchImpl, store)).spill([item(1)]),
      BatchPollFailed,
    );
    assert.deepEqual(store.events, ["confirm:batch_1"], "the confirmed id survives a poll failure");
    const state = [...store.states.values()][0];
    assert.ok(state !== undefined);
    if (state.phase === "submitted") {
      assert.equal(state.remoteBatchId, "batch_1");
    } else {
      assert.fail("confirmed intent must stay submitted");
    }
  });
});
