import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canDisableReasoning,
  mapAppliedEffort,
  pinRequestedEffort,
  resolveRequestedEffort,
} from "../../src/router/effort.ts";
import { cloudGlm, easyLocalCoding, greeting, hardCoding, localQwen } from "./fixtures.ts";

describe("reasoning policy", () => {
  it("never disables thinking for coding", () => {
    const requested = resolveRequestedEffort({
      assessment: easyLocalCoding,
      qualityBias: 0.5,
      tools: true,
      json: false,
      vision: false,
      boundary: "new-task",
    });
    assert.notEqual(requested, "none");
    assert.equal(
      canDisableReasoning({
        assessment: easyLocalCoding,
        qualityBias: 0.5,
        tools: true,
        json: false,
        vision: false,
        boundary: "new-task",
      }),
      false,
    );
  });

  it("allows none only for a literal greeting on a new task", () => {
    const requested = resolveRequestedEffort({
      assessment: greeting,
      qualityBias: 0.5,
      tools: false,
      json: false,
      vision: false,
      boundary: "new-task",
    });
    assert.equal(requested, "none");
  });

  it("does not let a greeting none pin survive into coding", () => {
    const continued = resolveRequestedEffort({
      assessment: greeting,
      qualityBias: 0.5,
      tools: true,
      json: false,
      vision: false,
      boundary: "continue",
      pinRequestedEffort: pinRequestedEffort("none"),
    });
    assert.equal(continued, "low");
    assert.notEqual(continued, "none");
  });

  it("reports binary thinking as on rather than an invented high", () => {
    const binary = { ...cloudGlm, reasoning: { kind: "binary" as const } };
    assert.equal(mapAppliedEffort("high", binary), "on");
    assert.equal(mapAppliedEffort("none", binary), "none");
  });

  it("maps Halogen high onto xhigh", () => {
    assert.equal(mapAppliedEffort("high", localQwen), "xhigh");
    assert.equal(mapAppliedEffort("xhigh", localQwen), "xhigh");
    assert.equal(mapAppliedEffort("medium", localQwen), "medium");
  });

  it("floors hard tasks at high effort", () => {
    const requested = resolveRequestedEffort({
      assessment: hardCoding,
      qualityBias: 0.5,
      tools: true,
      json: false,
      vision: false,
      boundary: "new-task",
    });
    assert.equal(requested, "high");
  });
});
