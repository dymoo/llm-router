// Public production HTTP regression. Fake loopback Gufo and classifier peers exercise the
// built gateway; the qualification below is synthetic test data, not measured model quality.
// The child rejects non-loopback fetches and receives only fixture credentials.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createServer as createPortReservation } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const MODEL_ID = "qwen3.8-flash-next-gufo";
const DEPLOYMENT_ID = "gufo-test";
const FIXTURE_CREDENTIAL = "fixture-gufo-only";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

function assessment(body) {
  const choices = { task: "coding", difficulty: "easy", effort: "low", expectedLength: "short" };
  return {
    model: body.model,
    answers: Object.fromEntries(
      Object.entries(body.questions).map(([id, question]) => [
        id,
        question.type === "noul"
          ? { type: "noul", noul: id === "localSufficiency" ? 1 : 0 }
          : {
              type: "choice",
              choice: choices[id],
              confidence: 1,
              probabilities: Object.fromEntries(
                Object.keys(question.criteria).map((label) => [
                  label,
                  label === choices[id] ? 1 : 0,
                ]),
              ),
            },
      ]),
    ),
    usage: { input_tokens: 100, output_tokens: 0 },
  };
}

function qualification() {
  const ids = [
    "task",
    "difficulty",
    "effort",
    "trivialChat",
    "localSufficiency",
    "freshFacts",
    "expectedLength",
  ];
  const provenance = {
    unit: "USD-per-million-tokens",
    source: "synthetic test fixture",
    asOf: "2026-09-22",
  };
  return [
    {
      backend: "jev",
      modelRevision: "jev-1.13.0",
      questionSchemaVersion: "dymoo-assessment-questions/v1",
      calibration: {
        evaluationSet: {
          id: "gufo-software-fixture",
          cases: 20,
          labelsSource: "synthetic test fixture",
          asOf: "2026-09-22",
        },
        measuredAt: "2026-09-22",
        method: "synthetic test fixture",
        metrics: Object.fromEntries(
          ids.map((id) => [id, { cases: 20, negativeCases: 10, errors: 1, falsePositives: 0 }]),
        ),
        thresholds: Object.fromEntries(
          ids.map((id) => [
            id,
            {
              maxErrorRate: 0.2,
              maxFalsePositiveRate: ["localSufficiency", "trivialChat"].includes(id) ? 0 : null,
            },
          ]),
        ),
        verdict: "pass",
      },
      rates: { inputUsdPerMillion: 0.042, outputUsdPerMillion: 0, provenance },
    },
  ];
}

function completion(model, message, finishReason = "stop") {
  return {
    id: "fake-gufo-response",
    object: "chat.completion",
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
  };
}

