import assert from "node:assert/strict";
import test from "node:test";
import { RULES_CLASSIFIER } from "../../src/http/contracts.ts";
import { handleHealth } from "../../src/http/health.ts";

test("health reports readiness without credentials", async () => {
  const response = await handleHealth(new Request("http://127.0.0.1/api/health"), {
    health: {
      snapshot: async () => ({ ready: false, classifier: RULES_CLASSIFIER, deployments: [] }),
    },
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { ready: boolean; classifier: { backend: string } };
  assert.equal(body.ready, false);
  assert.equal(body.classifier.backend, "rules");
});
