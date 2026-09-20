#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { snapshotDatabase, validateDatabase } from "./sqlite-ops.mjs";

const args = process.argv.slice(2);
const compose = args.includes("--compose");
if (args.some((value) => value.startsWith("--") && value !== "--compose"))
  throw new Error("Unknown backup option");
const paths = args.filter((value) => !value.startsWith("--"));
if (paths.length > 1) throw new Error("Provide at most one backup destination");
const stamp = new Date().toISOString().replaceAll(":", "-");
const destination = path.resolve(
  paths[0] ??
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "data",
      "backups",
      `control-${stamp}.sqlite`,
    ),
);
if (existsSync(destination))
  throw new Error("Backup destination already exists; refusing overwrite");
mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });

function docker(args) {
  const result = spawnSync("docker", ["compose", ...args], { stdio: "inherit" });
  if (result.error || result.status !== 0) throw new Error("Compose backup command failed");
}

if (compose) {
  const remote = `/tmp/control-backup-${randomUUID()}.sqlite`;
  let localCreated = false;
  try {
    docker(["exec", "-T", "gateway", "node", "/opt/ops/backup.mjs", remote]);
    closeSync(openSync(destination, "wx", 0o600));
    localCreated = true;
    docker(["cp", `gateway:${remote}`, destination]);
    chmodSync(destination, 0o600);
    validateDatabase(destination);
  } catch (error) {
    if (localCreated) unlinkSync(destination);
    throw error;
  } finally {
    spawnSync(
      "docker",
      [
        "compose",
        "exec",
        "-T",
        "gateway",
        "node",
        "--input-type=module",
        "-e",
        'import { rmSync } from "node:fs"; rmSync(process.argv[1], { force: true });',
        remote,
      ],
      { stdio: "ignore" },
    );
  }
} else {
  const source = process.env.SQLITE_PATH;
  if (!source) throw new Error("SQLITE_PATH is required for native backup (or pass --compose)");
  await snapshotDatabase(source, destination);
}
console.log(`Verified backup written to ${destination}`);
