import assert from "node:assert/strict";
import test from "node:test";
import {
  handleAuxiliary,
  handleModels,
  auxiliaryResources,
  type AuxiliaryDeps,
} from "../../src/http/auxiliary.ts";
import { decodeAuxiliaryCatalogue, type AuxiliaryDeployment } from "../../src/auxiliary.ts";
import { memoryKeys, jsonRequest, samplePolicy, type MemoryKeys } from "./helpers.ts";

const embedding: AuxiliaryDeployment = {
  id: "npu-embedding",
  modality: "embeddings",
  modelId: "embed-gemma:300m",
  endpoint: "http://npu/v1",
  resourceId: "npu",
  capacity: { maxParallel: 1, reservedInteractiveSlots: 0 },
  maxInputTokens: 2048,
  maxBatchSize: 16,
  maxBodyBytes: 131072,
  inputUsdPerMillion: 1,
  requestUsd: null,
  priceVersion: "test",
};
const speech: AuxiliaryDeployment = {
  ...embedding,
  id: "npu-speech",
  modality: "transcription",
  modelId: "whisper-v3:turbo",
  requestUsd: 0.01,
};
function deps(fetchImpl?: typeof fetch): AuxiliaryDeps & { keys: MemoryKeys } {
  return {
    keys: memoryKeys(),
    deployments: [embedding, speech],
    chatDeploymentIds: ["cloud-glm"],
    ...auxiliaryResources(),
    fetch: fetchImpl,
  };
}
function embedRequest(extra = {}) {
  return jsonRequest("http://gateway/v1/embeddings", {
    method: "POST",
    headers: { authorization: "Bearer test" },
    json: { model: embedding.id, input: "hello", ...extra },
  });
}
function audioRequest(extra: Record<string, string> = {}) {
  const form = new FormData();
  form.set("model", speech.id);
  form.set("file", new Blob([new Uint8Array([82, 73, 70, 70])], { type: "audio/wav" }), "test.wav");
  for (const [key, value] of Object.entries(extra)) form.set(key, value);
  return new Request("http://gateway/v1/audio/transcriptions", {
    method: "POST",
    headers: { authorization: "Bearer test" },
    body: form,
  });
}

test("model discovery authenticates without consuming inference admission and filters allowlists", async () => {
  const d = deps();
  d.keys.authenticate = async () => ({
    keyId: "k",
    policy: samplePolicy({ allowedModels: [embedding.id] }),
  });
  const response = await handleModels(
    new Request("http://gateway/v1/models", { headers: { authorization: "Bearer test" } }),
    d,
  );
  assert.deepEqual(
    (await response.json()).data.map((item: { id: string }) => item.id),
    [embedding.id],
  );
  assert.equal(d.keys.admits, 0);
  assert.equal((await handleModels(new Request("http://gateway/v1/models"), d)).status, 401);
});

test("embedding results preserve vectors and account real measured tokens", async () => {
  const d = deps(async (url, init) => {
    assert.equal(String(url), "http://npu/v1/embeddings");
    assert.equal(new Headers(init?.headers).has("authorization"), false);
    assert.equal(JSON.parse(String(init?.body)).model, embedding.modelId);
    return Response.json({
      data: [{ index: 0, embedding: [0.1, -0.2] }],
      usage: { prompt_tokens: 5, total_tokens: 5 },
    });
  });
  const response = await handleAuxiliary(embedRequest(), d, "embeddings");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.data[0].embedding, [0.1, -0.2]);
  assert.equal(body.usage.cost, 0.000005);
  assert.equal(d.keys.finalizes[0]?.localComputeEstimatedUsd, 0.000005);
  assert.equal(d.keys.finalizes[0]?.classifierInputTokens, 0);
});

test("FastFlow placeholder zero usage remains unknown instead of free inference", async () => {
  const d = deps(async () =>
    Response.json({
      data: [{ index: 0, embedding: [1] }],
      usage: { prompt_tokens: 0, total_tokens: 0 },
    }),
  );
  const response = await handleAuxiliary(embedRequest(), d, "embeddings");
  const body = await response.json();
  assert.equal(body.usage.prompt_tokens, null);
  assert.equal(body.usage.cost, null);
  assert.equal(d.keys.finalizes[0]?.localComputeEstimatedUsd, null);
});

test("oversized embedding chunks and unsupported encoding never dispatch", async () => {
  let calls = 0;
  const d = deps(async () => {
    calls++;
    throw new Error("must not dispatch");
  });
  assert.equal(
    (await handleAuxiliary(embedRequest({ input: "x".repeat(2049) }), d, "embeddings")).status,
    422,
  );
  assert.equal(
    (await handleAuxiliary(embedRequest({ encoding_format: "base64" }), d, "embeddings")).status,
    400,
  );
  assert.equal(calls, 0);
});

test("multimodal admission shares key allowlists and cost ceilings", async () => {
  const d = deps(async () => {
    throw new Error("must not dispatch");
  });
  const original = d.keys.admit;
  d.keys.admit = async (key) => ({
    ...(await original(key)),
    policy: samplePolicy({ allowedModels: [] }),
  });
  assert.equal((await handleAuxiliary(embedRequest(), d, "embeddings")).status, 403);
  d.keys.admit = async (key) => ({
    ...(await original(key)),
    policy: samplePolicy({ maxEstimatedUsd: 0 }),
  });
  assert.equal((await handleAuxiliary(embedRequest(), d, "embeddings")).status, 422);
  assert.equal(d.keys.finalizes.length, 2);
});

test("transcription accepts multipart and returns text without storing the transcript", async () => {
  const d = deps(async (_url, init) => {
    assert.ok(init?.body instanceof FormData);
    assert.equal(init.body.get("model"), speech.modelId);
    assert.ok(init.body.get("file") instanceof Blob);
    return Response.json({ text: "Private transcript." });
  });
  const response = await handleAuxiliary(
    audioRequest({ response_format: "text" }),
    d,
    "transcription",
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "Private transcript.");
  assert.equal(d.keys.finalizes[0]?.localComputeEstimatedUsd, 0.01);
  assert.equal(JSON.stringify(d.keys.finalizes).includes("Private transcript"), false);
});

test("unsupported transcription language is rejected rather than silently ignored", async () => {
  const d = deps(async () => {
    throw new Error("must not dispatch");
  });
  assert.equal(
    (await handleAuxiliary(audioRequest({ language: "de" }), d, "transcription")).status,
    400,
  );
  assert.equal(d.keys.admits, 0);
});

test("malformed embeddings fail with a sanitized error and release NPU capacity", async () => {
  let calls = 0;
  const d = deps(async () =>
    ++calls === 1
      ? Response.json({ error: "secret provider error" })
      : Response.json({ data: [{ index: 0, embedding: [1] }] }),
  );
  const first = await handleAuxiliary(embedRequest(), d, "embeddings");
  assert.equal(first.status, 502);
  assert.equal((await first.text()).includes("secret"), false);
  assert.equal((await handleAuxiliary(embedRequest(), d, "embeddings")).status, 200);
});

test("auxiliary catalog rejects conflicting shared NPU capacity", () => {
  assert.throws(() =>
    decodeAuxiliaryCatalogue([
      embedding,
      { ...speech, capacity: { maxParallel: 2, reservedInteractiveSlots: 0 } },
    ]),
  );
  assert.throws(() =>
    decodeAuxiliaryCatalogue([{ ...embedding, endpoint: "file:///tmp/runtime" }]),
  );
});
