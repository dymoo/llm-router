import assert from "node:assert/strict";
import test from "node:test";
import { handleHealth } from "../../src/http/health.ts";

test("health reports classifier status without credentials", async () => {
  const response = await handleHealth(new Request("http://127.0.0.1/api/health"), {
    health: {
      snapshot: async () => ({
        ready: false,
        classifier: { ready: false, backend: "laya", local: true },
        deployments: [],
      }),
    },
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { ready: boolean; classifier: { backend: string } };
  assert.equal(body.ready, false);
  assert.equal(body.classifier.backend, "laya");
});
