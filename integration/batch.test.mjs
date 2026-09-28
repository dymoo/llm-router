// Production-process HTTP regression for the batch surface.
//
// Runs the REAL built Next gateway, real SQLite control plane, real private content store,
// real Router, and the real scheduler/adapter wiring. Local fake HTTP peers (chat, OpenRouter
// batch API) are protocol peers only. A NODE_OPTIONS import in the child gateway rejects any
// fetch that leaves loopback, so no external endpoint and no paid/provider call can happen
// even if wiring regresses; OPENROUTER_API_KEY is a fake value. No generation-quality claim
// is made anywhere in this file.
//
// Determinism rules: explicit fixture entry/release promises gate interactive generations;
// bounded polling waits on job status and fixture observations; the only time-travel is a
// direct UPDATE of spill_at in this test's own temporary ledger (due-time explicitly
// simulated — no clock, env or router change). Cleanup is centralized and robust to
// mid-test failure.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createServer as createPortReservation } from "node:net";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import test, { after, before } from "node:test";

const SPILL_WINDOW_SECONDS = 24 * 60 * 60;
const FAKE_OPENROUTER_KEY = "test-openrouter-key";

const state = {
  directory: "",
  origin: "",
  port: 0,
  databasePath: "",
  resultsDir: "",
  gatewayEnv: null,
  child: null,
  exited: null,
  logs: "",
  fixture: null,
  // Interactive hold currently owed to the fixture, if any.
  hold: null,
  // Fixture observations.
  batchChat: [], // chat completions whose marker starts with "batch-"
  openRouter: { posts: [], gets: [], listGets: 0, mode: "accept", holdGet: null },
  peer: { chatPosts: 0, unexpectedPosts: [] },
  nextRemoteId: 0,
  keys: null,
  // Cross-test handoff: the completed local job owned by the first key.
  mainJobId: "",
};

async function listen(server) {
  const listening = Promise.withResolvers();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

async function close(server) {
  const closed = Promise.withResolvers();
  server.close(closed.resolve);
  await closed.promise;
}

/** Layout-agnostic view of the private content store: every artifact this job owns.
 * The store layout is owned by src/batch/results.ts and may change; only presence or
 * absence of this job's bytes is asserted, never file names. */
async function storeEntries(jobId) {
  return (await readdir(state.resultsDir)).filter((name) => name.startsWith(jobId));
}

/** Failure-only, bounded metadata snapshot. Never include stored inputs, auth headers or raw logs. */
async function timeoutDiagnostics() {
  const jobs = query(
    `SELECT id, status, spill_at, spill_at + completion_window_ms AS deadline,
      error_code FROM batch_jobs ORDER BY created_at DESC LIMIT 8`,
  );
  const items = query(
    `SELECT i.job_id, i.status, i.request_id, i.deployment_id, i.error_code,
      r.status AS request_status, r.deferred, r.error_code AS request_error
     FROM batch_items i LEFT JOIN requests r ON r.id = i.request_id
     ORDER BY i.created_at DESC LIMIT 16`,
  );
  const requests = query(
    `SELECT id, status, deferred, deployment_id, error_code
     FROM requests ORDER BY started_at DESC LIMIT 16`,
  );
  const resultFiles = await Promise.all(
    jobs.map(async ({ id }) => ({ jobId: id, count: (await storeEntries(id)).length })),
  );
  const childLogSignals =
    state.logs.match(/\b(?:ERR_[A-Z_]+|SQLITE_[A-Z_]+|provider_failure)\b/g)?.slice(-12) ?? [];
  return JSON.stringify({
    jobs,
    items,
    requests,
    resultFiles,
    peer: {
      ...state.peer,
      batchChatCount: state.batchChat.length,
      remotePosts: state.openRouter.posts.length,
      remoteGets: state.openRouter.gets.length,
      remoteListGets: state.openRouter.listGets,
    },
    childLogSignals,
  });
}

/** Bounded polling: resolve on truthy, keep the last failure for the timeout message. */
async function until(label, fn, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
      last = value;
    } catch (error) {
      last = error;
    }
    if (Date.now() >= deadline) {
      const diagnostics = await timeoutDiagnostics();
      const lastState = last instanceof Error ? last.name : last === false ? "false" : typeof last;
      assert.fail(`timed out waiting for ${label}: ${lastState}\n${diagnostics}`);
    }
    await delay(50, undefined, { signal });
  }
}

function query(sql, ...params) {
  const database = new DatabaseSync(state.databasePath, { readOnly: true });
  try {
    return database.prepare(sql).all(...params);
  } finally {
    database.close();
  }
}

/** Due-time simulation: advance ONLY this test's isolated ledger row. */
async function makeSpillDue(jobId) {
  const past = Date.now() - 1000;
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const database = new DatabaseSync(state.databasePath);
      try {
        database.prepare("UPDATE batch_jobs SET spill_at = ? WHERE id = ?").run(past, jobId);
      } finally {
        database.close();
      }
      return;
    } catch (error) {
      lastError = error;
      await delay(50);
    }
  }
  throw lastError;
}

function spawnGateway() {
  const exited = Promise.withResolvers();
  const child = spawn(
    process.execPath,
    [
      "node_modules/next/dist/bin/next",
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(state.port),
    ],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env: state.gatewayEnv },
  );
  child.stdout.on("data", (chunk) => {
    state.logs = (state.logs + chunk).slice(-20_000);
  });
  child.stderr.on("data", (chunk) => {
    state.logs = (state.logs + chunk).slice(-20_000);
  });
  child.once("error", exited.reject);
  child.once("exit", (code, signal) => exited.resolve({ code, signal }));
  state.child = child;
  state.exited = exited;
  return { child, exited };
}

async function waitReady(signal) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      if ((await fetch(`${state.origin}/health/live`, { signal: AbortSignal.timeout(500) })).ok)
        break;
    } catch {
      /* wait for listener */
    }
    assert.ok(
      Date.now() < deadline && state.child.exitCode === null,
      `gateway not ready; exit code ${state.child.exitCode}; child signals ${JSON.stringify(state.logs.match(/\b(?:ERR_[A-Z_]+|SQLITE_[A-Z_]+)\b/g)?.slice(-12) ?? [])}`,
    );
    await delay(25, undefined, { signal });
  }
}

async function stopGateway(kind = "SIGKILL") {
  const { child, exited } = state;
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill(kind);
    await exited.promise;
  }
  state.child = null;
}

