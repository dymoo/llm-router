import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, it } from "node:test";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { Effect, Layer, ManagedRuntime } from "effect";
import { POLICY_SUGGESTIONS } from "../src/domain.ts";
import { sqliteDatabaseLayer } from "../src/db/sqlite.ts";
import { ApiKeys, apiKeysLayer } from "../src/keys/api-keys.ts";
import { handleChatCompletions } from "../src/http/inference.ts";
import { inferenceDeps, jsonRequest, memoryKeys, ORIGIN } from "./http/helpers.ts";
import { keyRepositoryLayer } from "../src/keys/repository.ts";
import {
  observeAdmission,
  observeFinalized,
  observeOpenRouterCompleted,
  registerDeployments,
  observeSqlMetrics,
  renderMetrics,
} from "../server/metrics.ts";
import { startMetricsListener, stopMetricsListener } from "../server/metrics-listener.ts";

const dirs: string[] = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function samples(
  text: string,
  name: string,
): Array<{ labels: Record<string, string>; value: number }> {
  return text
    .split("\n")
    .filter((line) => line.startsWith(`${name}{`) || line.startsWith(`${name} `))
    .map((line) => {
      const match = /^([^ {]+)(?:\{([^}]*)\})? (\S+)$/.exec(line)!;
      const labels = Object.fromEntries(
        [...(match[2]?.matchAll(/(\w+)="((?:\\.|[^"])*)"/g) ?? [])].map((part) => [
          part[1]!,
          part[2]!,
        ]),
      );
      return { labels, value: Number(match[3]) };
    });
}

it("counts only a committed terminal transition, and never treats unknown usage as zero", async () => {
  const dir = mkdtempSync(join(tmpdir(), "router-metrics-"));
  dirs.push(dir);
  const runtime = ManagedRuntime.make(
    apiKeysLayer.pipe(
      Layer.provideMerge(
        keyRepositoryLayer({ pepper: "metrics-pepper", onFinalized: observeFinalized }),
      ),
      Layer.provide(sqliteDatabaseLayer(join(dir, "control.sqlite"))),
    ),
  );
  const { keyId, prefix, secret } = await runtime.runPromise(
    Effect.gen(function* () {
      const keys = yield* ApiKeys;
      const created = yield* keys.createKey({
        name: "secret-label",
        expiresAt: null,
        policy: POLICY_SUGGESTIONS.Standard,
      });
      const admission = yield* keys.admit(created.secret);
      yield* keys.finalize(admission, {
        status: "success",
        deploymentId: "none",
        promptTokens: null,
        completionTokens: null,
        decisionTraceJson: "private-session-id",
      });
      yield* keys.finalize(admission, { status: "success", promptTokens: 999 });
      return { keyId: created.key.id, prefix: created.key.prefix, secret: created.secret };
    }),
  );
  await runtime.dispose();
  const output = renderMetrics();
  const requests = samples(output, "llm_router_requests_total").filter(
    (row) => row.labels.key_id === keyId && row.labels.status === "success",
  );
  assert.equal(
    requests.reduce((n, row) => n + row.value, 0),
    1,
  );
  // Never dispatched: no location, and missing usage is not "unknown provider usage".
  assert.deepEqual(
    requests.map((row) => row.labels.location),
    ["none"],
  );
  assert.equal(
    samples(output, "llm_router_usage_unknown_total").filter(
      (row) => row.labels.deployment === "none",
    ).length,
    0,
  );
  assert.equal(
    samples(output, "llm_router_tokens_total").filter((row) => row.labels.key_id === keyId).length,
    0,
  );
  assert.equal(output.includes("secret-label"), false);
  assert.equal(output.includes(prefix), false);
  assert.equal(output.includes(secret), false);
  assert.equal(output.includes("private-session-id"), false);
});

