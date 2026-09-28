import assert from "node:assert/strict";
import test from "node:test";
import {
  handleCreateKey,
  handleListKeys,
  handleUpdateKey,
  handleUsage,
} from "../../src/http/admin.ts";
import type { AnalyticsSnapshot, KeyService } from "../../src/http/contracts.ts";
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

test("create and PATCH take exactly { priority, cloud, requestsPerMinute, maxConcurrent }", async () => {
  const policy = { priority: "high", cloud: true, requestsPerMinute: 120, maxConcurrent: 4 };
  assert.deepEqual(decodeKeyDraft({ name: "agent", expiresAt: null, policy }).policy, policy);
  const patch = decodeKeyPatch({ expectedVersion: 1, name: "agent", expiresAt: null, policy });
  assert.deepEqual(patch, { name: "agent", expiresAt: null, policy, expectedVersion: 1 });

  const keys = memoryKeys();
  const created = await handleCreateKey(
    jsonRequest(ORIGIN + "/api/admin/keys", {
      method: "POST",
      headers: { origin: ORIGIN, "x-jev-admin": "1" },
      json: { name: "agent", expiresAt: null, policy },
    }),
    adminDeps(keys),
  );
  assert.equal(created.status, 201);
  assert.deepEqual(((await created.json()) as { key: { policy: unknown } }).key.policy, policy);
  const edited = await handleUpdateKey(
    jsonRequest(ORIGIN + "/api/admin/keys/key-1", {
      method: "PATCH",
      headers: { origin: ORIGIN, "x-jev-admin": "1" },
      json: {
        expectedVersion: 1,
        name: "agent",
        expiresAt: null,
        policy: { ...policy, cloud: false },
      },
    }),
    adminDeps(keys),
    "key-1",
  );
  assert.equal(edited.status, 200);
  assert.deepEqual(((await edited.json()) as { key: { policy: unknown } }).key.policy, {
    ...policy,
    cloud: false,
  });
});

test("removed policy fields are rejected on create and PATCH", async () => {
  for (const removed of [
    { overloadAction: "failover" },
    { localityBias: 0.5 },
    { maxWaitMs: 0 },
    { allowedModels: null },
    { contextLimitTokens: 65_536 },
    { maxCompletionTokens: 8_192 },
    { maxEstimatedUsd: null },
    { bias: { cost: 1, quality: 1, latency: 1 } },
  ]) {
    const policy = { ...samplePolicy(), ...removed };
    assert.throws(() => decodeKeyDraft({ name: "invalid", policy }), /unsupported field/);
    const response = await handleUpdateKey(
      jsonRequest(ORIGIN + "/api/admin/keys/key-1", {
        method: "PATCH",
        headers: { origin: ORIGIN, "x-jev-admin": "1" },
        json: { expectedVersion: 1, name: "invalid", expiresAt: null, policy },
      }),
      adminDeps(memoryKeys()),
      "key-1",
    );
    assert.equal(response.status, 400, JSON.stringify(removed));
  }
});

test("admin rejects policy values outside the domain limits before storing a key", async () => {
  for (const override of [
    { requestsPerMinute: -1 },
    { maxConcurrent: -1 },
    { maxConcurrent: 1.5 },
    { priority: "urgent" as "high" },
    { cloud: "yes" as unknown as boolean },
  ]) {
    const keys = memoryKeys();
    const response = await handleCreateKey(
      jsonRequest(ORIGIN + "/api/admin/keys", {
        method: "POST",
        headers: { origin: ORIGIN, "x-jev-admin": "1" },
        json: { name: "invalid", policy: samplePolicy(override) },
      }),
      adminDeps(keys),
    );
    assert.equal(response.status, 400, JSON.stringify(override));
    assert.equal((await keys.listKeys({ limit: 1 })).items.length, 0, JSON.stringify(override));
  }
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

test("usage forwards the query window into analytics", async () => {
  let observedQuery: { since?: number; until?: number } | undefined;
  const keys: KeyService = {
    ...memoryKeys(),
    analytics: async (query) => {
      observedQuery = query;
      return { marker: "usage" } as unknown as AnalyticsSnapshot;
    },
  };
  const response = await handleUsage(
    new Request(`${ORIGIN}/api/admin/usage?since=1000&until=2000`),
    { appOrigin: ORIGIN, keys },
  );
  assert.equal(response.status, 200);
  assert.equal(observedQuery?.since, 1000);
  assert.equal(observedQuery?.until, 2000);
  assert.deepEqual(await response.json(), { marker: "usage" });
});
