import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLOUD_SPILL_DELAY_MS,
  SPILL_WINDOW_MS,
  hasSpilled,
  spillAtFor,
} from "../../src/batch/spill.ts";

test("a cloud job spills after the local-first delay; a local-only job never spills", () => {
  assert.equal(spillAtFor(1_000, true), 1_000 + CLOUD_SPILL_DELAY_MS);
  // Local-only: spillAt is creation, so expiry (spillAt + window) ends the 24h window.
  assert.equal(spillAtFor(1_000, false), 1_000);
  assert.equal(SPILL_WINDOW_MS, 24 * 60 * 60 * 1000);
  assert.equal(hasSpilled({ cloud: false, spillAt: 1_000 }, 1_000 + SPILL_WINDOW_MS), false);
});

test("hasSpilled boundary: eligible at spillAt and after, not before", () => {
  assert.equal(hasSpilled({ cloud: true, spillAt: 100 }, 99), false);
  assert.equal(hasSpilled({ cloud: true, spillAt: 100 }, 100), true);
  assert.equal(hasSpilled({ cloud: true, spillAt: 100 }, 101), true);
});