async function stopGatewayBounded(kind = "SIGTERM", timeoutMs = 15_000) {
  const { child, exited } = state;
  assert.ok(child && child.exitCode === null && child.signalCode === null);
  child.kill(kind);
  const timer = new AbortController();
  const result = await Promise.race([
    exited.promise,
    delay(timeoutMs, null, { signal: timer.signal }).catch(() => null),
  ]);
  timer.abort();
  if (result === null) {
    state.openRouter.holdGet?.release.resolve();
    await stopGateway("SIGKILL");
    assert.fail(
      `gateway did not exit within ${timeoutMs}ms after ${kind}\n${await timeoutDiagnostics()}`,
    );
  }
  state.child = null;
  return result;
}

const adminHeaders = () => ({
  "content-type": "application/json",
  origin: state.origin,
  "x-jev-admin": "1",
});

// Cloud keys: undispatched batch items may spill to the OpenRouter batch path.
const keyPolicy = { priority: "medium", cloud: true, requestsPerMinute: 60, maxConcurrent: 1 };

async function createKey(name, signal) {
  const response = await fetch(`${state.origin}/api/admin/keys`, {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({ name, expiresAt: null, policy: keyPolicy }),
    signal,
  });
  assert.equal(response.status, 201);
  const created = await response.json();
  return { id: created.key.id, secret: created.secret };
}

const authHeaders = (secret) => ({
  authorization: `Bearer ${secret}`,
  "content-type": "application/json",
});

const batchEntry = (customId, content, bodyExtras = {}) => ({
  custom_id: customId,
  body: {
    messages: [{ role: "user", content }],
    max_tokens: 64,
    ...bodyExtras,
  },
});

const batchPayload = (requests, topExtras = {}) => ({
  endpoint: "/v1/chat/completions",
  model: "auto",
  completion_window: "24h",
  requests,
  ...topExtras,
});

async function submitBatch(secret, payload, signal) {
  const response = await fetch(`${state.origin}/v1/batches`, {
    method: "POST",
    headers: authHeaders(secret),
    body: JSON.stringify(payload),
    signal,
  });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  return { status: response.status, body };
}

async function getJson(path, headers, signal) {
  const response = await fetch(`${state.origin}${path}`, { headers, signal });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  return { status: response.status, body };
}

function getBatch(id, secret, signal) {
  return getJson(`/v1/batches/${id}`, authHeaders(secret), signal);
}

async function deleteBatch(id, secret, signal) {
  const response = await fetch(`${state.origin}/v1/batches/${id}`, {
    method: "DELETE",
    headers: authHeaders(secret),
    signal,
  });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  return { status: response.status, body };
}

