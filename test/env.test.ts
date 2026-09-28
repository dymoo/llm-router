import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const baseEnv = {
  ...process.env,
  APP_ORIGIN: "http://127.0.0.1:3000",
  SQLITE_PATH: ":memory:",
  MODEL_CATALOG: "./catalog.example.json",
  API_KEY_PEPPER: "test-pepper-not-a-production-credential",
  BATCH_CATALOG: "",
  BATCH_RESULTS_DIR: "",
};

function evaluate(script: string, overrides: Record<string, string | undefined>) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "--conditions=react-server", "--input-type=module", "-e", script],
    { cwd: process.cwd(), env: { ...baseEnv, ...overrides }, encoding: "utf8" },
  );
}

function inspect(overrides: Record<string, string | undefined>) {
  return evaluate(
    'import { getEnv } from "./env.ts"; const env=getEnv(); console.log(JSON.stringify({ origin: env.APP_ORIGIN, catalogue: env.MODEL_CATALOG }));',
    overrides,
  );
}

test("typed configuration keeps credentials out of output", () => {
  const result = inspect({});
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    origin: "http://127.0.0.1:3000",
    catalogue: "./catalog.example.json",
  });
  assert.equal(result.stdout.includes(baseEnv.API_KEY_PEPPER), false);
});

test("invalid configuration fails closed", () => {
  for (const overrides of [{ APP_ORIGIN: "not-a-url" }, { MODEL_CATALOG: "" }]) {
    const result = inspect(overrides);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout.includes(baseEnv.API_KEY_PEPPER), false);
  }
});

test("batch catalogue and content-directory entries are optional; configured values survive", () => {
  const script =
    'import { getEnv } from "./env.ts"; const env=getEnv(); console.log(JSON.stringify({ catalog: env.BATCH_CATALOG ?? null, results: env.BATCH_RESULTS_DIR ?? null }));';
  const configured = evaluate(script, {
    BATCH_CATALOG: "/etc/llm-router/batch-catalog.json",
    BATCH_RESULTS_DIR: "/var/lib/llm-router/batch-content",
  });
  assert.equal(configured.status, 0, configured.stderr);
  assert.deepEqual(JSON.parse(configured.stdout), {
    catalog: "/etc/llm-router/batch-catalog.json",
    results: "/var/lib/llm-router/batch-content",
  });
  // An operator who uncomments the override but leaves it blank must still boot.
  const blank = evaluate(script, {});
  assert.equal(blank.status, 0, blank.stderr);
  assert.deepEqual(JSON.parse(blank.stdout), { catalog: null, results: null });
});
