import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cloudGlm, localQwen } from "./router/fixtures.ts";

const script = `
import assert from "node:assert/strict";
import { standardPolicy } from "./test/router/fixtures.ts";
let localDown = false;
let localBusy = false;
const generations = [];
globalThis.fetch = async (url, init) => {
  const local = String(url).includes("local-qwen");
  if (init?.method !== "POST") {
    if (localDown && local) throw new Error("Gufo planned downtime");
    return Response.json({ data: [{ id: "local-qwen-model" }] });
  }
  if (localBusy && local) return new Response(null, { status: 429, headers: { "retry-after": "301" } });
  const body = JSON.parse(init.body);
  generations.push({ local, body });
  return Response.json({ id: "cmpl-fixture", model: body.model,
    choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } });
};
// Test module-loading boundary: adapters must capture the fake fetch, never the network.
const { getInferenceDeps, disposeGateway } = await import("./server/runtime.ts");
const { keys, getAdminDeps } = await import("./server/control.ts");
const { renderMetrics, observeHealth } = await import("./server/metrics.ts");
const { gatewayHealth } = await import("./server/health.ts");
const { GET: readiness } = await import("./app/health/ready/route.ts");
const { handleHealth } = await import("./src/http/health.ts");
const { handleChatCompletions } = await import("./src/http/inference.ts");
try {
  const ready = await readiness();
  assert.equal(ready.status, 200);
  const health = await ready.json();
  const api = await handleHealth(new Request("http://127.0.0.1/api/health"), { health: { snapshot: gatewayHealth } });
  assert.deepEqual(await api.json(), health);
  for (const cloud of [false, true]) {
    const created = await keys.createKey({ name: "cloud-" + cloud, expiresAt: null,
      policy: { ...standardPolicy, cloud } });
    const send = (stream = false) => handleChatCompletions(new Request("http://127.0.0.1/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + created.secret },
      body: JSON.stringify({ model: "auto", stream, messages: [{ role: "user", content: "hi" }] }),
    }), getInferenceDeps());
    localDown = false;
    localBusy = false;
    const success = await send();
    const body = await success.json();
    assert.equal(success.status, 200, JSON.stringify({ body, rows: await keys.recentRequests({ limit: 10 }) }));
    assert.equal(body.choices[0].message.content, "done");
    assert.equal(generations.at(-1).local, true);
    assert.equal(generations.at(-1).body.reasoning_effort, "off");
    const rows = await keys.recentRequests({ keyId: created.key.id, limit: 10 });
    const row = rows.items[0];
    assert.equal(row.classifierBackend, null);
    assert.equal(row.taskKind, null);
    assert.equal(row.difficulty, null);
    assert.equal(row.decisionReason, "local-preference");
    assert.equal(row.decisionTrace.selectionReason.code, "local-preference");
    assert.equal(row.decisionTrace.cloud, cloud);
    for (const failure of ["down", "busy"]) {
      localDown = failure === "down";
      localBusy = failure === "busy";
      const before = generations.length;
      const unavailable = await send();
      assert.equal(unavailable.status, cloud ? 200 : 503);
      if (!cloud) {
        assert.equal((await unavailable.json()).error.code, "local_overloaded");
        if (localBusy) assert.equal(unavailable.headers.get("retry-after"), "301");
        const sse = await send(true);
        assert.equal(sse.status, 200);
        const text = await sse.text();
        assert.match(text, /event: router.error/);
        assert.match(text, /"code":"local_overloaded"/);
        assert.equal(generations.length, before);
      } else {
        assert.equal(generations.at(-1).local, false);
        assert.equal(generations.length, before + 1);
      }
    }
  }
  observeHealth(health);
  const metrics = renderMetrics();
  assert.ok(metrics.includes('reason="local-preference"'));
  assert.ok(metrics.includes('reason="local-overload-failover"'));
  assert.equal(metrics.includes('llm_router_classifications_total{'), false);
  console.log("runtime HTTP, readiness, accounting and cloud switch passed");
} finally { await disposeGateway(); }
`;

{
  test("runtime: HTTP, health, accounting and the cloud switch", () => {
    const directory = mkdtempSync(join(tmpdir(), "router-rules-"));
    try {
      const catalogue = join(directory, "catalogue.json");
      writeFileSync(
        catalogue,
        JSON.stringify([
          { ...localQwen, transport: "gufo", credentialEnvVar: "GUFO_TEST_KEY" },
          cloudGlm,
        ]),
      );
      const child = spawnSync(
        process.execPath,
        ["--import", "tsx", "--conditions=react-server", "--input-type=module", "-e", script],
        {
          encoding: "utf8",
          timeout: 30_000,
          env: {
            ...process.env,
            APP_ORIGIN: "http://127.0.0.1",
            API_KEY_PEPPER: "fixture-pepper",
            SQLITE_PATH: join(directory, "router.sqlite"),
            MODEL_CATALOG: catalogue,
            GUFO_TEST_KEY: "fixture-key",
            METRICS_PORT: "",
            AUXILIARY_CATALOG: "",
            BATCH_CATALOG: "",
            BATCH_RESULTS_DIR: "",
          },
        },
      );
      assert.equal(child.status, 0, child.stdout + child.stderr);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