/** Hold an interactive generation inside the fixture until released. */
async function holdInteractive(t, secret) {
  const hold = Promise.withResolvers();
  const entered = Promise.withResolvers();
  state.hold = { entered, release: hold };
  const payload = {
    model: "auto",
    messages: [{ role: "user", content: "interactive-marker hold the line" }],
  };
  const pending = fetch(`${state.origin}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders(secret),
    body: JSON.stringify(payload),
    signal: t.signal,
  }).then(
    async (response) => ({ status: response.status, body: await response.json() }),
    (error) => ({ error }),
  );
  await Promise.race([
    entered.promise,
    pending.then((result) => {
      throw new Error(`interactive ended before fixture entry: ${JSON.stringify(result)}`);
    }),
  ]);
  return {
    pending,
    release: () => {
      state.hold = null;
      hold.resolve();
    },
  };
}

const chatBody = (content) => ({
  id: "fixture",
  choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  usage: {
    prompt_tokens: 10,
    completion_tokens: 2,
    prompt_tokens_details: { cached_tokens: 0 },
  },
});

before(
  async (t) => {
    state.directory = await mkdtemp(join(tmpdir(), "llm-router-batch-"));

    const fixture = createServer(async (request, response) => {
      try {
        response.setHeader("content-type", "application/json");
        const url = request.url ?? "";
        if (url === "/health") {
          response.end(JSON.stringify({ status: "ok" }));
          return;
        }
        if (url === "/slots") {
          response.end(JSON.stringify([{ is_processing: false }]));
          return;
        }
        if (request.method === "GET") {
          if (url === "/api/v1/batches") {
            state.openRouter.listGets += 1;
            response.end(JSON.stringify({ data: [] }));
            return;
          }
          if (url.startsWith("/api/v1/batches/")) {
            const id = url.slice("/api/v1/batches/".length);
            state.openRouter.gets.push(id);
            const heldGet = state.openRouter.holdGet;
            if (heldGet && !heldGet.used && (heldGet.id === null || heldGet.id === id)) {
              heldGet.used = true;
              heldGet.entered.resolve();
              await heldGet.release.promise;
              if (response.destroyed) return;
            }
            const posted = state.openRouter.posts.find((post) => post.id === id) ?? null;
            if (posted === null) {
              response.statusCode = 404;
              response.end(JSON.stringify({ error: "unknown batch" }));
              return;
            }
            response.end(
              JSON.stringify({
                id,
                status: "completed",
                usage: {
                  prompt_tokens: 40,
                  completion_tokens: 12,
                  total_tokens: 52,
                  cost: 0.00042,
                  is_byok:
                    state.openRouter.mode === "mixed-byok" && posted === state.openRouter.posts[0]
                      ? null
                      : false,
                },
                results: posted.body.requests.map((entry, index) => ({
                  custom_id: entry.custom_id,
                  response: {
                    status_code: 200,
                    request_id: `fake-req-${index + 1}`,
                    body: {
                      id: `gen-${index + 1}`,
                      object: "chat.completion",
                      choices: [
                        {
                          index: 0,
                          message: { role: "assistant", content: "remote complete" },
                          finish_reason: "stop",
                        },
                      ],
                      usage: { prompt_tokens: 15, completion_tokens: 6 },
                    },
                  },
                  error: null,
                })),
              }),
            );
            return;
          }
          state.logs += `\nfixture: unexpected GET ${url}`;
          response.statusCode = 404;
          response.end();
          return;
        }
        if (request.method !== "POST") {
          response.statusCode = 404;
          response.end();
          return;
        }
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        if (url === "/api/v1/batches") {
          const id = `fake_batch_${++state.nextRemoteId}`;
          state.openRouter.posts.push({ id, body, auth: request.headers.authorization ?? "" });
          if (state.openRouter.mode === "reject-once" && state.openRouter.posts.length === 1) {
            response.statusCode = 429;
            response.end(JSON.stringify({ error: "rate limited" }));
            return;
          }
          if (state.openRouter.mode === "destroy") {
            // Protocol peer received the POST but no outcome ever returns: ambiguous submit.
            request.socket.destroy();
            return;
          }
          response.end(JSON.stringify({ id }));
          return;
        }
        if (url !== "/v1/chat/completions") {
          if (state.peer.unexpectedPosts.length < 8) {
            state.peer.unexpectedPosts.push({
              path: new URL(url, "http://localhost").pathname.slice(0, 200),
              model: String(body.model ?? "").slice(0, 100),
            });
          }
          response.statusCode = 404;
          response.end();
          return;
        }
        state.peer.chatPosts += 1;
        assert.equal(body.model, "fixture-chat");
        const content = String(body.messages?.[0]?.content ?? "");
        if (content.startsWith("interactive-marker")) {
          const hold = state.hold;
          if (hold !== null) {
            hold.entered.resolve();
            await hold.release.promise;
          }
          response.end(JSON.stringify(chatBody("interactive complete")));
          return;
        }
        if (content.startsWith("batch-")) {
          state.batchChat.push(content);
          response.end(JSON.stringify(chatBody("local complete")));
          return;
        }
        response.end(JSON.stringify(chatBody("interactive complete")));
      } catch (error) {
        response.statusCode = 500;
        response.end(JSON.stringify({ error: `fixture failed: ${String(error)}` }));
      }
    });
    state.fixture = fixture;
    const upstreamPort = await listen(fixture);
    const reservation = createPortReservation();
    state.port = await listen(reservation);
    await close(reservation);
    state.origin = `http://127.0.0.1:${state.port}`;

    // Sync catalogue: proven production fixture construction — one local deployment to the fake chat peer.
    const catalogue = JSON.parse(await readFile("catalog.example.json", "utf8")).slice(0, 1);
    Object.assign(catalogue[0], {
      id: "fixture",
      modelId: "fixture-chat",
      // A generic OpenAI peer: these tests cover router machinery, gufo.test.mjs covers Gufo.
      transport: "openai-compatible",
      credentialEnvVar: null,
      endpoint: `http://127.0.0.1:${upstreamPort}/v1`,
      contextLimitTokens: 65536,
      maxOutputTokens: 8192,
      reasoning: { kind: "binary" },
    });
    Object.assign(catalogue[0].prices, {
      inputUsdPerMillion: 1,
      cachedInputUsdPerMillion: 1,
      outputUsdPerMillion: 1,
      provenance: { unit: "USD-per-million-tokens", source: "test", asOf: "2026-09-20" },
    });

    // Batch catalogue: separate file, batch-only deployment, DeepInfra provider pin. The endpoint
    // points at the local protocol peer; the wiring derives the adapter origin from it, so the
    // adapter hits <origin>/api/v1/batches — exactly what this fixture serves.
    const batchCatalogue = JSON.parse(await readFile("catalog.example.json", "utf8")).slice(1, 2);
    Object.assign(batchCatalogue[0], {
      id: "cloud-glm-batch",
      providerRestriction: "deepinfra/fp4",
      endpoint: `http://127.0.0.1:${upstreamPort}/api/v1`,
    });

    const cataloguePath = join(state.directory, "catalog.json");
    const batchCataloguePath = join(state.directory, "batch-catalog.json");
    state.databasePath = join(state.directory, "control.sqlite");
    state.resultsDir = join(state.directory, "batch-content");
    await writeFile(cataloguePath, JSON.stringify(catalogue), { mode: 0o600 });
    await writeFile(batchCataloguePath, JSON.stringify(batchCatalogue), { mode: 0o600 });

    // Loopback-only guard for the child gateway: any external fetch rejects loudly.
    const guardPath = join(state.directory, "loopback-only.mjs");
    await writeFile(
      guardPath,
      `const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = String(typeof input === "string" || input instanceof URL ? input : input.url);
  const parsed = new URL(url);
  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    const host = parsed.hostname;
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
      return Promise.reject(new Error("batch integration test blocked external fetch: " + url));
    }
  }
  return realFetch(input, init);
};
`,
      { mode: 0o600 },
    );

    const pepper = randomUUID(); // fixed for the whole run: restarts must reuse it
    state.gatewayEnv = {
      ...process.env,
      NODE_ENV: "production",
      NEXT_TELEMETRY_DISABLED: "1",
      NEXT_MANUAL_SIG_HANDLE: "true",
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=file://${guardPath}`]
        .filter(Boolean)
        .join(" "),
      APP_ORIGIN: state.origin,
      SQLITE_PATH: state.databasePath,
      MODEL_CATALOG: cataloguePath,
      BATCH_CATALOG: batchCataloguePath,
      BATCH_RESULTS_DIR: state.resultsDir,
      AUXILIARY_CATALOG: "",
      API_KEY_PEPPER: pepper,
      OPENROUTER_API_KEY: FAKE_OPENROUTER_KEY,
    };

    spawnGateway();
    await waitReady(t.signal);
    state.keys = {
      local: await createKey("batch local", t.signal),
      rival: await createKey("batch rival", t.signal),
      doomed: await createKey("batch doomed", t.signal),
      restart: await createKey("batch restart", t.signal),
      remote: await createKey("batch remote", t.signal),
      idle: await createKey("batch idle", t.signal),
      ambiguous: await createKey("batch ambiguous", t.signal),
      retry: await createKey("batch retry", t.signal),
      byok: await createKey("batch unknown byok", t.signal),
    };
  },
  { timeout: 60_000 },
);

after(
  async () => {
    try {
      state.hold?.release.resolve();
    } catch {
      /* best effort */
    }
    state.openRouter.holdGet?.release.resolve();
    try {
      await stopGateway("SIGKILL");
    } catch {
      /* best effort */
    }
    if (state.fixture) {
      state.fixture.closeAllConnections();
      try {
        await close(state.fixture);
      } catch {
        /* best effort */
      }
    }
    await rm(state.directory, { recursive: true, force: true });
  },
  { timeout: 30_000 },
);

