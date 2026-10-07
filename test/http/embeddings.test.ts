import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { decodeAuxiliaryCatalogue, type AuxiliaryDeployment } from "../../src/auxiliary.ts";
import { auxiliaryResources, handleModels, type AuxiliaryDeps } from "../../src/http/auxiliary.ts";
import { handleEmbeddings, topLevelModelScanner } from "../../src/http/embeddings.ts";
import { memoryKeys, type MemoryKeys } from "./helpers.ts";

const gemma: AuxiliaryDeployment = {
  id: "embeddinggemma-2",
  modality: "embeddings",
  transport: "openai",
  location: "local",
  credentialEnvVar: "EMBEDDINGS_TEST_KEY",
  modelId: "embeddinggemma-2",
  endpoint: "http://npu/v1",
  resourceId: "npu-embeddinggemma-2",
  capacity: { maxParallel: 2, reservedInteractiveSlots: 0 },
  maxInputTokens: 8192,
  maxBatchSize: 64,
  maxBodyBytes: 1024,
  inputUsdPerMillion: 0,
  requestUsd: null,
  priceVersion: "local-free",
};

function deps(fetchImpl?: typeof fetch, deployment = gemma): AuxiliaryDeps & { keys: MemoryKeys } {
  return {
    keys: memoryKeys(),
    deployments: [deployment],
    chatModels: [],
    ...auxiliaryResources(),
    fetch: fetchImpl,
  };
}

function embeddingsRequest(body: string, headers: Record<string, string> = {}) {
  return new Request("http://gateway/v1/embeddings", {
    method: "POST",
    headers: {
      authorization: "Bearer test",
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
      ...headers,
    },
    body,
  });
}

/** A fake server that reads the whole streamed body, as the real one does. */
function upstream(seen: string[] = []): typeof fetch {
  return (async (_url: string | URL, init?: RequestInit) => {
    seen.push(await new Response(init?.body).text());
    return Response.json({
      object: "list",
      data: [{ object: "embedding", index: 0, embedding: [0.6, 0.8] }],
      model: "embeddinggemma-2",
      usage: { prompt_tokens: 7, total_tokens: 7 },
    });
  }) as typeof fetch;
}

test("the model scanner reads only the top-level model, across any chunking", () => {
  const scan = (json: string, step = 1) => {
    const scanner = topLevelModelScanner();
    const bytes = new TextEncoder().encode(json);
    for (let i = 0; i < bytes.length; i += step) scanner.push(bytes.subarray(i, i + step));
    return scanner.models;
  };
  const media = '[{"type":"text","model":"x","text":"say \\"model\\": \\"y\\""}]';
  assert.deepEqual(scan(`{"input": ${media}, "model" : "embeddinggemma-2"}`), ["embeddinggemma-2"]);
  assert.deepEqual(scan(`{"model":"embeddinggemma-2","input":"a"}`, 5), ["embeddinggemma-2"]);
  assert.deepEqual(scan(`{"input":{"model":"x"},"dimensions":256}`), []);
  assert.deepEqual(scan(`{"model":"emb\\u0065dding"}`), ["\\"]);
  assert.deepEqual(scan(`{"model":null}`), [""]);
});