it("normalizes unknown admission and request labels without disclosing secrets", () => {
  observeAdmission("surprise-secret-value");
  observeFinalized({
    keyId: "not-a-uuid-secret",
    startedAt: Date.now() - 12,
    priority: "secret-priority",
    outcome: {
      status: "error",
      deploymentId: "session-id-secret",
      errorCode: "free-text-secret",
      location: "local",
    },
  });
  const output = renderMetrics();
  assert.ok(
    samples(output, "llm_router_admissions_total").some((row) => row.labels.result === "other"),
  );
  assert.ok(
    samples(output, "llm_router_requests_total").some(
      (row) =>
        row.labels.priority === "other" &&
        row.labels.deployment === "other" &&
        row.labels.error === "other",
    ),
  );
  // Dispatched work with missing usage is counted as unknown, never as zero tokens.
  assert.ok(
    samples(output, "llm_router_usage_unknown_total").some(
      (row) => row.labels.deployment === "other" && row.labels.field === "prompt" && row.value > 0,
    ),
  );
  assert.equal(output.includes("surprise-secret-value"), false);
  assert.equal(output.includes("not-a-uuid-secret"), false);
  assert.equal(output.includes("session-id-secret"), false);
});

it("isolates metrics on a dedicated socket and never runs inference or admission on scrape", async () => {
  let scrapes = 0;
  const [server, duplicate] = await Promise.all([
    startMetricsListener(0, "127.0.0.1", async () => {
      scrapes++;
    }),
    startMetricsListener(0, "127.0.0.1", async () => {
      scrapes++;
    }),
  ]);
  assert.equal(duplicate, server);
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const metrics = await fetch(`${base}/metrics`);
    assert.equal(metrics.status, 200);
    assert.match(metrics.headers.get("content-type") ?? "", /text\/plain; version=0\.0\.4/);
    assert.equal(metrics.headers.get("cache-control"), "no-store");
    const text = await metrics.text();
    assert.ok(samples(text, "llm_router_build_info").length === 1);
    assert.deepEqual(
      samples(text, "llm_router_requests_in_flight")
        .map((row) => [row.labels.workload, row.value])
        .sort(),
      [
        ["batch", 0],
        ["interactive", 0],
      ],
    );
    assert.equal((await fetch(`${base}/other`)).status, 404);
    assert.equal((await fetch(`${base}/metrics`, { method: "POST" })).status, 405);
    assert.equal(scrapes, 1);
  } finally {
    await stopMetricsListener();
  }
});

it("counts a recovered stale lease once after its maintenance transaction commits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "router-stale-metrics-"));
  dirs.push(dir);
  const path = join(dir, "control.sqlite");
  const runtime = ManagedRuntime.make(
    apiKeysLayer.pipe(
      Layer.provideMerge(
        keyRepositoryLayer({ pepper: "metrics-pepper", onFinalized: observeFinalized }),
      ),
      Layer.provide(sqliteDatabaseLayer(path)),
    ),
  );
  const keyId = await runtime.runPromise(
    Effect.gen(function* () {
      const keys = yield* ApiKeys;
      const created = yield* keys.createKey({
        name: "stale",
        expiresAt: null,
        policy: POLICY_SUGGESTIONS.Standard,
      });
      yield* keys.admit(created.secret);
      return created.key.id;
    }),
  );
  const database = new DatabaseSync(path);
  database.exec("UPDATE requests SET lease_expires_at = 1 WHERE status = 'running'");
  database.close();
  await runtime.runPromise(
    Effect.gen(function* () {
      const keys = yield* ApiKeys;
      yield* keys.listKeys({ limit: 1 });
      yield* keys.listKeys({ limit: 1 });
    }),
  );
  await runtime.dispose();
  assert.equal(
    samples(renderMetrics(), "llm_router_requests_total")
      .filter((row) => row.labels.key_id === keyId && row.labels.status === "abandoned")
      .reduce((count, row) => count + row.value, 0),
    1,
  );
});