test(
  "submit validation: top-level shape, duplicate ids, and streaming rejected",
  { timeout: 30_000 },
  async (t) => {
    const { local } = state.keys;
    const entry = batchEntry("valid-1", "batch-validation-1");
    const badSubmits = [
      // endpoint is required
      batchPayload([entry], { endpoint: undefined }),
      // and must be chat
      batchPayload([entry], { endpoint: "/v1/embeddings" }),
      // model is required and must be a nonempty string
      { endpoint: "/v1/chat/completions", completion_window: "24h", requests: [entry] },
      // unknown top-level fields are rejected
      batchPayload([entry], { temperature: 0.5 }),
      // the only accepted completion window
      batchPayload([entry], { completion_window: "1h" }),
      // duplicate custom_id is job-level identity, rejected before create
      batchPayload([entry, batchEntry("valid-1", "batch-validation-2")]),
      // where EVERY entry is invalid (stream only), the job itself is rejected
      batchPayload([batchEntry("stream-only", "batch-validation-3", { stream: true })]),
    ];
    for (const payload of badSubmits) {
      const result = await submitBatch(local.secret, payload, t.signal);
      assert.equal(result.status, 400, JSON.stringify({ payload, result }));
      assert.equal(result.body?.error?.code, "invalid", JSON.stringify(result));
    }
    // Nothing was half-created: the key's list is still empty.
    const list = await getJson("/v1/batches", authHeaders(local.secret), t.signal);
    assert.equal(list.status, 200);
    assert.equal(list.body.object, "list");
    assert.deepEqual(list.body.data, []);
  },
);

test(
  "idle local batch dispatches and completes through the production router",
  { timeout: 45_000 },
  async (t) => {
    const { idle } = state.keys;
    const submit = await submitBatch(
      idle.secret,
      batchPayload([batchEntry("batch-idle-0", "batch-idle-0")]),
      t.signal,
    );
    assert.equal(submit.status, 202, JSON.stringify(submit));
    const job = submit.body;

    const completed = await until(
      "idle local batch completes",
      async () => {
        const read = await getBatch(job.id, idle.secret, t.signal);
        assert.equal(read.status, 200);
        return read.body.status === "completed" ? read.body : false;
      },
      30_000,
      t.signal,
    );
    assert.deepEqual(completed.request_counts, { total: 1, completed: 1, failed: 0 });
    assert.equal(completed.results[0].custom_id, "batch-idle-0");
    assert.equal(completed.results[0].response.body.choices[0].message.content, "local complete");
    assert.deepEqual(
      state.batchChat.filter((marker) => marker === "batch-idle-0"),
      ["batch-idle-0"],
      "idle capacity dispatches the item exactly once",
    );
    const [item] = query(
      `SELECT i.status, r.deployment_id FROM batch_items i
     JOIN requests r ON r.id = i.request_id WHERE i.job_id = ?`,
      job.id,
    );
    assert.equal(item.status, "completed");
    assert.equal(item.deployment_id, "fixture");
  },
);

