import "server-only";
import { createServer } from "node:http";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { getEnv } from "../env.ts";
import type { HealthSnapshot } from "../src/http/contracts.ts";
import { gatewayHealth } from "./health.ts";
import {
  clearSqlMetrics,
  observeCapacity,
  observeHealth,
  observeSqlMetrics,
  recordScrapeDuration,
  renderMetrics,
  type SqlMetrics,
} from "./metrics.ts";
import { processState } from "./state.ts";

let lastHealth: HealthSnapshot | undefined;
let sqlite: DatabaseSync | undefined;
let queries:
  | {
      keys: StatementSync;
      keyInfo: StatementSync;
      jobs: StatementSync;
      items: StatementSync;
      remotes: StatementSync;
    }
  | undefined;

/** Read-only, prepared GROUP BY statements; no admission, migrations or inference are involved. */
function readSqlSnapshot(): SqlMetrics | undefined {
  try {
    if (queries === undefined) {
      sqlite = new DatabaseSync(getEnv().SQLITE_PATH, { readOnly: true });
      queries = {
        keys: sqlite.prepare(
          "SELECT CASE WHEN revoked_at IS NOT NULL THEN 'revoked' WHEN expires_at IS NOT NULL AND expires_at <= ? THEN 'expired' ELSE 'active' END AS state, count(*) AS count FROM api_keys GROUP BY state",
        ),
        keyInfo: sqlite.prepare(
          "SELECT id, name, policy_json AS policyJson FROM api_keys WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)",
        ),
        jobs: sqlite.prepare("SELECT status, count(*) AS count FROM batch_jobs GROUP BY status"),
        items: sqlite.prepare("SELECT status, count(*) AS count FROM batch_items GROUP BY status"),
        remotes: sqlite.prepare(
          "SELECT intent AS state, count(*) AS count FROM batch_remotes GROUP BY intent",
        ),
      };
    }
    const now = Date.now();
    return {
      keys: queries.keys.all(now) as unknown as SqlMetrics["keys"],
      keyInfo: queries.keyInfo.all(now) as unknown as SqlMetrics["keyInfo"],
      jobs: queries.jobs.all() as unknown as SqlMetrics["jobs"],
      items: queries.items.all() as unknown as SqlMetrics["items"],
      remotes: queries.remotes.all() as unknown as SqlMetrics["remotes"],
    };
  } catch {
    // Database may not exist before first control-plane use; retry on the next scrape.
    if (queries === undefined) {
      sqlite?.close();
      sqlite = undefined;
    }
    return undefined;
  }
}

async function sampleLive(): Promise<void> {
  const probe = gatewayHealth()
    .then((snapshot) => {
      lastHealth = snapshot;
      return snapshot;
    })
    .catch(() => lastHealth);
  let timeoutHandle: number | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timeoutHandle = setTimeout(resolve, 2_000);
  });
  const health = await Promise.race([probe, timeout]);
  if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  observeHealth(
    health ??
      lastHealth ?? {
        ready: false,
        persistence: false,
        checkedAt: Date.now(),
        classifier: { ready: false, backend: "unknown", local: false, evidence: "unavailable" },
        deployments: [],
      },
  );
  const chatRows =
    processState.inference?.catalogue.map((item) => ({
      ...(processState.routerCapacity?.snapshot(item.id) ?? {
        deploymentId: item.id,
        runningHigh: 0,
        runningMedium: 0,
        runningLow: 0,
        waiting: 0,
      }),
      maxParallel: item.capacity.maxParallel,
      reservedInteractiveSlots: item.capacity.reservedInteractiveSlots,
    })) ?? [];
  const auxiliaryRows =
    processState.auxiliary?.map((item) => ({
      ...processState.auxiliaryPool.snapshot(item.resourceId),
      deploymentId: item.id,
      maxParallel: item.capacity.maxParallel,
      reservedInteractiveSlots: item.capacity.reservedInteractiveSlots,
    })) ?? [];
  observeCapacity(
    [...chatRows, ...auxiliaryRows],
    (chatRows[0]?.waiting ?? 0) + (auxiliaryRows[0]?.waiting ?? 0),
  );
  const sql = readSqlSnapshot();
  if (sql !== undefined) observeSqlMetrics(sql);
  else clearSqlMetrics();
}

export async function startMetricsListener(port: number, sample: () => Promise<void> = sampleLive) {
  if (processState.metricsStarting !== undefined) return processState.metricsStarting;
  if (processState.metricsServer !== undefined) return processState.metricsServer;
  const server = createServer((request, response) => {
    if (request.url !== "/metrics") {
      response.writeHead(404, { "Cache-Control": "no-store" }).end();
      return;
    }
    if (request.method !== "GET") {
      response.writeHead(405, { Allow: "GET", "Cache-Control": "no-store" }).end();
      return;
    }
    const start = performance.now();
    void sample()
      .then(() => {
        response
          .writeHead(200, {
            "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
            "Cache-Control": "no-store",
          })
          .end(renderMetrics());
      })
      .catch(() => {
        response.writeHead(503, { "Cache-Control": "no-store" }).end();
      })
      .finally(() => recordScrapeDuration((performance.now() - start) / 1000));
  });
  const starting = new Promise<typeof server>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => {
      server.removeListener("error", reject);
      processState.metricsServer = server;
      resolve(server);
    });
  });
  processState.metricsStarting = starting;
  try {
    return await starting;
  } finally {
    processState.metricsStarting = undefined;
  }
}

export async function stopMetricsListener(): Promise<void> {
  const server =
    processState.metricsServer ?? (await processState.metricsStarting?.catch(() => undefined));
  if (server === undefined) return;
  processState.metricsServer = undefined;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  queries = undefined;
  sqlite?.close();
  sqlite = undefined;
}
