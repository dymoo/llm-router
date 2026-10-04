import "server-only";
import { createServer } from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Layer } from "effect";
import { HttpEffect, HttpRouter, HttpStaticServer } from "effect/unstable/http";
import { getEnv } from "../env.ts";
import { startBatch } from "./batch.ts";
import { registerShutdown } from "./lifecycle.ts";
import { startMetricsListener } from "./metrics-listener.ts";
import { dispatch, routes } from "./routes.ts";

const api = HttpRouter.use((router) =>
  Effect.forEach(Object.keys(routes), (path) =>
    router.add(
      "*",
      path as HttpRouter.PathInput,
      Effect.flatMap(HttpRouter.params, ({ id }) =>
        HttpEffect.fromWebHandler(async (request) => dispatch(path, request, id)),
      ),
    ),
  ),
);

// The console is a static export. Fly's in-machine Caddy serves it from disk itself;
// Compose and native runs have no Caddy, so the API server serves it when CONSOLE_DIR is set.
const consoleDir = process.env.CONSOLE_DIR;
const app = consoleDir ? Layer.merge(api, HttpStaticServer.layer({ root: consoleDir })) : api;

const config = getEnv();
const port = Number(process.env.PORT ?? 3000);
if (config.METRICS_PORT !== undefined) {
  await startMetricsListener(config.METRICS_PORT, process.env.METRICS_HOST ?? "0.0.0.0");
}
startBatch();
// Drain owns SIGTERM/SIGINT: the listener keeps answering (503 for new work) while admitted work finishes.
registerShutdown();

Effect.runPromise(
  Layer.launch(
    HttpRouter.serve(app, { disableLogger: true }).pipe(
      Layer.provide(
        NodeHttpServer.layer(createServer, { port, host: process.env.HOST ?? "0.0.0.0" }),
      ),
    ),
  ),
).catch((error: unknown) => {
  console.error("HTTP server failed", error);
  process.exit(1);
});