test(
  "held interactive blocks batch dispatch; release completes through the router and durable store; results retry-safe; DELETE purges",
  { timeout: 90_000 },
  async (t) => {
    const { local } = state.keys;
    const interactive = await holdInteractive(t, local.secret);

    // Two entries inherit the top-level model, one carries body.model equal to it, one streams
    // (a per-item failure surfaced as a failed row once the job completes).
    const submit = await submitBatch(
      local.secret,
      batchPayload([
        batchEntry("batch-local-a", "batch-local-a"),
        batchEntry("batch-local-b", "batch-local-b", { model: "auto" }),
        batchEntry("batch-local-stream", "batch-local-stream", { stream: true }),
      ]),
      t.signal,
    );
    assert.equal(submit.status, 202, JSON.stringify(submit));
    const job = submit.body;
    state.mainJobId = job.id;
    assert.match(job.id, /^batch_/);
    assert.equal(job.object, "batch");
    assert.equal(job.endpoint, "/v1/chat/completions");
    assert.equal(job.model, "auto");
    assert.equal(job.completion_window, "24h");
    assert.equal(job.usage, null);
    assert.equal(job.results, null);
    assert.equal(job.error, null);
    assert.deepEqual(job.request_counts, { total: 3, completed: 0, failed: 1 });
    assert.equal(job.deadline_at - job.local_wait_until, SPILL_WINDOW_SECONDS);
    assert.ok(job.created_at <= Math.floor(Date.now() / 1000));

    // A second job sits queued while blocked, so its DELETE-cancel path is observable too.
    const cancelSubmit = await submitBatch(
      local.secret,
      batchPayload([
        batchEntry("batch-cancel-1", "batch-cancel-1"),
        batchEntry("batch-cancel-2", "batch-cancel-2"),
      ]),
      t.signal,
    );
    assert.equal(cancelSubmit.status, 202, JSON.stringify(cancelSubmit));
    const cancelJob = cancelSubmit.body;

    // Nothing dispatches behind the live interactive generation: across several scheduler
    // passes the fixture sees no batch marker and completed counts never move.
    const noDispatchDeadline = Date.now() + 3000;
    while (Date.now() < noDispatchDeadline) {
      assert.deepEqual(
        state.batchChat.filter(
          (marker) => marker.startsWith("batch-local") || marker.startsWith("batch-cancel"),
        ),
        [],
      );
      const read = await getBatch(job.id, local.secret, t.signal);
      assert.equal(read.status, 200);
      assert.equal(read.body.request_counts.completed, 0, JSON.stringify(read.body.request_counts));
      await delay(100, undefined, { signal: t.signal });
    }

    // Queued DELETE cancels only not-yet-dispatched work: nothing ran, the job terminalizes.
    const deleteResponse = await deleteBatch(cancelJob.id, local.secret, t.signal);
    assert.equal(deleteResponse.status, 200);
    assert.equal(deleteResponse.body.object, "batch");
    const cancelFinal = await until(
      "cancelled job terminalizes",
      async () => {
        const read = await getBatch(cancelJob.id, local.secret, t.signal);
        assert.equal(read.status, 200);
        return read.body.status === "cancelled" ? read.body : false;
      },
      10_000,
      t.signal,
    );
    assert.ok(cancelFinal.finalized_at !== null);
    assert.deepEqual(cancelFinal.request_counts, { total: 2, completed: 0, failed: 0 });
    assert.equal(cancelFinal.results, null);

    // Release the interactive generation; the batch becomes eligible and completes.
    interactive.release();
    const interactiveResult = await interactive.pending;
    assert.equal(interactiveResult.status, 200, JSON.stringify(interactiveResult));
    assert.equal(interactiveResult.body.choices[0].message.content, "interactive complete");
    assert.equal(interactiveResult.body.usage.cost, 0.000012); // local COGS retained

    const completed = await until(
      "local batch completes",
      async () => {
        const read = await getBatch(job.id, local.secret, t.signal);
        assert.equal(read.status, 200);
        return read.body.status === "completed" ? read.body : false;
      },
      30_000,
      t.signal,
    );
    assert.deepEqual(completed.request_counts, { total: 3, completed: 2, failed: 1 });
    assert.equal(completed.usage, null, "no spill happened, so job usage stays null");

    // Result rows: response XOR error, real local completions, per-item stream rejection.
    const rows = new Map(completed.results.map((row) => [row.custom_id, row]));
    assert.equal(rows.size, 3);
    for (const customId of ["batch-local-a", "batch-local-b"]) {
      const row = rows.get(customId);
      assert.equal(row.error, null);
      assert.equal(row.response.status_code, 200);
      assert.equal(row.response.body.choices[0].message.content, "local complete");
    }
    const streamRow = rows.get("batch-local-stream");
    assert.equal(streamRow.response, null);
    assert.equal(streamRow.error.code, "stream_unsupported");

    // Retry-safe reads: an identical GET never destroys results.
    const again = await getBatch(job.id, local.secret, t.signal);
    assert.equal(again.status, 200);
    assert.deepEqual(again.body, completed);

    // The private content store holds this job's bytes on disk, outside the metadata database.
    assert.ok((await storeEntries(job.id)).length > 0, "store holds the job's artifacts on disk");

    // Local items finalized through the real router with COGS recorded.
    const itemRows = query(
      `SELECT i.custom_id, i.deployment_id, i.request_id, r.prompt_tokens, r.completion_tokens,
            r.estimated_cost_usd, r.cost_source, r.classifier_backend, r.status
     FROM batch_items i JOIN requests r ON r.id = i.request_id
     WHERE i.job_id = ?`,
      job.id,
    );
    assert.equal(itemRows.length, 2, "only the two valid items dispatched");
    for (const row of itemRows) {
      assert.equal(row.deployment_id, "fixture");
      assert.equal(row.status, "success");
      assert.equal(row.prompt_tokens, 10);
      assert.equal(row.completion_tokens, 2);
      assert.ok(row.estimated_cost_usd > 0, "local COGS retained");
      assert.equal(row.cost_source, "local-rate-card");
      assert.equal(row.classifier_backend, null);
    }
    const streamItem = query(
      "SELECT status, request_id, deployment_id FROM batch_items WHERE job_id = ? AND custom_id = ?",
      job.id,
      "batch-local-stream",
    );
    assert.equal(streamItem.length, 1);
    assert.equal(streamItem[0].status, "failed");
    assert.equal(streamItem[0].request_id, null, "pre-failed items never dispatch");
    assert.equal(streamItem[0].deployment_id, null);

    // Terminal DELETE purges held results (retrieval acknowledgement); the job record stays.
    const purge = await deleteBatch(job.id, local.secret, t.signal);
    assert.equal(purge.status, 200);
    assert.equal(purge.body.status, "completed");
    assert.equal(purge.body.results, null);
    assert.deepEqual(
      await storeEntries(job.id),
      [],
      "purge removes every store artifact for the job",
    );
    const afterPurge = await getBatch(job.id, local.secret, t.signal);
    assert.equal(afterPurge.status, 200);
    assert.equal(afterPurge.body.status, "completed");
    assert.equal(afterPurge.body.results, null);
    // Repeat delete of a terminal job is a no-op 200.
    const repeat = await deleteBatch(job.id, local.secret, t.signal);
    assert.equal(repeat.status, 200);

    // The cancelled job's items never dispatched, even after capacity freed up.
    assert.deepEqual(
      state.batchChat.filter((marker) => marker.startsWith("batch-cancel")),
      [],
    );
  },
);

test(
  "batch reads are key-scoped: cross-key 404, list scoping, revoked and missing keys refused",
  { timeout: 30_000 },
  async (t) => {
    const { local, rival, doomed } = state.keys;
    const id = state.mainJobId;
    assert.ok(id, "expected the completed local job from the previous test");

    // Cross-key reads answer 404 — indistinguishable from a genuinely unknown id.
    const cross = await getBatch(id, rival.secret, t.signal);
    assert.equal(cross.status, 404);
    assert.equal(cross.body.error.code, "not_found");
    const unknown = await getBatch(
      "batch_00000000-0000-0000-0000-000000000000",
      rival.secret,
      t.signal,
    );
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, cross.body.error.code);
    // Cross-key DELETE refuses before touching anything.
    const crossDelete = await deleteBatch(id, rival.secret, t.signal);
    assert.equal(crossDelete.status, 404);
    assert.equal(crossDelete.body.error.code, "not_found");

    // List is key-scoped and never carries results.
    const rivalList = await getJson("/v1/batches", authHeaders(rival.secret), t.signal);
    assert.equal(rivalList.status, 200);
    assert.equal(rivalList.body.object, "list");
    assert.equal(rivalList.body.data.length, 0);
    const localList = await getJson("/v1/batches", authHeaders(local.secret), t.signal);
    assert.equal(localList.status, 200);
    assert.ok(localList.body.data.some((row) => row.id === id));
    for (const row of localList.body.data) assert.equal(row.results, null);

    // Missing bearer is refused.
    const missing = await getJson("/v1/batches", { "content-type": "application/json" }, t.signal);
    assert.equal(missing.status, 401);
    assert.equal(missing.body.error.code, "unauthorized");

    // A working key is refused once revoked (bounded: revocation may land on the next recheck).
    const before = await getJson("/v1/batches", authHeaders(doomed.secret), t.signal);
    assert.equal(before.status, 200);
    const revoke = await fetch(`${state.origin}/api/admin/keys/${doomed.id}`, {
      method: "DELETE",
      headers: adminHeaders(),
      signal: t.signal,
    });
    assert.equal(revoke.status, 204);
    const refused = await until(
      "revoked key refused",
      async () => {
        const read = await getJson("/v1/batches", authHeaders(doomed.secret), t.signal);
        return read.status === 401 ? read : false;
      },
      5000,
      t.signal,
    );
    assert.equal(refused.body.error.code, "unauthorized");
  },
);

