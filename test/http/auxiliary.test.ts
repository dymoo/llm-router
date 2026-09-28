import assert from "node:assert/strict";
import test from "node:test";
import {
  handleSystemOne,
  handleModels,
  auxiliaryResources,
  type AuxiliaryDeps,
} from "../../src/http/auxiliary.ts";
import {
  decodeAuxiliaryCatalogue,
  probeAuxiliary,
  type AuxiliaryDeployment,
} from "../../src/auxiliary.ts";
import { memoryKeys, jsonRequest, samplePolicy, type MemoryKeys } from "./helpers.ts";

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
function deps(fetchImpl?: typeof fetch): AuxiliaryDeps & { keys: MemoryKeys } {
  return {
    keys: memoryKeys(),
    deployments: [kev],
    chatDeploymentIds: ["cloud-glm"],
    ...auxiliaryResources(),
    fetch: fetchImpl,
  };
}
test("model discovery authenticates without consuming inference admission and filters allowlists", async () => {
  const d = deps();
  d.keys.authenticate = async () => ({
    keyId: "k",
    policy: samplePolicy({ allowedModels: [kev.id] }),
  });
  const response = await handleModels(
    new Request("http://gateway/v1/models", { headers: { authorization: "Bearer test" } }),
    d,
  );
  assert.deepEqual(
    (await response.json()).data.map((item: { id: string }) => item.id),
    [kev.id],
  );
  assert.equal(d.keys.admits, 0);
  assert.equal((await handleModels(new Request("http://gateway/v1/models"), d)).status, 401);
});

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
  return deps(fetchImpl);
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
  const response = await handleSystemOne(
    systemOneRequest({ ...ticket, model: "kev-latest" }, { "x-typesafe-request-id": "ticket-7" }),
    d,
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
  const response = await handleSystemOne(systemOneRequest({ ...ticket, model: "jev-latest" }), d);
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
  const response = await handleSystemOne(systemOneRequest(ticket), d);
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
  assert.equal((await handleSystemOne(systemOneRequest({ state: "x", questions }), d)).status, 400);
  assert.equal(
    (await handleSystemOne(systemOneRequest({ questions: ticket.questions }), d)).status,
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
  assert.throws(() => decodeAuxiliaryCatalogue([{ ...kev, modality: "embeddings" }]));
  assert.throws(() =>
    decodeAuxiliaryCatalogue([{ ...kev, id: "jev", transport: "typesafe", location: "local" }]),
  );
  assert.equal(decodeAuxiliaryCatalogue([kev]).length, 1);
});

test("auxiliary catalog rejects conflicting shared capacity and non-HTTP endpoints", () => {
  assert.throws(() =>
    decodeAuxiliaryCatalogue([
      kev,
      { ...kev, id: "kev-b", capacity: { maxParallel: 2, reservedInteractiveSlots: 0 } },
    ]),
  );
  assert.throws(() => decodeAuxiliaryCatalogue([{ ...kev, endpoint: "file:///tmp/runtime" }]));
});

test("the readiness probe sends the deployment's bearer credential", async () => {
  const seen: (string | null)[] = [];
  const probe = (async (_url: string | URL, init?: RequestInit) => {
    seen.push(new Headers(init?.headers).get("authorization"));
    return new Response(JSON.stringify({ data: [{ id: kev.modelId }] }), { status: 200 });
  }) as typeof fetch;
  const withCredential = { ...kev, credentialEnvVar: "GUFO_TEST_KEY" };
  assert.equal(await probeAuxiliary(withCredential, probe, "secret"), true);
  assert.equal(await probeAuxiliary(kev, probe), true);
  assert.deepEqual(seen, ["Bearer secret", null]);
});