test("embeddings stream the body unchanged with its length and the server key, and are accounted", async () => {
  process.env.EMBEDDINGS_TEST_KEY = "server-key";
  const received: { headers: Record<string, unknown>; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          object: "list",
          data: [{ object: "embedding", index: 0, embedding: [0.6, 0.8] }],
          model: "embeddinggemma-2",
          usage: { prompt_tokens: 7, total_tokens: 7 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as { port: number };
    const d = deps(undefined, { ...gemma, endpoint: `http://127.0.0.1:${address.port}/v1` });
    const body = JSON.stringify({ input: "hello", dimensions: 256, model: "embeddinggemma-2" });
    const response = await handleEmbeddings(embeddingsRequest(body), d);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-deployment-id"), "embeddinggemma-2");
    assert.deepEqual((await response.json()).data[0].embedding, [0.6, 0.8]);
    assert.equal(received[0]?.body, body);
    assert.equal(received[0]?.headers["content-length"], String(body.length));
    assert.equal(received[0]?.headers["transfer-encoding"], undefined);
    assert.equal(received[0]?.headers.authorization, "Bearer server-key");
    const outcome = d.keys.finalizes[0];
    assert.equal(outcome?.status, "success");
    assert.equal(outcome?.promptTokens, 7);
    assert.equal(outcome?.estimatedCostUsd, 0);
    assert.equal(outcome?.taskKind, "embeddings");
    assert.equal(JSON.parse(String(outcome?.decisionTraceJson)).items, 1);
  } finally {
    server.close();
    delete process.env.EMBEDDINGS_TEST_KEY;
  }
});

test("a wrong or missing model never reaches the server as a complete body", async () => {
  const seen: string[] = [];
  const failing = (async (url: string | URL, init?: RequestInit) => {
    try {
      return await upstream(seen)(url, init);
    } catch (error) {
      throw new TypeError("fetch failed", { cause: error });
    }
  }) as typeof fetch;
  const wrong = await handleEmbeddings(
    embeddingsRequest(JSON.stringify({ input: "a", model: "qwen3.8-flash-next" })),
    deps(failing),
  );
  assert.equal(wrong.status, 404);
  const missing = await handleEmbeddings(
    embeddingsRequest(JSON.stringify({ input: "a" })),
    deps(failing),
  );
  assert.equal(missing.status, 400);
  assert.deepEqual(seen, []);
});

test("an unreachable server is a clear 503, never a cloud fallback", async () => {
  const d = deps((async () => {
    throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
  }) as typeof fetch);
  const response = await handleEmbeddings(
    embeddingsRequest(JSON.stringify({ model: "embeddinggemma-2", input: "a" })),
    d,
  );
  assert.equal(response.status, 503);
  assert.match((await response.json()).error.message, /never fall back to cloud/);
  assert.equal(d.keys.finalizes[0]?.status, "error");
});

test("bodies need a length within the deployment's limit, checked before admission", async () => {
  const d = deps(upstream());
  const big = JSON.stringify({ model: "embeddinggemma-2", input: "x".repeat(2000) });
  assert.equal((await handleEmbeddings(embeddingsRequest(big), d)).status, 413);
  const chunked = new Request("http://gateway/v1/embeddings", {
    method: "POST",
    headers: { authorization: "Bearer test" },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{}"));
        controller.close();
      },
    }),
    duplex: "half",
  } as RequestInit);
  assert.equal((await handleEmbeddings(chunked, d)).status, 411);
  assert.equal(d.keys.admits, 0);
});

test("the server's validation errors reach the client", async () => {
  const d = deps((async (_url: string | URL, init?: RequestInit) => {
    await new Response(init?.body).text();
    return Response.json(
      { error: { message: "dimensions must be one of (768, 512, 256, 128)" } },
      { status: 400 },
    );
  }) as typeof fetch);
  const response = await handleEmbeddings(
    embeddingsRequest(JSON.stringify({ model: "embeddinggemma-2", input: "a", dimensions: 7 })),
    d,
  );
  assert.equal(response.status, 400);
  assert.match((await response.json()).error.message, /dimensions/);
});

test("models list the embeddings deployment", async () => {
  const response = await handleModels(
    new Request("http://gateway/v1/models", { headers: { authorization: "Bearer test" } }),
    deps(),
  );
  const ids = (await response.json()).data.map((item: { id: string }) => item.id);
  assert.deepEqual(ids, ["embeddinggemma-2"]);
});

test("embeddings deployments are single, local, openai and named by their model id", () => {
  assert.equal(decodeAuxiliaryCatalogue([gemma]).length, 1);
  assert.throws(() => decodeAuxiliaryCatalogue([{ ...gemma, transport: "gufo" }]));
  assert.throws(() => decodeAuxiliaryCatalogue([{ ...gemma, location: "cloud" }]));
  assert.throws(() => decodeAuxiliaryCatalogue([{ ...gemma, id: "npu-gemma" }]));
  assert.throws(() =>
    decodeAuxiliaryCatalogue([gemma, { ...gemma, id: "e2", modelId: "e2", resourceId: "r2" }]),
  );
});