test(
  "never-dispatched queued batch resumes after a hard stop with zero client requests",
  { timeout: 120_000 },
  async (t) => {
    const { restart } = state.keys;
    // A different key owns the foreground lease; it blocks the global deferred lane
    // without exhausting the batch key quota after the hard stop.
    const interactive = await holdInteractive(t, state.keys.rival.secret);
    const submit = await submitBatch(
      restart.secret,
      batchPayload([
        batchEntry("batch-restart-0", "batch-restart-0"),
        batchEntry("batch-restart-1", "batch-restart-1"),
      ]),
      t.signal,
    );
    assert.equal(submit.status, 202, JSON.stringify(submit));
    const job = submit.body;

    // Durable per-item inputs landed in the private store before the kill; the exact
    // per-item file layout is store-owned, so only presence is asserted here — the
    // post-restart completion of both custom_ids proves the bodies themselves survived.
    assert.ok((await storeEntries(job.id)).length > 0, "durable inputs landed before the kill");

    // Blocked behind the interactive generation: nothing dispatched.
    await delay(1500, undefined, { signal: t.signal });
    assert.deepEqual(
      state.batchChat.filter((marker) => marker.startsWith("batch-restart")),
      [],
    );
    const beforeKill = await getBatch(job.id, restart.secret, t.signal);
    assert.equal(beforeKill.body.request_counts.completed, 0);

    // Hard-stop ONLY the owned gateway; the fixture peers and this test process keep running.
    await stopGateway("SIGKILL");
    await interactive.pending; // the in-flight admission dies with the gateway
    interactive.release(); // unblock the fixture handler parked on the dead response

    // Restart with the SAME SQLite, pepper and content directory.
    spawnGateway();

    // ZERO client requests: wait purely on the fixture observation that the scheduler
    // auto-started at process boot and dispatched the surviving queued bodies. Only after
    // that proof may this test talk to the gateway again.
    const dispatched = await until(
      "fixture sees resumed dispatch with no client request",
      () => {
        const seen = state.batchChat.filter((marker) => marker.startsWith("batch-restart"));
        return seen.length === 2 ? seen : false;
      },
      30_000,
      t.signal,
    );
    assert.equal(dispatched.length, 2);

    const completed = await until(
      "resumed batch completes",
      async () => {
        const read = await getBatch(job.id, restart.secret, t.signal);
        assert.equal(read.status, 200);
        return read.body.status === "completed" ? read.body : false;
      },
      30_000,
      t.signal,
    );
    assert.deepEqual(completed.request_counts, { total: 2, completed: 2, failed: 0 });
    const rows = new Map(completed.results.map((row) => [row.custom_id, row]));
    assert.equal(rows.size, 2);
    for (const customId of ["batch-restart-0", "batch-restart-1"]) {
      assert.equal(rows.get(customId).error, null);
      assert.equal(rows.get(customId).response.body.choices[0].message.content, "local complete");
    }
    // Never-dispatched work resumed instead of being marked interrupted, and each body
    // dispatched exactly once across the restart — no blind replay.
    const items = query("SELECT status FROM batch_items WHERE job_id = ?", job.id);
    assert.deepEqual(items.map((row) => row.status).sort(), ["completed", "completed"]);
    assert.equal(state.batchChat.filter((marker) => marker.startsWith("batch-restart")).length, 2);
  },
);

test(
  "spilled batch completes through the real adapter against the pinned DeepInfra provider-only remote path",
  { timeout: 90_000 },
  async (t) => {
    const { remote } = state.keys;
    state.openRouter = { posts: [], gets: [], listGets: 0, mode: "accept" };
    // Keep the batch key quota free while the separate foreground key holds local capacity.
    const interactive = await holdInteractive(t, state.keys.idle.secret);
    const submit = await submitBatch(
      remote.secret,
      batchPayload([
        batchEntry("batch-remote-0", "batch-remote-0"),
        batchEntry("batch-remote-1", "batch-remote-1"),
      ]),
      t.signal,
    );
    assert.equal(submit.status, 202, JSON.stringify(submit));
    const job = submit.body;

    // Local window: nothing dispatched locally, nothing sent upstream.
    await delay(1000, undefined, { signal: t.signal });
    assert.deepEqual(
      state.batchChat.filter((marker) => marker.startsWith("batch-remote")),
      [],
    );
    assert.equal(state.openRouter.posts.length, 0);

    // Explicit due-time simulation: advance ONLY this isolated ledger row.
    await makeSpillDue(job.id);

    const post = await until(
      "adapter POSTs to the local provider peer",
      () => (state.openRouter.posts.length > 0 ? state.openRouter.posts[0] : false),
      30_000,
      t.signal,
    );
    const wire = post.body;
    assert.equal(wire.endpoint, "/v1/chat/completions");
    assert.equal(wire.model, "z-ai/glm-5.3-flash"); // the batch catalogue deployment's model
    assert.deepEqual(wire.provider, { only: ["deepinfra/fp4"] });
    assert.equal(wire.completion_window, "24h");
    assert.equal(wire.requests.length, 2);
    const upstreamIds = query("SELECT id FROM batch_items WHERE job_id = ?", job.id)
      .map((item) => item.id)
      .sort();
    assert.deepEqual(wire.requests.map((entry) => entry.custom_id).sort(), upstreamIds);
    for (const entry of wire.requests) {
      assert.equal(entry.body.model, undefined, "per-request bodies inherit the batch model");
      assert.ok(Array.isArray(entry.body.messages) && entry.body.messages.length > 0);
    }
    assert.equal(post.auth, `Bearer ${FAKE_OPENROUTER_KEY}`);

    // The adapter polls the confirmed id — never the list.
    await until(
      "adapter polls the confirmed id",
      () => state.openRouter.gets.length > 0 || false,
      30_000,
      t.signal,
    );
    assert.equal(state.openRouter.listGets, 0, "list similarity adoption is forbidden");
    assert.ok(state.openRouter.gets.every((id) => id === post.id));

    const completed = await until(
      "remote batch completes",
      async () => {
        const read = await getBatch(job.id, remote.secret, t.signal);
        assert.equal(read.status, 200);
        return read.body.status === "completed" ? read.body : false;
      },
      30_000,
      t.signal,
    );
    assert.deepEqual(completed.request_counts, { total: 2, completed: 2, failed: 0 });
    // Job usage is the provider-reported aggregate; one intent, one POST per group.
    assert.deepEqual(completed.usage, {
      prompt_tokens: 40,
      completion_tokens: 12,
      total_tokens: 52,
      cost: 0.00042,
      is_byok: false,
    });
    assert.equal(state.openRouter.posts.length, 1, "one intent means one POST for the group");
    assert.ok(state.openRouter.gets.every((id) => id === post.id));

    // Result row mapping: upstream rows land on the right items with their identities.
    const rows = new Map(completed.results.map((row) => [row.custom_id, row]));
    assert.equal(rows.size, 2);
    const items = query(
      "SELECT custom_id, id, request_id FROM batch_items WHERE job_id = ?",
      job.id,
    );
    assert.equal(items.length, 2);
    for (const item of items) {
      const row = rows.get(item.custom_id);
      assert.ok(row, item.custom_id);
      assert.equal(row.id, item.id, "row id is the durable item id");
      assert.equal(row.error, null);
      assert.equal(row.response.status_code, 200);
      assert.equal(row.response.body.choices[0].message.content, "remote complete");
      const wireIndex = wire.requests.findIndex((entry) => entry.custom_id === item.id);
      assert.ok(wireIndex >= 0);
      assert.equal(row.response.request_id, `fake-req-${wireIndex + 1}`);
    }

    // Remote rows: tokens parsed defensively from the body, cost unknown (NULL ≠ zero),
    // spill deployment recorded — job-level cost is the only spend figure asserted.
    for (const item of items) {
      const [row] = query(
        `SELECT deployment_id, prompt_tokens, completion_tokens, provider_reported_usd,
              estimated_cost_usd, cost_source, status
       FROM requests WHERE id = ?`,
        item.request_id,
      );
      assert.ok(row, `expected a requests row for ${item.custom_id}`);
      assert.equal(row.deployment_id, "cloud-glm-batch");
      assert.equal(row.prompt_tokens, 15);
      assert.equal(row.completion_tokens, 6);
      assert.equal(row.provider_reported_usd, null);
      assert.equal(row.estimated_cost_usd, null);
      assert.equal(row.cost_source, null, "remote row cost is unknown, never zero");
    }

    // The synchronous path stays untouched by the batch catalogue: the held interactive
    // generation still completes through the sync deployment, and remote items never
    // dispatched locally.
    interactive.release();
    const interactiveResult = await interactive.pending;
    assert.equal(interactiveResult.status, 200, JSON.stringify(interactiveResult));
    assert.equal(interactiveResult.body.choices[0].message.content, "interactive complete");
    assert.deepEqual(
      state.batchChat.filter((marker) => marker.startsWith("batch-remote")),
      [],
    );
  },
);

