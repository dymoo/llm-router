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
  "production SIGTERM drains admitted generation in the API server",
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
        // A generic OpenAI peer: these tests cover router machinery, gufo.test.mjs covers Gufo.
        transport: "openai-compatible",
        credentialEnvVar: null,
        endpoint: `http://127.0.0.1:${upstreamPort}/v1`,
        contextLimitTokens: 65536,
        maxOutputTokens: 8192,
        reasoning: { kind: "binary" },
      });
      Object.assign(catalogue[0].prices, {
        inputUsdPerMillion: 1,
        cachedInputUsdPerMillion: 1,
        outputUsdPerMillion: 1,
        provenance: { unit: "USD-per-million-tokens", source: "test", asOf: "2026-09-20" },
      });
      const cataloguePath = join(directory, "catalog.json");
      const databasePath = join(directory, "control.sqlite");
      await writeFile(cataloguePath, JSON.stringify(catalogue), { mode: 0o600 });
      child = spawn(process.execPath, ["dist/server/main.mjs"], {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          NODE_ENV: "production",
          HOST: "127.0.0.1",
          PORT: String(port),
          APP_ORIGIN: origin,
          SQLITE_PATH: databasePath,
          MODEL_CATALOG: cataloguePath,
          AUXILIARY_CATALOG: "",
          API_KEY_PEPPER: randomUUID(),
        },
      });
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
      const policy = { priority: "medium", cloud: false, requestsPerMinute: 60, maxConcurrent: 2 };
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

test(
  "API server: unknown paths 404, wrong methods 405, and a client disconnect mid-stream frees the upstream",
  { timeout: 30_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "llm-router-disconnect-"));
    const upstreamClosed = Promise.withResolvers();
    const fixture = createServer((request, response) => {
      if (request.method !== "POST") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ data: [{ id: "fixture-chat" }] }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        'data: {"id":"s","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"}}]}\n\n',
      );
      // Never finishes: only the client going away can end this stream.
      response.once("close", () => upstreamClosed.resolve());
    });
    let child;
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
        transport: "openai-compatible",
        credentialEnvVar: null,
        endpoint: `http://127.0.0.1:${upstreamPort}/v1`,
        contextLimitTokens: 65536,
        maxOutputTokens: 8192,
        reasoning: { kind: "binary" },
      });
      const cataloguePath = join(directory, "catalog.json");
      const databasePath = join(directory, "control.sqlite");
      await writeFile(cataloguePath, JSON.stringify(catalogue), { mode: 0o600 });
      child = spawn(process.execPath, ["dist/server/main.mjs"], {
        stdio: "ignore",
        env: {
          ...process.env,
          NODE_ENV: "production",
          HOST: "127.0.0.1",
          PORT: String(port),
          APP_ORIGIN: origin,
          SQLITE_PATH: databasePath,
          MODEL_CATALOG: cataloguePath,
          AUXILIARY_CATALOG: "",
          API_KEY_PEPPER: randomUUID(),
        },
      });
      child.once("exit", (code, signal) => exited.resolve({ code, signal }));
      const readyDeadline = Date.now() + 15_000;
      for (;;) {
        try {
          if ((await fetch(`${origin}/health/live`, { signal: AbortSignal.timeout(500) })).ok)
            break;
        } catch {
          /* wait for listener */
        }
        assert.ok(Date.now() < readyDeadline && child.exitCode === null);
        await delay(25, undefined, { signal: t.signal });
      }
      assert.equal((await fetch(`${origin}/api/nope`)).status, 404);
      const wrongMethod = await fetch(`${origin}/v1/chat/completions`);
      assert.equal(wrongMethod.status, 405);
      assert.equal(wrongMethod.headers.get("allow"), "POST");
      const created = await fetch(`${origin}/api/admin/keys`, {
        method: "POST",
        headers: { "content-type": "application/json", origin, "x-jev-admin": "1" },
        body: JSON.stringify({
          name: "disconnect test",
          expiresAt: null,
          policy: { priority: "high", cloud: false, requestsPerMinute: 0, maxConcurrent: 0 },
        }),
      }).then((response) => response.json());
      const client = new AbortController();
      const response = await fetch(`${origin}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${created.secret}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: "auto",
          stream: true,
          messages: [{ role: "user", content: "stream" }],
        }),
        signal: client.signal,
      });
      assert.equal(response.status, 200);
      const reader = response.body.getReader();
      for (let text = ""; !text.includes('"hi"');) {
        text += new TextDecoder().decode((await reader.read()).value);
      }
      client.abort();
      await upstreamClosed.promise;
      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        for (let row; row?.status !== "abandoned"; await delay(25)) {
          row = database.prepare("SELECT status FROM requests").get();
        }
      } finally {
        database.close();
      }
    } finally {
      if (child && child.exitCode === null) {
        child.kill("SIGKILL");
        await exited.promise;
      }
      fixture.closeAllConnections();
      await close(fixture);
      await rm(directory, { recursive: true, force: true });
    }
  },
);
