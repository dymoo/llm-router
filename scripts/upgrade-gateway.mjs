#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const drain = spawnSync(process.execPath, ["scripts/drain.mjs", "--compose"], { stdio: "inherit" });
if (drain.status !== 0) process.exit(drain.status ?? 1);

const up = spawnSync("docker", ["compose", "up", "-d", "--no-deps", "--build", "gateway"], {
  stdio: "inherit",
});
process.exit(up.status ?? 1);