test(
  "confirmed remote group resumes its known poll after bounded SIGTERM",
  { timeout: 120_000 },
  async (t) => {
    const { restart } = state.keys;
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    state.openRouter = {
      posts: [],
      gets: [],
      listGets: 0,
      mode: "accept",
      holdGet: { id: null, used: false, entered, release },
    };
    // Hold global local capacity on another key so the item reaches remote spill, not local dispatch.
    const interactive = await holdInteractive(t, state.keys.local.secret);

    const submit = await submitBatch(
      restart.secret,
      batchPayload([batchEntry("batch-confirmed-restart", "batch-confirmed-restart")]),
      t.signal,
    );
    assert.equal(submit.status, 202, JSON.stringify(submit));
    const job = submit.body;
    await makeSpillDue(job.id);

    const post = await until(
      "confirmed restart group submitted",
      () => (state.openRouter.posts.length === 1 ? state.openRouter.posts[0] : false),
      30_000,
      t.signal,
    );
    assert.deepEqual(post.body.provider, { only: ["deepinfra/fp4"] });

    await until(
      "confirmed remote id enters first poll",
      () => (state.openRouter.holdGet.used ? true : false),
      30_000,
      t.signal,
    );
    await entered.promise;
    assert.deepEqual(state.openRouter.gets, [post.id]);
    assert.equal(
      query("SELECT remote_batch_id FROM batch_remotes WHERE job_id = ?", job.id)[0]
        .remote_batch_id,
      post.id,
      "the provider id is durable before shutdown",
    );
    assert.equal(
      query("SELECT COUNT(*) AS n FROM batch_remotes WHERE job_id = ?", job.id)[0].n,
      1,
      "the confirmed group remains linked to this job",
    );

    // A provider poll is deliberately held open. SIGTERM must settle it and close SQLite
    // Release foreground HTTP before graceful shutdown; only the remote poll remains held.
    interactive.release();
    const foreground = await interactive.pending;
    assert.equal(foreground.status, 200, JSON.stringify(foreground));
    const shutdown = await stopGatewayBounded("SIGTERM", 15_000);
    assert.deepEqual(
      shutdown,
      { code: 0, signal: null },
      "SIGTERM follows the graceful drain handler",
    );
    release.resolve();

    spawnGateway();
    await until(
      "restarted scheduler polls the confirmed provider id without a client request",
      () => (state.openRouter.gets.length >= 2 ? state.openRouter.gets : false),
      30_000,
      t.signal,
    );
    assert.equal(state.openRouter.posts.length, 1, "confirmed groups are polled, never re-posted");
    assert.equal(state.openRouter.listGets, 0, "recovery never adopts a similar batch from a list");
    assert.ok(state.openRouter.gets.every((id) => id === post.id));

    const completed = await until(
      "recovered confirmed batch completes",
      async () => {
        const read = await getBatch(job.id, restart.secret, t.signal);
        assert.equal(read.status, 200);
        return read.body.status === "completed" ? read.body : false;
      },
      30_000,
      t.signal,
    );
    assert.deepEqual(completed.request_counts, { total: 1, completed: 1, failed: 0 });
    assert.equal(completed.results[0].custom_id, "batch-confirmed-restart");
    assert.equal(completed.results[0].response.body.choices[0].message.content, "remote complete");
    assert.deepEqual(await getBatch(job.id, restart.secret, t.signal), {
      status: 200,
      body: completed,
    });
    assert.ok(
      (await storeEntries(job.id)).length > 0,
      "recovered results remain in the private store",
    );
    assert.deepEqual(
      state.batchChat.filter((marker) => marker === "batch-confirmed-restart"),
      [],
      "confirmed remote work never falls back to local replay",
    );
    state.openRouter.holdGet = null;
  },
);

