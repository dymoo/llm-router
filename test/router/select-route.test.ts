import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { selectRoute } from "../../src/router/select-route.ts";
import {
  balancedPolicy,
  catalogue,
  cloudGlm,
  dylanPolicy,
  easyLocalCoding,
  freePolicy,
  frontier,
  hardCoding,
  localQwen,
} from "./fixtures.ts";

const base = {
  deployments: catalogue,
  inputTokens: 800,
  generationAllowance: 1024,
  tools: true,
  json: false,
  vision: false,
  boundary: "new-task" as const,
  freshFactsAvailable: false,
};

describe("selectRoute", () => {
  it("routes simple eligible coding to local", () => {
    const result = selectRoute({
      ...base,
      assessment: easyLocalCoding,
      policy: balancedPolicy,
      preferredLocation: "local",
    });
    assert.equal(result._tag, "Selected");
    if (result._tag !== "Selected") return;
    assert.equal(result.ranked[0]?.deployment.id, "local-qwen");
    assert.ok(result.ranked.some((candidate) => candidate.deployment.id === "cloud-glm"));
  });

  it("routes hard coding to GLM without requiring frontier", () => {
    const result = selectRoute({
      ...base,
      assessment: hardCoding,
      policy: dylanPolicy,
      preferredLocation: "cloud",
      deployments: [localQwen, cloudGlm],
    });
    assert.equal(result._tag, "Selected");
    if (result._tag !== "Selected") return;
    assert.equal(result.ranked[0]?.deployment.id, "cloud-glm");
    assert.ok(!result.ranked.some((candidate) => candidate.deployment.id === "local-qwen"));
    assert.ok(!result.denials.some((denial) => denial.deploymentId === "cloud-glm"));
  });

  it("never ranks denied candidates", () => {
    const result = selectRoute({
      ...base,
      assessment: easyLocalCoding,
      policy: { ...balancedPolicy, allowedModels: ["local-qwen"] },
      deployments: [cloudGlm, localQwen],
    });
    assert.equal(result._tag, "Selected");
    if (result._tag !== "Selected") return;
    assert.ok(!result.ranked.some((candidate) => candidate.deployment.id === "cloud-glm"));
    assert.ok(
      result.denials.some(
        (denial) => denial.deploymentId === "cloud-glm" && denial.code === "allowlist",
      ),
    );
  });

  it("does not grant a cache discount from a pin without authenticated evidence", () => {
    const withEvidence = selectRoute({
      ...base,
      assessment: easyLocalCoding,
      policy: dylanPolicy,
      cacheEvidence: { deploymentId: "cloud-glm", cachedInputTokens: 800, authenticated: true },
      deployments: [cloudGlm],
    });
    const without = selectRoute({
      ...base,
      assessment: easyLocalCoding,
      policy: dylanPolicy,
      deployments: [cloudGlm],
    });
    assert.equal(withEvidence._tag, "Selected");
    assert.equal(without._tag, "Selected");
    if (withEvidence._tag !== "Selected" || without._tag !== "Selected") return;
    assert.ok((withEvidence.ranked[0]?.estimatedUsd ?? 1) < (without.ranked[0]?.estimatedUsd ?? 0));
  });

  it("enforces the cold-cache estimate ceiling", () => {
    const result = selectRoute({
      ...base,
      assessment: hardCoding,
      policy: { ...dylanPolicy, maxEstimatedUsd: 0.0000001 },
      deployments: [frontier],
    });
    assert.equal(result._tag, "Denied");
    if (result._tag !== "Denied") return;
    assert.equal(result.code, "cost");
  });

  it("keeps cost ranking inside hard quality limits", () => {
    const result = selectRoute({
      ...base,
      assessment: hardCoding,
      policy: freePolicy,
      preferredLocation: "local",
      deployments: [localQwen, cloudGlm],
    });
    assert.equal(result._tag, "Selected");
    if (result._tag !== "Selected") return;
    assert.equal(result.ranked[0]?.deployment.id, "cloud-glm");
    assert.ok(!result.ranked.some((candidate) => candidate.deployment.id === "local-qwen"));
  });

  it("does not treat unknown cloud prices as zero", () => {
    const unknown = {
      ...cloudGlm,
      prices: {
        inputUsdPerMillion: 0,
        cachedInputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        provenance: { unit: "usd-per-million-tokens", source: "unknown", asOf: null },
      },
    };
    const result = selectRoute({
      ...base,
      assessment: easyLocalCoding,
      policy: { ...dylanPolicy, maxEstimatedUsd: 1 },
      deployments: [unknown],
    });
    assert.equal(result._tag, "Denied");
    if (result._tag !== "Denied") return;
    assert.equal(result.code, "cost");
  });
});
