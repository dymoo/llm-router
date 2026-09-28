import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createServer as createPortReservation } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

async function listen(server) {
  const listening = Promise.withResolvers();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}
async function close(server) {
  const closed = Promise.withResolvers();
  server.close(closed.resolve);
  await closed.promise;
}

test(
  "production SIGTERM drains admitted generation across instrumentation and route bundles",
  { timeout: 30_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "llm-router-production-"));
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const fixture = createServer(async (request, response) => {
      try {
        response.setHeader("content-type", "application/json");
        if (request.url === "/health") {
          response.end(JSON.stringify({ status: "ok" }));
          return;
        }
        if (request.url === "/slots") {
          response.end(JSON.stringify([{ is_processing: false }]));
          return;
        }
        if (request.method !== "POST") {
          response.statusCode = 404;
          response.end();
          return;
        }
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        if (request.url === "/v1/systemone") {
          const choices = {
            task: "coding",
            difficulty: "easy",
            effort: "low",
            expectedLength: "short",
          };
          const answers = Object.fromEntries(
            Object.entries(body.questions).map(([id, question]) => {
              if (question.type === "noul")
                return [id, { type: "noul", noul: id === "localSufficiency" ? 1 : 0 }];
              return [
                id,
                {
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
              ];
            }),
          );
          response.end(
            JSON.stringify({
              model: body.model,
              answers,
              usage: { input_tokens: 100, output_tokens: 0 },
            }),
          );
          return;
        }
        if (request.url !== "/v1/chat/completions") {
          response.statusCode = 404;
          response.end();
          return;
        }
        assert.equal(body.model, "fixture-chat");
        entered.resolve();
        await release.promise;
        response.end(
          JSON.stringify({
            id: "fixture",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "complete" },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 2,
              prompt_tokens_details: { cached_tokens: 0 },
            },
          }),
        );
      } catch {
        response.statusCode = 500;
        response.end(JSON.stringify({ error: "fixture failed" }));
      }
    });
    let child;
    let logs = "";
    const exited = Promise.withResolvers();
    try {
      const upstreamPort = await listen(fixture);
      const reservation = createPortReservation();
      const port = await listen(reservation);
      await close(reservation);
      const origin = `http://127.0.0.1:${port}`;
      const catalogue = JSON.parse(await readFile("catalog.example.json", "utf8")).slice(0, 1);
      Object.assign(catalogue[0], {
        id: "fixture",
        modelId: "fixture-chat",
        endpoint: `http://127.0.0.1:${upstreamPort}/v1`,
        contextLimitTokens: 65536,
        maxOutputTokens: 8192,
        reasoning: { kind: "binary" },
      });
      for (const key of ["chat", "coding", "math", "analysis", "writing", "extraction"])
        catalogue[0].quality[key] = 0.9;
      Object.assign(catalogue[0].prices, {
        inputUsdPerMillion: 1,
        cachedInputUsdPerMillion: 1,
        outputUsdPerMillion: 1,
        provenance: { unit: "USD-per-million-tokens", source: "test", asOf: "2026-09-20" },
      });
      const cataloguePath = join(directory, "catalog.json");
      const databasePath = join(directory, "control.sqlite");
      const qualificationPath = join(directory, "classifier-qualification.json");
      const questionIds = [
        "task",
        "difficulty",
        "effort",
        "trivialChat",
        "localSufficiency",
        "freshFacts",
        "expectedLength",
      ];
      // Drain test evidence: labelled per-question counts, not a quality claim.
      const metric = { cases: 20, negativeCases: 10, errors: 1, falsePositives: 0 };
      const threshold = (id) => ({
        maxErrorRate: 0.2,
        maxFalsePositiveRate: ["localSufficiency", "trivialChat"].includes(id) ? 0 : null,
      });
      await writeFile(cataloguePath, JSON.stringify(catalogue), { mode: 0o600 });
      await writeFile(
        qualificationPath,
        JSON.stringify([
          {
            backend: "jev",
            modelRevision: "jev-1.13.0",
            questionSchemaVersion: "dymoo-assessment-questions/v1",
            calibration: {
              evaluationSet: {
                id: "production-drain-fixture",
                cases: 20,
                labelsSource: "test fixture",
                asOf: "2026-09-22",
              },
              measuredAt: "2026-09-22",
              method: "test fixture",
              metrics: Object.fromEntries(questionIds.map((id) => [id, { ...metric }])),
              thresholds: Object.fromEntries(questionIds.map((id) => [id, threshold(id)])),
              verdict: "pass",
            },
            rates: {
              inputUsdPerMillion: 0.042,
              outputUsdPerMillion: 0,
              provenance: {
                unit: "USD-per-million-tokens",
                source: "test fixture",
                asOf: "2026-09-22",
              },
            },
          },
        ]),
        { mode: 0o600 },
      );
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
            ...process.env,
            NODE_ENV: "production",
            NEXT_TELEMETRY_DISABLED: "1",
            NEXT_MANUAL_SIG_HANDLE: "true",
            APP_ORIGIN: origin,
            SQLITE_PATH: databasePath,
            MODEL_CATALOG: cataloguePath,
            AUXILIARY_CATALOG: "",
            API_KEY_PEPPER: randomUUID(),
            CLASSIFIER_MODE: "jev",
            CLASSIFIER_QUALIFICATION: qualificationPath,
            TYPESAFE_API_KEY: "fixture-only",
            TYPESAFE_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
            TYPESAFE_MODEL: "jev-1.13.0",
          },
        },
      );
      child.stdout.on("data", (chunk) => {
        logs = (logs + chunk).slice(-20_000);
      });
      child.stderr.on("data", (chunk) => {
        logs = (logs + chunk).slice(-20_000);
      });
      child.once("error", exited.reject);
      child.once("exit", (code, signal) => exited.resolve({ code, signal }));
      t.signal.addEventListener(
        "abort",
        () => {
          release.resolve();
          child?.kill("SIGKILL");
        },
        { once: true },
      );
      const readyDeadline = Date.now() + 15_000;
      for (;;) {
        try {
          if ((await fetch(`${origin}/health/live`, { signal: AbortSignal.timeout(500) })).ok)
            break;
        } catch {
          /* wait for listener */
        }
        assert.ok(Date.now() < readyDeadline && child.exitCode === null, logs);
        await delay(25, undefined, { signal: t.signal });
      }
      const policy = {
        priority: "medium",
        localityBias: 0.65,
        contextLimitTokens: 4096,
        maxCompletionTokens: 128,
        allowedModels: null,
        requestsPerMinute: 60,
        maxConcurrent: 2,
        maxWaitMs: 1000,
        maxEstimatedUsd: null,
        bias: { cost: 0.7, quality: 0.8, latency: 0.3 },
      };
      const createdResponse = await fetch(`${origin}/api/admin/keys`, {
        method: "POST",
        headers: { "content-type": "application/json", origin, "x-jev-admin": "1" },
        body: JSON.stringify({ name: "production drain test", expiresAt: null, policy }),
      });
      assert.equal(createdResponse.status, 201);
      const created = await createdResponse.json();
      const headers = {
        authorization: `Bearer ${created.secret}`,
        "content-type": "application/json",
      };
      const payload = {
        model: "auto",
        messages: [{ role: "user", content: "Complete a coding task." }],
      };
      const pending = fetch(`${origin}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: t.signal,
      }).then(
        async (response) => ({ status: response.status, body: await response.json() }),
        (error) => ({ error }),
      );
      await Promise.race([
        entered.promise,
        pending.then((result) => {
          throw new Error(
            `Generation ended before the fixture was entered: ${JSON.stringify(result)}`,
          );
        }),
      ]);
      child.kill("SIGTERM");
      const stoppingDeadline = Date.now() + 1500;
      for (;;) {
        const response = await fetch(`${origin}/health/ready`, { signal: t.signal });
        if (response.status === 503 && (await response.json()).stopping === true) break;
        assert.ok(Date.now() < stoppingDeadline, "Readiness must become false during drain");
        await delay(25, undefined, { signal: t.signal });
      }
      const denied = await fetch(`${origin}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      assert.equal(denied.status, 503);
      release.resolve();
      const completed = await pending;
      assert.equal(completed.status, 200, JSON.stringify(completed));
      assert.equal(completed.body.usage.cost, 0.000012);
      assert.deepEqual(await exited.promise, { code: 0, signal: null });
      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        assert.deepEqual(
          {
            ...database
              .prepare("SELECT status, prompt_tokens, completion_tokens FROM requests")
              .get(),
          },
          { status: "success", prompt_tokens: 10, completion_tokens: 2 },
        );
      } finally {
        database.close();
      }
    } finally {
      release.resolve();
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exited.promise;
      }
      fixture.closeAllConnections();
      await close(fixture);
      await rm(directory, { recursive: true, force: true });
    }
  },
);
