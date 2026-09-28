import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { effortFor, mapAppliedEffort } from "../../src/router/effort.ts";
import { cloudGlm, deployment, localQwen } from "./fixtures.ts";

describe("reasoning_effort", () => {
  it("reports binary thinking as on rather than an invented high", () => {
    const binary = { ...cloudGlm, reasoning: { kind: "binary" as const } };
    assert.equal(mapAppliedEffort("high", binary), "on");
    assert.equal(mapAppliedEffort("none", binary), "none");
  });

  it("maps a requested effort onto the next level the deployment supports", () => {
    assert.equal(mapAppliedEffort("high", localQwen), "xhigh");
    assert.equal(mapAppliedEffort("xhigh", localQwen), "xhigh");
    assert.equal(mapAppliedEffort("medium", localQwen), "medium");
    const gufo = deployment({
      id: "gufo",
      location: "local",
      transport: "gufo",
      reasoning: { kind: "graded", levels: ["none", "low", "medium"] },
    });
    assert.deepEqual(effortFor("xhigh", gufo), {
      requestedEffort: "xhigh",
      appliedEffort: "medium",
    });
  });

  it("defaults to the deployment's cheapest effort when the client sends none", () => {
    assert.deepEqual(effortFor(undefined, localQwen), {
      requestedEffort: "none",
      appliedEffort: "none",
    });
    const mandatory = { ...cloudGlm, reasoning: { kind: "mandatory" as const } };
    assert.deepEqual(effortFor(undefined, mandatory), {
      requestedEffort: "low",
      appliedEffort: "on",
    });
  });

  it("runs a deployment that cannot think without thinking rather than refusing it", () => {
    const plain = { ...cloudGlm, reasoning: { kind: "none" as const } };
    assert.deepEqual(effortFor("high", plain), { requestedEffort: "high", appliedEffort: "none" });
  });
});
