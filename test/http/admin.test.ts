import assert from "node:assert/strict";
import test from "node:test";
import { handleCreateKey, handleListKeys, handleUpdateKey } from "../../src/http/admin.ts";
import { adminDeps, jsonRequest, memoryKeys, ORIGIN, samplePolicy } from "./helpers.ts";

test("lists keys without a session cookie", async () => {
  const keys = memoryKeys();
  await keys.createKey({ name: "a", expiresAt: null, policy: samplePolicy() });
  const response = await handleListKeys(new Request(`${ORIGIN}/api/admin/keys`), adminDeps(keys));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = (await response.json()) as { items: unknown[] };
  assert.equal(body.items.length, 1);
});

test("mutations require origin and X-Jev-Admin", async () => {
  const keys = memoryKeys();
  const missing = await handleCreateKey(
    jsonRequest(`${ORIGIN}/api/admin/keys`, {
      method: "POST",
      json: { name: "a", expiresAt: null, policy: samplePolicy() },
    }),
    adminDeps(keys),
  );
  assert.equal(missing.status, 403);
  const created = await handleCreateKey(
    jsonRequest(`${ORIGIN}/api/admin/keys`, {
      method: "POST",
      headers: { origin: ORIGIN, "x-jev-admin": "1" },
      json: { name: "a", expiresAt: null, policy: samplePolicy() },
    }),
    adminDeps(keys),
  );
  assert.equal(created.status, 201);
  const payload = (await created.json()) as { secret: string };
  assert.match(payload.secret, /^jrv_/);
});

test("stale edits return stale_version without leaking secrets", async () => {
  const keys = memoryKeys();
  await keys.createKey({ name: "a", expiresAt: null, policy: samplePolicy() });
  const response = await handleUpdateKey(
    jsonRequest(`${ORIGIN}/api/admin/keys/key-1`, {
      method: "PATCH",
      headers: { origin: ORIGIN, "x-jev-admin": "1" },
      json: { expectedVersion: 99, name: "b", expiresAt: null, policy: samplePolicy() },
    }),
    adminDeps(keys),
    "key-1",
  );
  assert.equal(response.status, 409);
  const body = (await response.json()) as { error: { code: string; message: string } };
  assert.equal(body.error.code, "stale_version");
  assert.equal(body.error.message.includes("jrv_"), false);
});

test("basic auth challenges when configured", async () => {
  const keys = memoryKeys();
  const response = await handleListKeys(
    new Request(`${ORIGIN}/api/admin/keys`),
    adminDeps(keys, { username: "dylan", password: "secret" }),
  );
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("www-authenticate"), 'Basic realm="llm-router"');
});
