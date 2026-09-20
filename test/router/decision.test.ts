import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideReason } from "../../src/router/decision.ts";
import { cloudSpillPermitted, UNKNOWN_SATURATION } from "../../src/router/locality.ts";
import { dylanPolicy, freePolicy, hardCoding, easyLocalCoding } from "./fixtures.ts";

describe("route decision reasons", () => {
  it("uses pinned for continuations, not local-preference", () => {
    assert.equal(
      decideReason({
        pinned: true,
        qualityOverride: false,
        queued: false,
        selectedLocation: "local",
        spilledForSaturation: false,
        spilledForComplexity: false,
      }),
      "pinned",
    );
    assert.equal(
      decideReason({
        pinned: false,
        qualityOverride: false,
        queued: false,
        selectedLocation: "local",
        spilledForSaturation: false,
        spilledForComplexity: false,
      }),
      "local-preference",
    );
  });

  it("uses complexity-escalation when a hard task goes to cloud", () => {
    assert.equal(
      decideReason({
        pinned: false,
        qualityOverride: false,
        queued: false,
        selectedLocation: "cloud",
        spilledForSaturation: false,
        spilledForComplexity: true,
      }),
      "complexity-escalation",
    );
  });

  it("uses local-saturation only with verified telemetry, never unknown", () => {
    assert.equal(
      cloudSpillPermitted(freePolicy, easyLocalCoding, UNKNOWN_SATURATION, "new-task"),
      false,
    );
    assert.equal(
      cloudSpillPermitted(
        freePolicy,
        easyLocalCoding,
        { verified: true, saturated: true },
        "new-task",
      ),
      true,
    );
    assert.equal(
      decideReason({
        pinned: false,
        qualityOverride: false,
        queued: false,
        selectedLocation: "cloud",
        spilledForSaturation: true,
        spilledForComplexity: false,
      }),
      "local-saturation",
    );
  });

  it("uses highest-quality only for the explicit override path", () => {
    assert.equal(
      decideReason({
        pinned: false,
        qualityOverride: true,
        queued: false,
        selectedLocation: "cloud",
        spilledForSaturation: false,
        spilledForComplexity: false,
      }),
      "highest-quality",
    );
  });

  it("lets Dylan cloud-first spill without claiming saturation", () => {
    assert.equal(
      cloudSpillPermitted(dylanPolicy, hardCoding, UNKNOWN_SATURATION, "new-task"),
      true,
    );
    assert.equal(
      cloudSpillPermitted(dylanPolicy, hardCoding, UNKNOWN_SATURATION, "continue"),
      false,
    );
  });
});
