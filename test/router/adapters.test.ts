import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Effect } from "effect";
import {
  halogenBody,
  halogenEffort,
  halogenHealthUnavailable,
  halogenSaturation,
} from "../../src/router/adapters/halogen.ts";
import {
  llamaCppAdapter,
  llamaCppBody,
  llamaCppHealthUnavailable,
  llamaCppSlotsSaturated,
} from "../../src/router/adapters/llamacpp.ts";
import { joinUrl } from "../../src/router/adapters/http.ts";
import { openRouterBody } from "../../src/router/adapters/openrouter.ts";
import { localQwen, cloudGlm, frontier } from "./fixtures.ts";
import type { AdapterRequest } from "../../src/router/adapters/types.ts";

const request = (
  partial: Partial<AdapterRequest> & Pick<AdapterRequest, "deployment" | "appliedEffort">,
): AdapterRequest => ({
  messages: [{ role: "user", content: "hi", reasoning_content: "secret-thought" }],
  tools: [{ type: "function", function: { name: "read" } }],
  toolChoice: "auto",
  responseFormat: null,
  maxCompletionTokens: 128,
  requestedEffort: "high",
  credential: undefined,
  ...partial,
});

describe("adapters", () => {
  it("maps Halogen high to xhigh and sends a single token budget field", () => {
    assert.equal(halogenEffort("high"), "xhigh");
    const body = halogenBody(request({ deployment: localQwen, appliedEffort: "high" }), false);
    assert.equal(body.reasoning_effort, "xhigh");
    assert.equal(body.max_completion_tokens, 128);
    assert.equal(body.max_tokens, undefined);
    assert.equal(body.max_output_tokens, undefined);
    assert.deepEqual(body.messages, [
      { role: "user", content: "hi", reasoning_content: "secret-thought" },
    ]);
    assert.ok(body.tools);
  });

  it("treats unknown Halogen health as unavailable and busy as not unavailable", () => {
    assert.equal(halogenHealthUnavailable(null), true);
    assert.equal(halogenHealthUnavailable({}), true);
    assert.equal(halogenHealthUnavailable({ engine: { responds: false } }), true);
    assert.equal(
      halogenHealthUnavailable({
        status: "ok",
        engine: { responds: true },
        busy: true,
        slots: 4,
        in_flight: 4,
      }),
      false,
    );
  });

  it("pins OpenRouter provider without hidden fallbacks", () => {
    const body = openRouterBody(
      request({
        deployment: { ...frontier, providerRestriction: "anthropic" },
        appliedEffort: "high",
      }),
      false,
    );
    assert.deepEqual(body.provider, {
      only: ["anthropic"],
      allow_fallbacks: false,
      require_parameters: true,
    });
    assert.deepEqual(body.reasoning, { effort: "high" });
    assert.ok((body.messages as { reasoning_content?: string }[])[0]?.reasoning_content);
  });

  it("does not invent reasoning fields for none-kind deployments", () => {
    const body = halogenBody(
      request({
        deployment: { ...cloudGlm, transport: "halogen", reasoning: { kind: "none" } },
        appliedEffort: "none",
      }),
      false,
    );
    assert.equal(body.reasoning_effort, "none");
  });

  it("does not double /v1 when the endpoint already includes it", () => {
    assert.equal(
      joinUrl("http://127.0.0.1:8080", "/v1/chat/completions"),
      "http://127.0.0.1:8080/v1/chat/completions",
    );
    assert.equal(
      joinUrl("http://127.0.0.1:8080/v1", "/v1/chat/completions"),
      "http://127.0.0.1:8080/v1/chat/completions",
    );
    assert.equal(joinUrl("http://127.0.0.1:8080/v1", "/health"), "http://127.0.0.1:8080/health");
    assert.equal(
      joinUrl("http://127.0.0.1:8080/llama/v1", "/slots"),
      "http://127.0.0.1:8080/llama/slots",
    );
  });

  it("treats llama.cpp /health as readiness only and /slots as saturation", () => {
    assert.equal(llamaCppHealthUnavailable(503, { error: { message: "Loading model" } }), true);
    assert.equal(llamaCppHealthUnavailable(200, { status: "ok" }), false);
    assert.equal(llamaCppHealthUnavailable(200, { engine: { responds: true } }), true);
    assert.deepEqual(llamaCppSlotsSaturated([{ is_processing: true }, { is_processing: true }]), {
      verified: true,
      saturated: true,
    });
    assert.deepEqual(llamaCppSlotsSaturated([{ is_processing: true }, { is_processing: false }]), {
      verified: true,
      saturated: false,
    });
    assert.deepEqual(llamaCppSlotsSaturated(null), { verified: false, saturated: false });
    const body = llamaCppBody(request({ deployment: localQwen, appliedEffort: "high" }), false);
    assert.equal(body.reasoning_effort, "high");
    assert.equal(body.cache_prompt, true);
    assert.equal(body.max_tokens, 128);
  });
});

it(
  "missing slot telemetry times out without inventing saturation or losing readiness",
  { timeout: 5000 },
  async () => {
    let aborted = false;
    const adapter = llamaCppAdapter(async (url, init) => {
      if (String(url).endsWith("/health")) return Response.json({ status: "ok" });
      const pending = Promise.withResolvers<Response>();
      init?.signal?.addEventListener(
        "abort",
        () => {
          aborted = true;
          pending.reject(new Error("cancelled"));
        },
        { once: true },
      );
      return pending.promise;
    });
    assert.equal(await Effect.runPromise(adapter.probeUnavailable(localQwen, undefined)), false);
    assert.equal(aborted, true);
    assert.ok(adapter.readSaturation);
    assert.deepEqual(await Effect.runPromise(adapter.readSaturation(localQwen, undefined)), {
      verified: false,
      saturated: false,
    });
  },
);

it("uses Halogen's runtime admission signal without equating one active request with saturation", () => {
  const healthy = { status: "ok", engine: { responds: true }, slots: 4 };
  assert.deepEqual(halogenSaturation({ ...healthy, busy: false, in_flight: 1 }), {
    verified: true,
    saturated: false,
  });
  assert.deepEqual(halogenSaturation({ ...healthy, busy: true, in_flight: 4 }), {
    verified: true,
    saturated: true,
  });
  assert.deepEqual(halogenSaturation({ ...healthy, in_flight: 4 }), {
    verified: false,
    saturated: false,
  });
  assert.deepEqual(halogenSaturation({ ...healthy, engine: { responds: false }, busy: true }), {
    verified: false,
    saturated: false,
  });
});
