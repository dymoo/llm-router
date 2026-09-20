import assert from "node:assert/strict";
import test from "node:test";
import { HttpFailure } from "../../src/http/errors.ts";
import { bearerToken, requireAdminMutation } from "../../src/http/security.ts";

test("admin mutations require exact origin and X-Jev-Admin", () => {
  const origin = "http://127.0.0.1:3100";
  assert.throws(
    () => requireAdminMutation(new Request(origin, { method: "POST" }), origin),
    HttpFailure,
  );
  assert.throws(
    () =>
      requireAdminMutation(
        new Request(origin, {
          method: "POST",
          headers: { origin: "http://evil.test", "x-jev-admin": "1" },
        }),
        origin,
      ),
    HttpFailure,
  );
  requireAdminMutation(
    new Request(origin, { method: "POST", headers: { origin, "x-jev-admin": "1" } }),
    origin,
  );
});

test("inference requires a bearer token", () => {
  assert.throws(
    () => bearerToken(new Request("http://127.0.0.1/v1/chat/completions")),
    HttpFailure,
  );
  assert.equal(
    bearerToken(
      new Request("http://127.0.0.1/v1/chat/completions", {
        headers: { authorization: "Bearer abc" },
      }),
    ),
    "abc",
  );
});
