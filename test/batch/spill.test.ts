import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SPILL_MAX_DELAY_MS,
  SPILL_MIN_DELAY_MS,
  SPILL_WINDOW_MS,
  hasSpilled,
  spillAtFor,
  spillDelayMs,
} from "../../src/batch/spill.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

test("spill delay table: localityBias 0/1 hit the clamps", () => {
  assert.equal(spillDelayMs(0), SPILL_MIN_DELAY_MS); // 5min floor (cloud-preferred spills early)
  assert.equal(spillDelayMs(1), SPILL_MAX_DELAY_MS); // 23h55m ceiling (local-until-saturated spills late)
  assert.equal(SPILL_WINDOW_MS, 24 * HOUR);
  assert.equal(SPILL_MIN_DELAY_MS, 5 * MINUTE);
  assert.equal(SPILL_MAX_DELAY_MS, 24 * HOUR - 5 * MINUTE);
});

test("spill delay table: representative biases", () => {
  const table: ReadonlyArray<readonly [number, number]> = [
    [0.15, 3.6 * HOUR],
    [0.5, 12 * HOUR],
    [0.65, 15.6 * HOUR],
    [0.95, 22.8 * HOUR],
    [0.99, 23.76 * HOUR],
  ];
  for (const [bias, expected] of table) {
    assert.equal(spillDelayMs(bias), expected, `bias ${bias}`);
  }
});

test("spill delays are always integer milliseconds", () => {
  // 86_400_000 × 0.65 === 56_159_999.99999999 in IEEE-754 — the delay must round to an
  // integer or ledger.create() rejects a fractional spillAt.
  for (const bias of [0, 0.15, 0.5, 0.65, 0.7, 0.95, 1, 0.333333, 0.1, 0.05]) {
    const delay = spillDelayMs(bias);
    assert.ok(Number.isInteger(delay), `bias ${bias} produced ${delay}`);
  }
});

test("spill delay clamps out-of-range and non-finite biases", () => {
  assert.equal(spillDelayMs(-3), SPILL_MIN_DELAY_MS);
  assert.equal(spillDelayMs(2), SPILL_MAX_DELAY_MS);
  assert.equal(spillDelayMs(Number.NaN), SPILL_MIN_DELAY_MS);
});

test("spillAtFor anchors the delay at createdAt", () => {
  assert.equal(spillAtFor(1_000, 0), 1_000 + SPILL_MIN_DELAY_MS);
  assert.equal(spillAtFor(1_000, 1), 1_000 + SPILL_MAX_DELAY_MS);
  assert.equal(spillAtFor(0, 0.65), 15.6 * HOUR);
  assert.ok(Number.isInteger(spillAtFor(12_345, 0.65)));
});

test("hasSpilled boundary: eligible at spillAt and after, not before", () => {
  assert.equal(hasSpilled(100, 99), false);
  assert.equal(hasSpilled(100, 100), true);
  assert.equal(hasSpilled(100, 101), true);
});