function sendSse(response) {
  response.setHeader("content-type", "text/event-stream");
  for (const frame of [
    {
      id: "fake-gufo-stream",
      object: "chat.completion.chunk",
      model: MODEL_ID,
      choices: [
        { index: 0, delta: { role: "assistant", content: "streamed answer" }, finish_reason: null },
      ],
    },
    {
      id: "fake-gufo-stream",
      object: "chat.completion.chunk",
      model: MODEL_ID,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
    {
      id: "fake-gufo-stream",
      object: "chat.completion.chunk",
      model: MODEL_ID,
      choices: [],
      usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
    },
  ])
    response.write(`data: ${JSON.stringify(frame)}\n\n`);
  response.end("data: [DONE]\n\n");
}

async function jsonCall(origin, path, options = {}) {
  const response = await fetch(`${origin}${path}`, {
    ...options,
    signal: AbortSignal.timeout(8_000),
  });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

const bearer = (secret) => ({ authorization: `Bearer ${secret}` });
const chat = (body, secret) => ({
  method: "POST",
  headers: { ...bearer(secret), "content-type": "application/json" },
  body: JSON.stringify({
    model: "auto",
    messages: [{ role: "user", content: "Complete a coding task." }],
    ...body,
  }),
});

test(
  "Gufo is a key-scoped production Route through authenticated loopback peers",
  { timeout: 60_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "llm-router-gufo-"));
    const peer = {
      paths: [],
      posts: [],
      error: null,
      advertisedModel: MODEL_ID,
      completionModel: MODEL_ID,
      failure: null,
    };
    const fixture = createServer(async (request, response) => {
      try {
        peer.paths.push(`${request.method} ${request.url}`);
        const path = request.url;
        if (path === "/v1/models" && request.method === "GET") {
          assert.equal(request.headers.authorization, `Bearer ${FIXTURE_CREDENTIAL}`);
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify({
              object: "list",
              data: [{ id: peer.advertisedModel, object: "model" }],
            }),
          );
          return;
        }
        if (path === "/v1/systemone" && request.method === "POST") {
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify(assessment(JSON.parse(Buffer.concat(chunks).toString()))));
          return;
        }
        if (path === "/v1/chat/completions" && request.method === "POST") {
          assert.equal(request.headers.authorization, `Bearer ${FIXTURE_CREDENTIAL}`);
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          const body = JSON.parse(Buffer.concat(chunks).toString());
          peer.posts.push(body);
          assert.equal(body.model, MODEL_ID);
          if (
            body.tool_choice !== undefined &&
            !["auto", "none", "required"].includes(body.tool_choice)
          ) {
            response.statusCode = 400;
            response.setHeader("content-type", "application/json");
            response.end(
              JSON.stringify({
                error: { code: "invalid_tools", message: "Gufo accepts string tool_choice only" },
              }),
            );
            return;
          }
          if (peer.failure !== null) {
            response.statusCode = peer.failure === "queue_full" ? 429 : 503;
            response.setHeader("content-type", "application/json");
            if (peer.failure === "queue_full") response.setHeader("retry-after", "2");
            response.end(
              JSON.stringify({ error: { code: peer.failure, message: "fixture refusal" } }),
            );
            return;
          }
          if (body.stream) sendSse(response);
          else {
            const tool = body.tool_choice === "required";
            response.setHeader("content-type", "application/json");
            response.end(
              JSON.stringify(
                completion(
                  peer.completionModel,
                  tool
                    ? {
                        role: "assistant",
                        content: null,
                        tool_calls: [
                          {
                            id: "call_fixture",
                            type: "function",
                            function: { name: "lookup", arguments: '{"query":"fixture"}' },
                          },
                        ],
                      }
                    : { role: "assistant", content: "gufo fixture answer" },
                  tool ? "tool_calls" : "stop",
                ),
              ),
            );
          }
          return;
        }
        response.statusCode = 404;
        response.end();
      } catch (error) {
        peer.error = error;
        response.statusCode = 500;
        response.end();
      }
    });
    const cloud = { posts: [], error: null };
    const cloudFixture = createServer(async (request, response) => {
      try {
        assert.equal(request.headers.authorization, "Bearer fixture-cloud-only");
        if (request.method === "GET" && request.url === "/v1/auth/key") {
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ data: { is_free_tier: false } }));
          return;
        }
        assert.equal(request.method, "POST");
        assert.equal(request.url, "/v1/chat/completions");
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        cloud.posts.push(body);
        assert.equal(body.model, "fixture-cloud-model");
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify(
            completion("fixture-cloud-model", {
              role: "assistant",
              content: "fixture cloud recovery",
            }),
          ),
        );
      } catch (error) {
        cloud.error = error;
        response.statusCode = 500;
        response.end();
      }
    });
    let child;
    let logs = "";
    let exit;
    try {
      const upstreamPort = await listen(fixture);
      const cloudPort = await listen(cloudFixture);
      const reservation = createPortReservation();
      const port = await listen(reservation);
      await close(reservation);
      const origin = `http://127.0.0.1:${port}`;
      const catalogue = JSON.parse(await readFile("catalog.example.json", "utf8")).slice(0, 2);
      Object.assign(catalogue[0], {
        id: DEPLOYMENT_ID,
        modelId: MODEL_ID,
        endpoint: `http://127.0.0.1:${upstreamPort}/v1`,
        location: "local",
        transport: "gufo",
        credentialEnvVar: "GUFO_API_KEY",
        providerRestriction: null,
        contextLimitTokens: 131072,
        maxOutputTokens: 8192,
        capabilities: { tools: true, json: false, vision: false },
        capacity: { maxParallel: 2, reservedInteractiveSlots: 0 },
        reasoning: { kind: "graded", levels: ["none", "low", "medium", "xhigh"] },
      });
      for (const key of ["chat", "coding", "math", "analysis", "writing", "extraction"])
        catalogue[0].quality[key] = 0.9;
      catalogue[0].quality.provenance = {
        unit: "probability",
        source: "synthetic routing fixture, not measured quality",
        asOf: "2026-09-22",
      };
      Object.assign(catalogue[0].prices, {
        inputUsdPerMillion: 1,
        cachedInputUsdPerMillion: 1,
        outputUsdPerMillion: 1,
        provenance: {
          unit: "USD-per-million-tokens",
          source: "synthetic accounting fixture, not provider price",
          asOf: "2026-09-22",
        },
      });
      Object.assign(catalogue[1], {
        id: "cloud-test",
        modelId: "fixture-cloud-model",
        endpoint: `http://127.0.0.1:${cloudPort}/v1`,
        location: "cloud",
        transport: "openrouter",
        credentialEnvVar: "OPENROUTER_API_KEY",
        providerRestriction: "fixture/provider",
        contextLimitTokens: 131072,
        maxOutputTokens: 8192,
        capabilities: { tools: true, json: false, vision: false },
        reasoning: { kind: "graded", levels: ["none", "low", "medium", "high", "xhigh"] },
      });
      for (const key of ["chat", "coding", "math", "analysis", "writing", "extraction"])
        catalogue[1].quality[key] = 0.9;
      catalogue[1].quality.provenance = {
        unit: "probability",
        source: "synthetic routing fixture, not measured quality",
        asOf: "2026-09-22",
      };
      Object.assign(catalogue[1].prices, {
        inputUsdPerMillion: 1,
        cachedInputUsdPerMillion: 1,
        outputUsdPerMillion: 1,
        provenance: {
          unit: "USD-per-million-tokens",
          source: "synthetic accounting fixture, not provider price",
          asOf: "2026-09-22",
        },
      });
      const cataloguePath = join(directory, "catalog.json");
      const qualificationPath = join(directory, "qualification.json");
      const guardPath = join(directory, "loopback-only.mjs");
      await writeFile(cataloguePath, JSON.stringify(catalogue), { mode: 0o600 });
      await writeFile(qualificationPath, JSON.stringify(qualification()), { mode: 0o600 });
      await writeFile(
        guardPath,
        `const actualFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(String(typeof input === "string" || input instanceof URL ? input : input.url));
  if ((url.protocol === "http:" || url.protocol === "https:") && !["127.0.0.1", "localhost", "::1"].includes(url.hostname))
    return Promise.reject(new Error("Gufo integration fixture blocked external fetch"));
  return actualFetch(input, init);
};
`,
        { mode: 0o600 },
      );
      // Do not inherit a real provider/admin credential into the production child.
      const safeEnv = Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) =>
            name !== "NODE_OPTIONS" &&
            !/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|DATABASE_URL)/i.test(name),
        ),
      );
      const exited = Promise.withResolvers();
      child = spawn(
        process.execPath,
        [
          "node_modules/next/dist/bin/next",
          "start",
          "--hostname",
          "127.0.0.1",
          "--port",
          String(port),
        ],
        {
          cwd: process.cwd(),
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...safeEnv,
            NODE_ENV: "production",
            NEXT_TELEMETRY_DISABLED: "1",
            NODE_OPTIONS: `--import=file://${guardPath}`,
            APP_ORIGIN: origin,
            SQLITE_PATH: join(directory, "control.sqlite"),
            MODEL_CATALOG: cataloguePath,
            AUXILIARY_CATALOG: "",
            API_KEY_PEPPER: randomUUID(),
            ADMIN_BASIC_AUTH: "",
            CLASSIFIER_MODE: "jev",
            CLASSIFIER_QUALIFICATION: qualificationPath,
            TYPESAFE_API_KEY: "fixture-jev-only",
            TYPESAFE_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
            TYPESAFE_MODEL: "jev-1.13.0",
            GUFO_API_KEY: FIXTURE_CREDENTIAL,
            OPENROUTER_API_KEY: "fixture-cloud-only",
          },
        },
      );
      child.stdout.on("data", (chunk) => {
        logs = (logs + chunk).slice(-4000);
      });
      child.stderr.on("data", (chunk) => {
        logs = (logs + chunk).slice(-4000);
      });
      child.once("error", exited.reject);
      child.once("exit", (code, signal) => exited.resolve({ code, signal }));
      exit = exited.promise;
      t.signal.addEventListener("abort", () => child?.kill("SIGKILL"), { once: true });
      const deadline = Date.now() + 15_000;
      for (;;) {
        try {
          if ((await fetch(`${origin}/health/live`, { signal: AbortSignal.timeout(500) })).ok)
            break;
        } catch {
          /* Listener not yet ready. */
        }
        assert.ok(Date.now() < deadline && child.exitCode === null, `gateway not ready: ${logs}`);
        await delay(25, undefined, { signal: t.signal });
      }
      const policy = {
        priority: "high",
        localityBias: 1,
        contextLimitTokens: 4096,
        maxCompletionTokens: 128,
        overloadAction: "report",
        allowedModels: [DEPLOYMENT_ID],
        requestsPerMinute: 60,
        maxConcurrent: 2,
        maxWaitMs: 1000,
        maxEstimatedUsd: null,
        bias: { cost: 0.7, quality: 0.8, latency: 0.3 },
      };
      const createKey = async (name, allowedModels, overloadAction = "report") => {
        const result = await jsonCall(origin, "/api/admin/keys", {
          method: "POST",
          headers: { "content-type": "application/json", origin, "x-jev-admin": "1" },
          body: JSON.stringify({
            name,
            expiresAt: null,
            policy: { ...policy, allowedModels, overloadAction },
          }),
        });
        assert.equal(result.status, 201, JSON.stringify(result.body));
        return result.body.secret;
      };
      const permitted = await createKey("gufo permitted", [DEPLOYMENT_ID]);
      const denied = await createKey("gufo denied", []);
      const report = await createKey(
        "gufo overload report",
        [DEPLOYMENT_ID, "cloud-test"],
        "report",
      );
      const failover = await createKey(
        "gufo overload failover",
        [DEPLOYMENT_ID, "cloud-test"],
        "failover",
      );

      const models = await jsonCall(origin, "/v1/models", { headers: bearer(permitted) });
      assert.equal(models.status, 200);
      assert.deepEqual(
        models.body.data.map(({ id }) => id),
        ["auto"],
      );
      const scoped = await jsonCall(origin, "/v1/models", { headers: bearer(denied) });
      assert.equal(scoped.status, 200);
      assert.deepEqual(scoped.body.data, []);
      assert.equal((await jsonCall(origin, "/v1/models")).status, 401);
      const forbidden = await jsonCall(origin, "/v1/chat/completions", chat({}, denied));
      assert.equal(forbidden.status, 403);
      assert.equal(forbidden.body.error.code, "forbidden");
      assert.equal(peer.posts.length, 0);

      const ready = await jsonCall(origin, "/health/ready");
      assert.equal(ready.status, 200, JSON.stringify(ready.body));
      assert.equal(ready.body.deployments.find(({ id }) => id === DEPLOYMENT_ID)?.ready, true);
      assert.ok(
        peer.paths.includes("GET /v1/models"),
        "Gufo readiness must verify advertised model",
      );

      const generated = await jsonCall(
        origin,
        "/v1/chat/completions",
        chat({ max_tokens: 64 }, permitted),
      );
      assert.equal(generated.status, 200, JSON.stringify(generated.body));
      assert.equal(generated.headers.get("x-deployment-id"), DEPLOYMENT_ID);
      assert.equal(generated.headers.get("x-priority"), "high");
      assert.equal(generated.headers.get("x-applied-effort"), "low");
      assert.equal(generated.body.choices[0].message.content, "gufo fixture answer");
      assert.deepEqual(
        {
          prompt: generated.body.usage.prompt_tokens,
          completion: generated.body.usage.completion_tokens,
        },
        { prompt: 11, completion: 3 },
      );
      assert.equal(peer.posts[0].max_tokens, 64);
      assert.equal(peer.posts[0].reasoning_effort, "low");
      assert.equal(peer.posts[0].enable_thinking, undefined);

      const tools = [
        { type: "function", function: { name: "discard", parameters: { type: "object" } } },
        {
          type: "function",
          function: {
            name: "lookup",
            parameters: { type: "object", properties: { query: { type: "string" } } },
          },
        },
      ];
      const called = await jsonCall(
        origin,
        "/v1/chat/completions",
        chat({ tools, tool_choice: { type: "function", function: { name: "lookup" } } }, permitted),
      );
      assert.equal(called.status, 200, JSON.stringify(called.body));
      assert.equal(called.body.choices[0].finish_reason, "tool_calls");
      assert.equal(called.body.choices[0].message.tool_calls[0].function.name, "lookup");
      assert.equal(peer.posts.at(-1).tool_choice, "required");
      assert.deepEqual(peer.posts.at(-1).tools, [tools[1]]);
      const postsBeforeLimits = peer.posts.length;

      const overLimit = await jsonCall(
        origin,
        "/v1/chat/completions",
        chat({ max_tokens: 129 }, permitted),
      );
      assert.equal(overLimit.status, 422);
      assert.equal(overLimit.body.error.code, "invalid");
      const oversizedContext = await jsonCall(
        origin,
        "/v1/chat/completions",
        chat(
          {
            messages: [{ role: "user", content: "synthetic-context-word ".repeat(6_000) }],
          },
          permitted,
        ),
      );
      assert.equal(oversizedContext.status, 422);
      assert.equal(oversizedContext.body.error.code, "invalid");
      assert.equal(
        peer.posts.length,
        postsBeforeLimits,
        "neither key context nor output limit reaches Gufo",
      );
      const postsBeforeStream = peer.posts.length;
      const stream = await fetch(`${origin}/v1/chat/completions`, {
        ...chat({ stream: true, stream_options: { include_usage: true } }, permitted),
        signal: AbortSignal.timeout(8_000),
      });
      assert.equal(stream.status, 200);
      assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/);
      assert.equal(stream.headers.get("x-priority"), "high");
      const events = (await stream.text())
        .split("\n\n")
        .filter((entry) => entry.startsWith("data: "))
        .map((entry) => entry.slice(6));
      assert.ok(events.includes("[DONE]"));
      const chunks = events.filter((event) => event !== "[DONE]").map((event) => JSON.parse(event));
      assert.ok(
        chunks.some((chunk) =>
          chunk.choices?.some((choice) => choice.delta?.content === "streamed answer"),
        ),
      );
      assert.ok(
        chunks.some(
          (chunk) => chunk.usage?.prompt_tokens === 11 && chunk.usage?.completion_tokens === 3,
        ),
      );
      assert.equal(peer.posts.length, postsBeforeStream + 1);
      assert.equal(peer.posts.at(-1).stream_options.include_usage, true);
      const eligible = await jsonCall(origin, "/v1/models", { headers: bearer(failover) });
      assert.equal(eligible.status, 200);
      assert.deepEqual(
        eligible.body.data.map(({ id }) => id),
        ["auto"],
      );
      peer.failure = "queue_full";
      const rejected = await jsonCall(origin, "/v1/chat/completions", chat({}, report));
      assert.equal(rejected.status, 503, JSON.stringify(rejected.body));
      assert.equal(rejected.body.error.code, "local_overloaded");
      assert.equal(rejected.headers.get("retry-after"), "2");
      assert.equal(cloud.posts.length, 0, "report does not disclose task to cloud peer");
      const overloadedStream = await fetch(`${origin}/v1/chat/completions`, {
        ...chat({ stream: true }, report),
        signal: AbortSignal.timeout(8_000),
      });
      assert.equal(overloadedStream.status, 200); // stream was committed before dispatch
      assert.match(overloadedStream.headers.get("content-type") ?? "", /text\/event-stream/);
      const terminal = await overloadedStream.text();
      const overloadEvent = /event: router\.error\r?\ndata: ([^\r\n]+)\r?\n/.exec(terminal);
      assert.ok(overloadEvent, terminal);
      assert.deepEqual(JSON.parse(overloadEvent[1]), {
        error: {
          code: "local_overloaded",
          message: "local deployment overloaded",
          retry_after_seconds: 2,
        },
      });
      assert.doesNotMatch(terminal, /streamed answer|\[DONE\]/);
      assert.equal(cloud.posts.length, 0, "report stream does not reach cloud");

      const recovered = await jsonCall(origin, "/v1/chat/completions", chat({}, failover));
      assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
      assert.equal(recovered.headers.get("x-deployment-id"), "cloud-test");
      assert.equal(recovered.headers.get("x-priority"), "high");
      assert.equal(recovered.body.choices[0].message.content, "fixture cloud recovery");
      assert.equal(cloud.posts.length, 1);
      assert.deepEqual(cloud.posts[0].provider.only, ["fixture/provider"]);

      peer.failure = "service_unavailable";
      const genericFailure = await jsonCall(origin, "/v1/chat/completions", chat({}, failover));
      assert.equal(genericFailure.status, 502, JSON.stringify(genericFailure.body));
      assert.equal(genericFailure.body.error.code, "provider_failure");
      assert.equal(
        cloud.posts.length,
        1,
        "ambiguous provider failure cannot trigger cloud failover",
      );
      peer.failure = null;

      peer.completionModel = "wrong-model-served";
      const mismatched = await jsonCall(origin, "/v1/chat/completions", chat({}, permitted));
      assert.equal(mismatched.status, 502, JSON.stringify(mismatched.body));
      assert.equal(mismatched.body.error.code, "provider_failure");
      assert.notEqual(mismatched.body.choices?.[0]?.message?.content, "gufo fixture answer");

      peer.advertisedModel = "wrong-model-advertised";
      await delay(5_100, undefined, { signal: t.signal }); // health snapshot has a five-second TTL
      const stale = await jsonCall(origin, "/health/ready");
      assert.equal(stale.status, 200, JSON.stringify(stale.body));
      assert.equal(stale.body.deployments.find(({ id }) => id === DEPLOYMENT_ID)?.ready, false);
      assert.ok(
        peer.paths.every((path) => !/^GET \/(?:health|slots)(?:\?|$|\/)/.test(path)),
        "Gufo peer must not use llama.cpp/Halogen health or slot paths",
      );
      assert.equal(peer.error, null, String(peer.error));
      assert.equal(cloud.error, null, String(cloud.error));
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exit;
      }
      fixture.closeAllConnections();
      await close(fixture);
      cloudFixture.closeAllConnections();
      await close(cloudFixture);
      await rm(directory, { recursive: true, force: true });
    }
  },
);
