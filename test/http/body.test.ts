import assert from "node:assert/strict";
import test from "node:test";
import { readJsonObject, rejectCompressedBody } from "../../src/http/body.ts";
import { InvalidInput } from "../../src/http/errors.ts";

test("rejects compressed bodies", () => {
  const request = new Request("http://127.0.0.1/x", {
    method: "POST",
    headers: { "content-encoding": "gzip" },
    body: "{}",
  });
  assert.throws(() => rejectCompressedBody(request), InvalidInput);
});

test("rejects bodies larger than the cap", async () => {
  const request = new Request("http://127.0.0.1/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "x".repeat(64),
  });
  await assert.rejects(
    () => readJsonObject(request, { maxBytes: 8, timeoutMs: 1_000 }),
    InvalidInput,
  );
});

test("times out a stalled body", async () => {
  const request = new Request("http://127.0.0.1/x", {
    method: "POST",
    ...{ duplex: "half" },
    headers: { "content-type": "application/json" },
    body: new ReadableStream({
      start() {},
    }),
  });
  await assert.rejects(
    () => readJsonObject(request, { maxBytes: 1024, timeoutMs: 20 }),
    InvalidInput,
  );
});
