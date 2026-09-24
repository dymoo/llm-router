import assert from "node:assert/strict";
import test from "node:test";
import {
  handleCreateKey,
  handleListKeys,
  handleUpdateKey,
  handleUsage,
} from "../../src/http/admin.ts";
import type { AdminDeps, AnalyticsSnapshot, KeyService } from "../../src/http/contracts.ts";
import { decodeKeyDraft, decodeKeyPatch } from "../../src/http/decode.ts";
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

test("legacy create defaults to report while legacy PATCH leaves the stored action intact", async () => {
  const { overloadAction: _omitted, ...legacyPolicy } = samplePolicy();
  assert.equal(
    decodeKeyDraft({ name: "legacy", policy: legacyPolicy }).policy.overloadAction,
    "report",
  );
  assert.equal(
    decodeKeyDraft({ name: "opted in", policy: { ...legacyPolicy, overloadAction: "failover" } })
      .policy.overloadAction,
    "failover",
  );
  const patch = decodeKeyPatch({
    expectedVersion: 1,
    name: "legacy edited",
    expiresAt: null,
    policy: legacyPolicy,
  });
  assert.equal("overloadAction" in patch.policy, false);

  const keys = memoryKeys();
  const created = await handleCreateKey(
    jsonRequest(ORIGIN + "/api/admin/keys", {
      method: "POST",
      headers: { origin: ORIGIN, "x-jev-admin": "1" },
      json: { name: "legacy", policy: legacyPolicy },
    }),
    adminDeps(keys),
  );
  assert.equal(created.status, 201);
  const body = (await created.json()) as { key: { policy: { overloadAction: string } } };
  assert.equal(body.key.policy.overloadAction, "report");

  const optedIn = memoryKeys();
  await optedIn.createKey({
    name: "opted in",
    expiresAt: null,
    policy: samplePolicy({ overloadAction: "failover" }),
  });
  const edited = await handleUpdateKey(
    jsonRequest(ORIGIN + "/api/admin/keys/key-1", {
      method: "PATCH",
      headers: { origin: ORIGIN, "x-jev-admin": "1" },
      json: { expectedVersion: 1, name: "legacy edited", expiresAt: null, policy: legacyPolicy },
    }),
    adminDeps(optedIn),
    "key-1",
  );
  assert.equal(edited.status, 200);
  const editedBody = (await edited.json()) as { key: { policy: { overloadAction: string } } };
  assert.equal(editedBody.key.policy.overloadAction, "failover");
});

test("unknown overload actions are rejected on create and PATCH", async () => {
  const policy = { ...samplePolicy(), overloadAction: "always-cloud" };
  assert.throws(() => decodeKeyDraft({ name: "invalid", policy }), /overloadAction/);
  assert.throws(
    () => decodeKeyPatch({ expectedVersion: 1, name: "invalid", policy }),
    /overloadAction/,
  );
  const response = await handleCreateKey(
    jsonRequest(ORIGIN + "/api/admin/keys", {
      method: "POST",
      headers: { origin: ORIGIN, "x-jev-admin": "1" },
      json: { name: "invalid", policy },
    }),
    adminDeps(memoryKeys()),
  );
  assert.equal(response.status, 400);
  const patchResponse = await handleUpdateKey(
    jsonRequest(ORIGIN + "/api/admin/keys/key-1", {
      method: "PATCH",
      headers: { origin: ORIGIN, "x-jev-admin": "1" },
      json: { expectedVersion: 1, name: "invalid", expiresAt: null, policy },
    }),
    adminDeps(memoryKeys()),
    "key-1",
  );
  assert.equal(patchResponse.status, 400);
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

test("usage forwards the AdminDeps classifier qualifications into analytics", async () => {
  const classifierQualifications: AdminDeps["classifierQualifications"] = [];
  let observedQuery: { since?: number; until?: number } | undefined;
  let observedQualifications: readonly unknown[] | undefined;
  const keys: KeyService = {
    ...memoryKeys(),
    analytics: async (query, qualifications) => {
      observedQuery = query;
      observedQualifications = qualifications;
      return { marker: "usage" } as unknown as AnalyticsSnapshot;
    },
  };
  const deps: AdminDeps = { appOrigin: ORIGIN, keys, classifierQualifications };
  const response = await handleUsage(
    new Request(`${ORIGIN}/api/admin/usage?since=1000&until=2000`),
    deps,
  );
  assert.equal(response.status, 200);
  assert.equal(observedQualifications, classifierQualifications);
  assert.equal(observedQuery?.since, 1000);
  assert.equal(observedQuery?.until, 2000);
  assert.deepEqual(await response.json(), { marker: "usage" });
});
