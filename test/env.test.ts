import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const baseEnv = {
  ...process.env,
  APP_ORIGIN: "http://127.0.0.1:3000",
  SQLITE_PATH: ":memory:",
  MODEL_CATALOG: "./catalog.example.json",
  API_KEY_PEPPER: "test-pepper-not-a-production-credential",
  CLASSIFIER_MODE: "laya",
  CLASSIFIER_QUALIFICATION: "",
  ADMIN_BASIC_AUTH: "",
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
    'import { getEnv } from "./env.ts"; const env=getEnv(); console.log(JSON.stringify({ mode:env.CLASSIFIER_MODE, qualification:env.CLASSIFIER_QUALIFICATION ?? null, basic:env.ADMIN_BASIC_AUTH!==undefined, username:env.ADMIN_BASIC_AUTH?.username, passwordLength:env.ADMIN_BASIC_AUTH?.password.length }));',
    overrides,
  );
}

test("typed configuration accepts absent Basic auth and keeps credentials out of output", () => {
  const result = inspect({});
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { mode: "laya", qualification: null, basic: false });
  assert.equal(result.stdout.includes(baseEnv.API_KEY_PEPPER), false);
});

test("optional qualification evidence path survives and empty stays absent", () => {
  const configured = inspect({ CLASSIFIER_QUALIFICATION: "/etc/llm-router/qualification.json" });
  assert.equal(configured.status, 0, configured.stderr);
  assert.deepEqual(
    JSON.parse(configured.stdout).qualification,
    "/etc/llm-router/qualification.json",
  );

  const empty = inspect({ CLASSIFIER_QUALIFICATION: "" });
  assert.equal(empty.status, 0, empty.stderr);
  assert.deepEqual(JSON.parse(empty.stdout).qualification, null);
});

test("optional Basic auth keeps colons in its password", () => {
  const result = inspect({ ADMIN_BASIC_AUTH: "operator:private:credential" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    mode: "laya",
    qualification: null,
    basic: true,
    username: "operator",
    passwordLength: 18,
  });
  assert.equal(result.stdout.includes("private:credential"), false);
});

test("malformed Basic auth and invalid backend configuration fail closed", () => {
  for (const overrides of [
    { ADMIN_BASIC_AUTH: "missing-colon" },
    { ADMIN_BASIC_AUTH: ":password" },
    { CLASSIFIER_MODE: "automatic" },
    { APP_ORIGIN: "not-a-url" },
  ]) {
    const result = inspect(overrides);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout.includes(baseEnv.API_KEY_PEPPER), false);
  }
});
