#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const compose = process.argv.includes("--compose");
const all = process.argv.includes("--all");
const timeoutSec = 720;

if (!compose) {
  console.error("Native drain: send SIGTERM to the gateway process and wait until it exits.");
  console.error("Lease window is 12 minutes; generation timeout is 10 minutes.");
  console.error("This script drives Compose: node scripts/drain.mjs --compose [--all]");
  process.exit(1);
}

// Drain admitted work before stopping the processes that are serving it.
const result = spawnSync(
  "docker",
  ["compose", "stop", "--timeout", String(timeoutSec), "gateway"],
  {
    stdio: "inherit",
  },
);
if (result.status !== 0) process.exit(result.status ?? 1);
if (all) {
  const runtimes = spawnSync("docker", ["compose", "--profile", "*", "stop", "--timeout", "120"], {
    stdio: "inherit",
  });
  if (runtimes.status !== 0) process.exit(runtimes.status ?? 1);
}

if (!all) {
  console.log("Stopped gateway only. Other runtimes and WebUI were left running.");
  console.log("Rebuild gateway without reloading model runtimes:");
  console.log("  docker compose up -d --no-deps --build gateway");
} else {
  console.log("Stopped all Compose services; the native host generator is separate.");
}
