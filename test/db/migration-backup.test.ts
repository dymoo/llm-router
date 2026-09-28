import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, it } from "node:test";
import { CONTROL_PLANE_SCHEMA_IDENTITY } from "../../src/domain.ts";
import { DatabaseError } from "../../src/errors.ts";
import {
  CONTROL_PLANE_V1_SQL,
  CONTROL_PLANE_V2_SQL,
  CONTROL_PLANE_V3_SQL,
  CONTROL_PLANE_V4_SQL,
} from "../../src/db/migrations-sql.ts";
import { CONTROL_PLANE_SCHEMA_VERSION } from "../../src/db/migrate.ts";
import { openControlPlaneSqlite } from "../../src/db/sqlite.ts";

const dirs: string[] = [];

function tempDb(): string {
  const directory = mkdtempSync(join(tmpdir(), "llm-router-migration-"));
  dirs.push(directory);
  return join(directory, "control.sqlite");
}

function createV4(path: string): void {
  const sqlite = new DatabaseSync(path);
  try {
    for (const sql of [
      CONTROL_PLANE_V1_SQL,
      CONTROL_PLANE_V2_SQL,
      CONTROL_PLANE_V3_SQL,
      CONTROL_PLANE_V4_SQL,
    ])
      sqlite.exec(sql);
    sqlite.exec("PRAGMA user_version = 4");
    sqlite
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?)")
      .run("schema_identity", CONTROL_PLANE_SCHEMA_IDENTITY);
    sqlite.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("schema_version", "4");
    sqlite
      .prepare(
        "INSERT INTO api_keys (id, prefix, digest, name, policy_json, created_at, version) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("original-key", "jrv_aaaaaaaaaaaaaaaaaaaaaaaa", "ab".repeat(32), "kept", "{}", 1, 1);
  } finally {
    sqlite.close();
  }
}

function version(sqlite: DatabaseSync): number {
  const row = sqlite.prepare("PRAGMA user_version").get() as { user_version: number };
  return row.user_version;
}

function keyName(sqlite: DatabaseSync): string | undefined {
  const row = sqlite.prepare("SELECT name FROM api_keys WHERE id = 'original-key'").get() as
    | { name: string }
    | undefined;
  return row?.name;
}

after(() => {
  for (const directory of dirs) rmSync(directory, { recursive: true, force: true });
});

it("backs up a v4 control-plane database before upgrading to v5", () => {
  const path = tempDb();
  createV4(path);
  const writer = new DatabaseSync(path);
  writer.exec("PRAGMA journal_mode = WAL");
  writer.prepare("UPDATE api_keys SET name = 'wal-kept' WHERE id = 'original-key'").run();
  const opened = openControlPlaneSqlite(path);
  try {
    assert.equal(version(opened.sqlite), CONTROL_PLANE_SCHEMA_VERSION);
    const files = readdirSync(join(dirname(path), "backups"));
    assert.equal(files.length, 1);
    const [backupName] = files;
    assert.ok(backupName !== undefined);
    assert.match(backupName, /^control-pre-v5-\d{4}-\d\d-\d\dT.*Z\.sqlite$/);
    const backupPath = join(dirname(path), "backups", backupName);
    assert.equal(statSync(join(dirname(path), "backups")).mode & 0o777, 0o700);
    assert.equal(statSync(backupPath).mode & 0o777, 0o600);
    const backup = new DatabaseSync(backupPath, { readOnly: true });
    try {
      assert.equal(version(backup), 4);
      const identity = backup
        .prepare("SELECT value FROM settings WHERE key = 'schema_identity'")
        .get() as { value: string } | undefined;
      assert.equal(identity?.value, CONTROL_PLANE_SCHEMA_IDENTITY);
      const storedVersion = backup
        .prepare("SELECT value FROM settings WHERE key = 'schema_version'")
        .get() as { value: string } | undefined;
      assert.equal(storedVersion?.value, "4");
      assert.equal(keyName(backup), "wal-kept");
      assert.equal(
        backup.prepare("SELECT name FROM sqlite_master WHERE name = 'batch_jobs'").get(),
        undefined,
      );
    } finally {
      backup.close();
    }
    assert.equal(keyName(opened.sqlite), "wal-kept");
  } finally {
    opened.sqlite.close();
    writer.close();
  }
});

it("does not create a backup for a fresh or already-current database", () => {
  const path = tempDb();
  const backupDir = join(dirname(path), "backups");
  const first = openControlPlaneSqlite(path);
  try {
    assert.equal(version(first.sqlite), CONTROL_PLANE_SCHEMA_VERSION);
    assert.equal(existsSync(backupDir), false);
  } finally {
    first.sqlite.close();
  }
  const second = openControlPlaneSqlite(path);
  try {
    assert.equal(version(second.sqlite), CONTROL_PLANE_SCHEMA_VERSION);
    assert.equal(existsSync(backupDir), false);
  } finally {
    second.sqlite.close();
  }
});

it("retains only five automatic backups for the target version and leaves operator backups alone", () => {
  const path = tempDb();
  createV4(path);
  const directory = join(dirname(path), "backups");
  mkdirSync(directory, { mode: 0o700 });
  const prefix = "control-pre-v5-";
  const old = Array.from(
    { length: 5 },
    (_, index) => `${prefix}2025-01-0${index + 1}T00-00-00.000Z.sqlite`,
  );
  for (const name of old) writeFileSync(join(directory, name), "prior snapshot");
  const operator = "control-pre-batch-v5-2025-01-01.sqlite";
  writeFileSync(join(directory, operator), "operator backup");
  writeFileSync(join(directory, "notes.txt"), "do not touch");

  const opened = openControlPlaneSqlite(path);
  try {
    assert.equal(version(opened.sqlite), CONTROL_PLANE_SCHEMA_VERSION);
    const files = readdirSync(directory);
    const automatic = files.filter((name) => name.startsWith(prefix));
    assert.equal(automatic.length, 5);
    assert.equal(files.includes(old[0]!), false);
    for (const name of old.slice(1)) assert.equal(files.includes(name), true);
    assert.equal(files.includes(operator), true);
    assert.equal(files.includes("notes.txt"), true);
  } finally {
    opened.sqlite.close();
  }
});

it("refuses migration and keeps the old schema when the backup directory cannot be written", () => {
  const path = tempDb();
  createV4(path);
  const directory = join(dirname(path), "backups");
  mkdirSync(directory, { mode: 0o700 });
  chmodSync(directory, 0o500);
  assert.throws(
    () => openControlPlaneSqlite(path),
    (error: unknown) =>
      error instanceof DatabaseError && error.message === "pre-migration backup failed",
  );
  const existing = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(version(existing), 4);
    assert.equal(keyName(existing), "kept");
    assert.equal(
      existing.prepare("SELECT name FROM sqlite_master WHERE name = 'batch_jobs'").get(),
      undefined,
    );
  } finally {
    existing.close();
  }
  assert.equal(readdirSync(directory).length, 0);
  chmodSync(directory, 0o700);
});
