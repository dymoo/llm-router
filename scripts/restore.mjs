#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chownSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { checkpointOffline, snapshotDatabase, validateDatabase } from "./sqlite-ops.mjs";

const args = process.argv.slice(2);
const compose = args.includes("--compose");
const replace = args.includes("--replace");
const offline = args.includes("--offline");
if (
  args.some(
    (value) => value.startsWith("--") && !["--compose", "--replace", "--offline"].includes(value),
  )
)
  throw new Error("Unknown restore option");
const paths = args.filter((value) => !value.startsWith("--"));
if (!replace || paths.length !== 1)
  throw new Error(
    "usage: node scripts/restore.mjs --replace [--compose | --offline] <backup.sqlite>",
  );
const source = path.resolve(paths[0]);
validateDatabase(source); // Reject corrupt/foreign snapshots before stopping or replacing anything.

if (compose) {
  const staging = mkdtempSync(path.join(tmpdir(), "llm-router-restore-"));
  const stagedSource = path.join(staging, "source.sqlite");
  try {
    // Snapshot before bind-mounting: mounting only a live main file would omit its WAL.
    await snapshotDatabase(source, stagedSource);
    const stopped = spawnSync("docker", ["compose", "stop", "--timeout", "720", "gateway"], {
      stdio: "inherit",
    });
    if (stopped.error || stopped.status !== 0)
      throw new Error("Gateway drain failed; restore was not attempted");
    const restored = spawnSync(
      "docker",
      [
        "compose",
        "run",
        "--rm",
        "--no-deps",
        "--user",
        "0:0",
        "--entrypoint",
        "node",
        "--volume",
        `${stagedSource}:/restore/source.sqlite:ro`,
        "gateway",
        "/opt/ops/restore.mjs",
        "--replace",
        "--offline",
        "/restore/source.sqlite",
      ],
      { stdio: "inherit" },
    );
    if (restored.error || restored.status !== 0)
      throw new Error(
        "Restore failed; gateway remains stopped. Inspect the retained previous snapshot before restarting.",
      );
    console.log(
      "Verified restore complete. Start explicitly: docker compose up -d --no-deps gateway",
    );
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
} else {
  if (!offline)
    throw new Error(
      "Stop the native gateway first, then pass --offline to acknowledge exclusive ownership",
    );
  const configured = process.env.SQLITE_PATH;
  if (!configured) throw new Error("SQLITE_PATH is required for native restore");
  const destination = path.resolve(configured);
  if (source === destination) throw new Error("Source and destination must differ");
  mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const owner = statSync(existsSync(destination) ? destination : path.dirname(destination));
  const temporary = `${destination}.restore-${randomUUID()}`;
  const previous = `${destination}.before-restore-${randomUUID()}.sqlite`;
  try {
    await snapshotDatabase(source, temporary);
    if (existsSync(destination)) {
      await snapshotDatabase(destination, previous);
      checkpointOffline(destination);
      if (process.getuid?.() === 0) chownSync(previous, owner.uid, owner.gid);
    }
    if (process.getuid?.() === 0) chownSync(temporary, owner.uid, owner.gid);
    // --offline is mandatory: stale sidecars must not be replayed into the replacement.
    rmSync(`${destination}-wal`, { force: true });
    rmSync(`${destination}-shm`, { force: true });
    renameSync(temporary, destination);
    console.log(`Verified restore written to ${destination}`);
    if (existsSync(previous)) console.log(`Previous database retained at ${previous}`);
  } finally {
    rmSync(temporary, { force: true });
  }
}
console.log(
  "Session pins do not survive restart. Use a new task or checkpoint; retain the matching API-key pepper.",
);