it("removes key metadata when a formerly active key is revoked", () => {
  const id = "49aa26f1-318c-48db-9f07-97d649a9076d";
  const empty = { keys: [], jobs: [], items: [], remotes: [] };
  observeSqlMetrics({
    ...empty,
    keyInfo: [
      {
        id,
        name: "sensitive-key-name",
        policyJson: JSON.stringify({
          priority: "high",
          cloud: true,
          requestsPerMinute: 10,
          maxConcurrent: 2,
        }),
      },
    ],
  });
  const info = samples(renderMetrics(), "llm_router_key_info").find(
    (row) => row.labels.key_id === id,
  );
  assert.equal(info?.labels.cloud, "true");
  assert.equal(info?.labels.overload_action, undefined);
  observeSqlMetrics({ ...empty, keyInfo: [] });
  assert.equal(
    samples(renderMetrics(), "llm_router_key_info").some((row) => row.labels.key_id === id),
    false,
  );
  assert.equal(renderMetrics().includes("sensitive-key-name"), false);
});

it("rejects an invalid or application-conflicting metrics port", () => {
  for (const port of ["3000", "0", "65536", "3.14"]) {
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--conditions=react-server",
        "--input-type=module",
        "-e",
        "import { getEnv } from './env.ts'; getEnv();",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          APP_ORIGIN: "http://127.0.0.1:3000",
          SQLITE_PATH: ":memory:",
          API_KEY_PEPPER: "test-pepper",
          MODEL_CATALOG: "catalog.example.json",
          PORT: "3000",
          METRICS_PORT: port,
        },
        encoding: "utf8",
      },
    );

    assert.notEqual(child.status, 0, `METRICS_PORT=${port} must fail validation`);
  }
});
it("counts a missing bearer as unauthorized before either admit or inference", async () => {
  const keys = memoryKeys();
  let admitCalls = 0;
  let inferenceCalls = 0;
  const originalAdmit = keys.admit;
  keys.admit = async (rawKey) => {
    admitCalls++;
    return originalAdmit(rawKey);
  };
  const before = samples(renderMetrics(), "llm_router_admissions_total")
    .filter((row) => row.labels.result === "unauthorized")
    .reduce((count, row) => count + row.value, 0);
  const deps = inferenceDeps(keys, {
    complete: async () => {
      inferenceCalls++;
      throw new Error("inference was called");
    },
    stream: async () => {
      inferenceCalls++;
      throw new Error("inference was called");
    },
  });
  deps.onAdmissionRejected = observeAdmission;
  const response = await handleChatCompletions(
    jsonRequest(`${ORIGIN}/v1/chat/completions`, {
      method: "POST",
      json: { model: "auto", messages: [{ role: "user", content: "private prompt" }] },
    }),
    deps,
  );
  assert.equal(response.status, 401);
  assert.equal(admitCalls, 0);
  assert.equal(inferenceCalls, 0);
  const after = samples(renderMetrics(), "llm_router_admissions_total")
    .filter((row) => row.labels.result === "unauthorized")
    .reduce((count, row) => count + row.value, 0);
  assert.equal(after - before, 1);
  assert.equal(renderMetrics().includes("private prompt"), false);
});
it("counts provider pin results with bounded labels without estimated savings", () => {
  const keyId = "12345678-1234-4234-8234-123456789abc";
  registerDeployments(["cloud-glm"]);
  observeFinalized({
    keyId,
    startedAt: Date.now(),
    priority: "high",
    outcome: {
      status: "success",
      deploymentId: "cloud-glm",
      location: "cloud",
      promptTokens: 120,
      cachedInputTokens: 30,
      cacheObservation: "observed-hit",
      estimatedCacheSavingsUsd: 99,
    },
  });
  observeFinalized({
    keyId: "12345678-1234-4234-8234-123456789abd",
    startedAt: Date.now(),
    priority: "high",
    outcome: {
      status: "success",
      deploymentId: "cloud-glm",
      location: "cloud",
      promptTokens: 50,
      cachedInputTokens: 0,
      cacheObservation: "observed-miss",
    },
  });
  observeFinalized({
    keyId: "12345678-1234-4234-8234-123456789abe",
    startedAt: Date.now(),
    priority: "high",
    outcome: {
      status: "success",
      deploymentId: "cloud-glm",
      location: "cloud",
      promptTokens: 20,
      cachedInputTokens: null,
      cacheObservation: "unknown",
    },
  });
  observeOpenRouterCompleted("cloud-glm", "match");
  observeOpenRouterCompleted("cloud-glm", "mismatch");
  observeOpenRouterCompleted("external-provider-secret", "unknown");
  const output = renderMetrics();
  assert.deepEqual(
    samples(output, "llm_router_tokens_total")
      .filter(
        (row) =>
          row.labels.key_id === keyId &&
          (row.labels.kind === "prompt" || row.labels.kind === "cached"),
      )
      .map((row) => [row.labels.kind, row.value])
      .sort(),
    [
      ["cached", 30],
      ["prompt", 120],
    ],
  );
  assert.deepEqual(
    samples(output, "llm_router_provider_pin_total")
      .filter((row) => row.labels.deployment === "cloud-glm")
      .map((row) => [row.labels.result, row.value])
      .sort(),
    [
      ["match", 1],
      ["mismatch", 1],
    ],
  );
  assert.deepEqual(
    samples(output, "llm_router_cache_observations_total")
      .filter((row) => row.labels.deployment === "cloud-glm")
      .map((row) => [row.labels.result, row.value])
      .sort(),
    [
      ["hit", 1],
      ["miss", 1],
      ["unknown", 1],
    ],
  );
  assert.deepEqual(
    samples(output, "llm_router_cost_usd_total")
      .filter((row) => row.labels.kind === "cache_savings" && row.labels.key_id === keyId)
      .map((row) => row.value),
    [],
  );
  assert.equal(output.includes("external-provider-secret"), false);
});
it("weights cache ratio by prompts with known cache usage and retains zero-hit series", () => {
  const eligible = "cache-ratio-fixture";
  const zero = "cache-zero-fixture";
  registerDeployments([eligible, zero]);
  for (const [index, deploymentId, cachedInputTokens] of [
    [0, eligible, 50],
    [1, eligible, null],
    [2, zero, 0],
  ] as const) {
    observeFinalized({
      keyId: `12345678-1234-4234-8234-123456789ab${index}`,
      startedAt: Date.now(),
      priority: "high",
      outcome: {
        status: "success",
        deploymentId,
        location: "cloud",
        promptTokens: 100,
        cachedInputTokens,
      },
    });
  }
  const output = renderMetrics();
  const byDeployment = (name: string, deployment: string) =>
    samples(output, name).filter((row) => row.labels.deployment === deployment);
  assert.deepEqual(
    byDeployment("llm_router_tokens_total", eligible)
      .filter((row) => row.labels.kind === "prompt" || row.labels.kind === "cached")
      .reduce(
        (totals, row) => ({
          ...totals,
          [row.labels.kind!]: (totals[row.labels.kind!] ?? 0) + row.value,
        }),
        {} as Record<string, number>,
      ),
    { prompt: 200, cached: 50 },
  );
  assert.deepEqual(
    byDeployment("llm_router_cache_eligible_prompt_tokens_total", eligible).map((row) => row.value),
    [100],
  );
  assert.deepEqual(
    byDeployment("llm_router_cache_eligible_prompt_tokens_total", zero).map((row) => row.value),
    [100],
  );
  assert.deepEqual(
    byDeployment("llm_router_tokens_total", zero)
      .filter((row) => row.labels.kind === "cached")
      .map((row) => row.value),
    [0],
  );
});
