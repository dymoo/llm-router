import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { openControlPlaneSqlite } from "../src/db/sqlite.ts";
import { apiKeys } from "../src/db/schema.ts";
import { eq } from "drizzle-orm";

function command(script: string, args: string[], database: string) {
  return spawnSync(process.execPath, [`scripts/${script}.mjs`, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, SQLITE_PATH: database },
    encoding: "utf8",
  });
}
function keyName(path: string) {
  const opened = openControlPlaneSqlite(path);
  try {
    return opened.db.select({ name: apiKeys.name }).from(apiKeys).get()?.name;
  } finally {
    opened.sqlite.close();
  }
}

test("online backup includes committed WAL and offline restore preserves a previous snapshot", () => {
  const directory = mkdtempSync(join(tmpdir(), "hub-backup-"));
  const database = join(directory, "control.sqlite");
  const snapshot = join(directory, "snapshot.sqlite");
  const opened = openControlPlaneSqlite(database);
  try {
    opened.db
      .insert(apiKeys)
      .values({
        id: "key",
        prefix: "test",
        digest: "test",
        name: "original",
        policyJson: "{}",
        createdAt: 1,
        version: 1,
      })
      .run();
    const copied = command("backup", [snapshot], database);
    assert.equal(copied.status, 0, copied.stderr);
    assert.equal(keyName(snapshot), "original");
    assert.equal(statSync(snapshot).mode & 0o777, 0o600);
    opened.db.update(apiKeys).set({ name: "changed" }).where(eq(apiKeys.id, "key")).run();
    assert.notEqual(command("backup", [snapshot], database).status, 0);
    assert.equal(keyName(snapshot), "original");
    opened.sqlite.close();
    assert.notEqual(command("restore", [snapshot], database).status, 0);
    assert.equal(keyName(database), "changed");
    const restored = command("restore", ["--replace", "--offline", snapshot], database);
    assert.equal(restored.status, 0, restored.stderr);
    assert.equal(keyName(database), "original");
    assert.equal(statSync(database).mode & 0o777, 0o600);
    const previous = readdirSync(directory).find((name) => name.includes("before-restore"));
    assert.ok(previous);
    assert.equal(keyName(join(directory, previous)), "changed");
  } finally {
    try {
      opened.sqlite.close();
    } catch {
      /* already closed for offline restore */
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("foreign database restore is refused without changing the destination", () => {
  const directory = mkdtempSync(join(tmpdir(), "hub-restore-invalid-"));
  const database = join(directory, "control.sqlite");
  const foreign = join(directory, "foreign.sqlite");
  const opened = openControlPlaneSqlite(database);
  opened.db
    .insert(apiKeys)
    .values({
      id: "key",
      prefix: "test",
      digest: "test",
      name: "keep",
      policyJson: "{}",
      createdAt: 1,
      version: 1,
    })
    .run();
  opened.sqlite.close();
  const other = new DatabaseSync(foreign);
  other.exec("CREATE TABLE unrelated (value TEXT)");
  other.close();
  try {
    assert.notEqual(command("restore", ["--replace", "--offline", foreign], database).status, 0);
    assert.equal(keyName(database), "keep");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
