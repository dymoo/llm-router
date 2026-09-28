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

const kev: AuxiliaryDeployment = {
  id: "gufo-kev-4b",
  modality: "systemone",
  transport: "gufo",
  location: "local",
  modelId: "kev-4b",
  endpoint: "http://gufo/v1",
  resourceId: "gufo-kev",
  capacity: { maxParallel: 32, reservedInteractiveSlots: 0 },
  maxInputTokens: 32768,
  maxBatchSize: 128,
  maxBodyBytes: 1048576,
  inputUsdPerMillion: 0,
  requestUsd: null,
  priceVersion: "test",
};
const ticket = {
  state: "I was charged twice for order 4411.",
  questions: {
    team: { type: "choice", criteria: { billing: "Payments", shipping: null } },
    urgent: { type: "noul" },
  },
};
function systemOneRequest(json: Record<string, unknown>, headers: Record<string, string> = {}) {
  return jsonRequest("http://gateway/v1/systemone", {
    method: "POST",
    headers: { authorization: "Bearer test", ...headers },
    json,
  });
}
function kevDeps(fetchImpl?: typeof fetch) {
  return { ...deps(fetchImpl), deployments: [embedding, kev] };
}

test("System One reaches Kev on Gufo and accounts its token usage", async () => {
  const d = kevDeps(async (url, init) => {
    assert.equal(String(url), "http://gufo/v1/systemone");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("x-typesafe-request-id"), "ticket-7");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "kev-4b");
    assert.deepEqual(body.questions, ticket.questions);
    return Response.json({
      model: "kev-4b",
      answers: {
        team: {
          type: "choice",
          choice: "billing",
          confidence: 0.8,
          probabilities: { billing: 0.9, shipping: 0.1 },
        },
        urgent: { type: "noul", noul: 0.7 },
      },
      usage: { input_tokens: 42, output_tokens: 57 },
    });
  });
  const response = await handleAuxiliary(
    systemOneRequest({ ...ticket, model: "kev-latest" }, { "x-typesafe-request-id": "ticket-7" }),
    d,
    "systemone",
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-typesafe-request-id"), "ticket-7");
  assert.equal(response.headers.get("x-deployment-id"), kev.id);
  const body = await response.json();
  assert.equal(body.model, "kev-latest");
  assert.equal(body.answers.team.choice, "billing");
  assert.equal(d.keys.finalizes[0]?.promptTokens, 42);
  assert.equal(d.keys.finalizes[0]?.completionTokens, 57);
  assert.equal(d.keys.finalizes[0]?.transport, "gufo");
});

test("Jev is never substituted for Kev", async () => {
  const d = kevDeps(async () => {
    throw new Error("must not dispatch");
  });
  const response = await handleAuxiliary(
    systemOneRequest({ ...ticket, model: "jev-latest" }),
    d,
    "systemone",
  );
  assert.equal(response.status, 404);
  assert.equal(typeof (await response.json()).detail, "string");
});

test("a busy Gufo stays retryable in TypeSafe's shape", async () => {
  const d = kevDeps(
    async () =>
      new Response(JSON.stringify({ detail: "the System One queue is full" }), {
        status: 429,
        headers: { "retry-after": "2" },
      }),
  );
  const response = await handleAuxiliary(systemOneRequest(ticket), d, "systemone");
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "2");
  const body = await response.json();
  assert.equal(body.error.code, "resource_unavailable");
  assert.equal(body.detail, "System One is busy");
});

test("System One rejects oversized question sets before dispatch", async () => {
  let calls = 0;
  const d = kevDeps(async () => {
    calls++;
    return Response.json({});
  });
  const questions = Object.fromEntries(
    Array.from({ length: 129 }, (_, i) => [`q${i}`, { type: "noul" }]),
  );
  assert.equal(
    (await handleAuxiliary(systemOneRequest({ state: "x", questions }), d, "systemone")).status,
    400,
  );
  assert.equal(
    (await handleAuxiliary(systemOneRequest({ questions: ticket.questions }), d, "systemone"))
      .status,
    400,
  );
  assert.equal(calls, 0);
});

test("model discovery lists System One cards for TypeSafe SDKs", async () => {
  const d = kevDeps();
  const response = await handleModels(
    new Request("http://gateway/v1/models", { headers: { authorization: "Bearer test" } }),
    d,
  );
  const body = await response.json();
  assert.deepEqual(
    body.models.map((card: { name: string }) => card.name),
    [kev.id],
  );
});

test("System One deployments must name a System One transport", () => {
  assert.throws(() => decodeAuxiliaryCatalogue([{ ...kev, transport: undefined }]));
  assert.throws(() => decodeAuxiliaryCatalogue([{ ...embedding, transport: "gufo" }]));
  assert.throws(() =>
    decodeAuxiliaryCatalogue([{ ...kev, id: "jev", transport: "typesafe", location: "local" }]),
  );
  assert.equal(decodeAuxiliaryCatalogue([kev]).length, 1);
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
