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
  ADMIN_BASIC_AUTH: "",
};

function inspect(overrides: Record<string, string | undefined>) {
  return spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--conditions=react-server",
      "--input-type=module",
      "-e",
      'import { getEnv } from "./env.ts"; const env=getEnv(); console.log(JSON.stringify({ mode:env.CLASSIFIER_MODE, basic:env.ADMIN_BASIC_AUTH!==undefined, username:env.ADMIN_BASIC_AUTH?.username, passwordLength:env.ADMIN_BASIC_AUTH?.password.length }));',
    ],
    { cwd: process.cwd(), env: { ...baseEnv, ...overrides }, encoding: "utf8" },
  );
}

test("typed configuration accepts absent Basic auth and keeps credentials out of output", () => {
  const result = inspect({});
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { mode: "laya", basic: false });
  assert.equal(result.stdout.includes(baseEnv.API_KEY_PEPPER), false);
});

test("optional Basic auth keeps colons in its password", () => {
  const result = inspect({ ADMIN_BASIC_AUTH: "operator:private:credential" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    mode: "laya",
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