test(
  "mixed upstream BYOK facts remain unknown in the consumer job usage",
  { timeout: 90_000 },
  async (t) => {
    state.openRouter = { posts: [], gets: [], listGets: 0, mode: "mixed-byok" };
    const interactive = await holdInteractive(t, state.keys.idle.secret);
    t.after(() => interactive.release());
    const submitted = await submitBatch(
      state.keys.byok.secret,
      batchPayload([
        batchEntry("batch-byok-unknown", "batch-byok-unknown", {
          response_format: { type: "json_object" },
        }),
        batchEntry("batch-byok-known", "batch-byok-known"),
      ]),
      t.signal,
    );
    assert.equal(submitted.status, 202);
    await makeSpillDue(submitted.body.id);
    const completed = await until(
      "split remote groups finish and expose job usage",
      async () => {
        const read = await getBatch(submitted.body.id, state.keys.byok.secret, t.signal);
        return read.body?.status === "completed" ? read.body : false;
      },
      30_000,
      t.signal,
    );
    assert.equal(state.openRouter.posts.length, 2);
    assert.equal(completed.results.length, 2);
    assert.equal(completed.usage.is_byok, null, "unknown cannot become known after a later group");
    assert.deepEqual(
      query(
        "SELECT usage_json FROM batch_remotes WHERE job_id = ? ORDER BY created_at",
        submitted.body.id,
      ).map((remote) => JSON.parse(remote.usage_json).is_byok),
      [null, false],
    );
  },
);

test(
  "definitely rejected 429 reopens the same SQLite intent before the only retry POST",
  { timeout: 90_000 },
  async (t) => {
    state.openRouter = { posts: [], gets: [], listGets: 0, mode: "reject-once" };
    const interactive = await holdInteractive(t, state.keys.idle.secret);
    t.after(() => interactive.release());
    const submitted = await submitBatch(
      state.keys.retry.secret,
      batchPayload([batchEntry("batch-retry-0", "batch-retry-0")]),
      t.signal,
    );
    assert.equal(submitted.status, 202);
    const jobId = submitted.body.id;
    await makeSpillDue(jobId);
    const completed = await until(
      "retry reaches a durable confirmed provider result",
      async () => {
        const read = await getBatch(jobId, state.keys.retry.secret, t.signal);
        return read.body?.status === "completed" ? read.body : false;
      },
      45_000,
      t.signal,
    );
    assert.equal(state.openRouter.posts.length, 2, "429 refused; only one accepted retry");
    const [rejected, accepted] = state.openRouter.posts;
    assert.deepEqual(rejected.body.requests, accepted.body.requests, "same exact membership");
    assert.equal(completed.results[0].response.body.choices[0].message.content, "remote complete");
    const [remote] = query(
      "SELECT intent, remote_batch_id FROM batch_remotes WHERE job_id = ?",
      jobId,
    );
    assert.equal(remote.intent, "confirmed");
    assert.equal(remote.remote_batch_id, accepted.id);
    assert.notEqual(remote.remote_batch_id, rejected.id);
    assert.equal(query("SELECT COUNT(*) AS n FROM batch_remotes WHERE job_id = ?", jobId)[0].n, 1);
    assert.ok(state.openRouter.gets.every((id) => id === accepted.id));
    assert.equal(state.openRouter.listGets, 0);
  },
);

test(
  "ambiguous remote submit never re-posts, never adopts, and fabricates no results",
  { timeout: 90_000 },
  async (t) => {
    const { ambiguous } = state.keys;
    state.openRouter = { posts: [], gets: [], listGets: 0, mode: "destroy" };
    const interactive = await holdInteractive(t, state.keys.idle.secret);
    const submit = await submitBatch(
      ambiguous.secret,
      batchPayload([
        batchEntry("batch-ambig-0", "batch-ambig-0"),
        batchEntry("batch-ambig-1", "batch-ambig-1"),
      ]),
      t.signal,
    );
    assert.equal(submit.status, 202, JSON.stringify(submit));
    const job = submit.body;
    await makeSpillDue(job.id);

    const post = await until(
      "adapter POSTs once to the peer",
      () => (state.openRouter.posts.length === 1 ? state.openRouter.posts[0] : false),
      30_000,
      t.signal,
    );
    assert.deepEqual(post.body.provider, { only: ["deepinfra/fp4"] });

    // Durable intent: exactly ONE intent for the compatibility group, marked unknown after the
    // ambiguous outcome, with no proven provider id — and assigned items interrupted.
    const remote = await until(
      "ambiguous submit marked unknown",
      () => {
        const rows = query(
          "SELECT intent, remote_batch_id FROM batch_remotes WHERE job_id = ?",
          job.id,
        );
        return rows.length === 1 && rows[0].intent === "unknown" ? rows[0] : false;
      },
      15_000,
      t.signal,
    );
    assert.equal(remote.remote_batch_id, null, "no provider id was ever proven");
    const interrupted = await until(
      "assigned items interrupted, never replayed",
      () => {
        const rows = query("SELECT status FROM batch_items WHERE job_id = ?", job.id);
        return rows.length === 2 && rows.every((row) => row.status === "interrupted")
          ? rows
          : false;
      },
      15_000,
      t.signal,
    );
    assert.equal(interrupted.length, 2);

    // Bounded watch across several scheduler ticks: no second POST, no list adoption, no
    // poll without a confirmed id.
    const watchDeadline = Date.now() + 8000;
    while (Date.now() < watchDeadline) {
      assert.equal(state.openRouter.posts.length, 1, "an ambiguous submit never re-POSTs");
      assert.equal(state.openRouter.listGets, 0, "list similarity adoption is forbidden");
      assert.equal(state.openRouter.gets.length, 0, "polling requires a proven id");
      await delay(200, undefined, { signal: t.signal });
    }

    // No fabricated success: the job never completes and no result rows exist.
    const read = await getBatch(job.id, ambiguous.secret, t.signal);
    assert.equal(read.status, 200);
    assert.notEqual(read.body.status, "completed");
    assert.equal(read.body.results, null);
    assert.equal(read.body.request_counts.completed, 0);

    // Freeing local capacity must not resurrect the interrupted work either.
    interactive.release();
    await interactive.pending;
    await delay(2000, undefined, { signal: t.signal });
    assert.deepEqual(
      state.batchChat.filter((marker) => marker.startsWith("batch-ambig")),
      [],
    );
    const after = await getBatch(job.id, ambiguous.secret, t.signal);
    assert.notEqual(after.body.status, "completed");
    assert.equal(after.body.results, null);
    assert.equal(state.openRouter.posts.length, 1);
  },
);
