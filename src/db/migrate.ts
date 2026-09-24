import type { DatabaseSync } from "node:sqlite";
import { DatabaseSync as SqliteDatabaseSync } from "node:sqlite";
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { CONTROL_PLANE_SCHEMA_IDENTITY } from "../domain.ts";
import { DatabaseError, SchemaVersionMismatch } from "../errors.ts";
import {
  CONTROL_PLANE_V1_SQL,
  CONTROL_PLANE_V2_SQL,
  CONTROL_PLANE_V3_SQL,
  CONTROL_PLANE_V4_SQL,
  CONTROL_PLANE_V5_SQL,
} from "./migrations-sql.ts";

const migrations = [
  CONTROL_PLANE_V1_SQL,
  CONTROL_PLANE_V2_SQL,
  CONTROL_PLANE_V3_SQL,
  CONTROL_PLANE_V4_SQL,
  CONTROL_PLANE_V5_SQL,
];
export const CONTROL_PLANE_SCHEMA_VERSION = migrations.length;
export const SQLITE_USER_VERSION = CONTROL_PLANE_SCHEMA_VERSION;

const SETTING_IDENTITY = "schema_identity";
const SETTING_VERSION = "schema_version";

type UserVersionRow = { user_version: number };
type MasterRow = { name: string };
type SettingRow = { value: string };

function readUserVersion(sqlite: DatabaseSync): number {
  const row = sqlite.prepare("PRAGMA user_version").get() as UserVersionRow | undefined;
  return row?.user_version ?? 0;
}

function applicationTables(sqlite: DatabaseSync): string[] {
  const rows = sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as MasterRow[];
  return rows.map((row) => row.name);
}

function readSetting(sqlite: DatabaseSync, key: string): string | undefined {
  const row = sqlite.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | SettingRow
    | undefined;
  return row?.value;
}

function writeIdentity(sqlite: DatabaseSync, schemaVersion: number): void {
  sqlite
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?)")
    .run(SETTING_IDENTITY, CONTROL_PLANE_SCHEMA_IDENTITY);
  sqlite
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?)")
    .run(SETTING_VERSION, String(schemaVersion));
}

function setSchemaVersion(sqlite: DatabaseSync, schemaVersion: number): void {
  sqlite
    .prepare("UPDATE settings SET value = ? WHERE key = ?")
    .run(String(schemaVersion), SETTING_VERSION);
  sqlite.exec(`PRAGMA user_version = ${schemaVersion}`);
}

function requireIdentity(sqlite: DatabaseSync): void {
  const tables = applicationTables(sqlite);
  if (!tables.includes("settings")) {
    throw new SchemaVersionMismatch({
      message: "unknown database is missing control-plane identity",
    });
  }
  const identity = readSetting(sqlite, SETTING_IDENTITY);
  if (identity !== CONTROL_PLANE_SCHEMA_IDENTITY) {
    throw new SchemaVersionMismatch({
      message: "unknown database is missing control-plane identity",
    });
  }
}

function backupBeforeMigration(sqlite: DatabaseSync, databasePath: string, version: number): void {
  // Runtime database paths: exclude them from build-time file tracing so live data is never packaged.
  const directory = join(/* turbopackIgnore: true */ dirname(databasePath), "backups");
  const prefix = `control-pre-v${SQLITE_USER_VERSION}-`;
  let destination: string | undefined;
  let created = false;
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (cause) {
    if (
      !(cause !== null && typeof cause === "object" && "code" in cause && cause.code === "EEXIST")
    ) {
      throw new DatabaseError({ message: "pre-migration backup failed" });
    }
  }
  try {
    const state = lstatSync(directory);
    if (!state.isDirectory() || (state.mode & 0o200) === 0) {
      throw new Error("backup directory is not writable");
    }
    chmodSync(directory, 0o700);
    destination = join(
      /* turbopackIgnore: true */ directory,
      `${prefix}${new Date().toISOString().replaceAll(":", "-")}.sqlite`,
    );
    const descriptor = openSync(/* turbopackIgnore: true */ destination, "wx", 0o600);
    created = true;
    closeSync(descriptor);
    sqlite.prepare("VACUUM INTO ?").run(destination);
    chmodSync(destination, 0o600);

    const backup = new SqliteDatabaseSync(destination, { readOnly: true });
    try {
      const integrity = backup.prepare("PRAGMA integrity_check").get() as
        | { integrity_check: string }
        | undefined;
      if (integrity?.integrity_check !== "ok") throw new Error("backup failed integrity check");
      requireIdentity(backup);
      if (
        readUserVersion(backup) !== version ||
        Number(readSetting(backup, SETTING_VERSION)) !== version
      ) {
        throw new Error("backup schema version differs from source");
      }
    } finally {
      backup.close();
    }

    const snapshots = readdirSync(/* turbopackIgnore: true */ directory)
      .filter(
        (name) =>
          name.startsWith(prefix) &&
          name.endsWith(".sqlite") &&
          lstatSync(join(/* turbopackIgnore: true */ directory, name)).isFile(),
      )
      .sort();
    for (const old of snapshots.slice(0, -5))
      unlinkSync(join(/* turbopackIgnore: true */ directory, old));
  } catch {
    if (created && destination !== undefined) {
      try {
        unlinkSync(destination);
      } catch {
        // Preserve the backup failure if cleanup also fails.
      }
    }
    throw new DatabaseError({ message: "pre-migration backup failed" });
  }
}

export function migrateControlPlane(sqlite: DatabaseSync): void {
  const priorVersion = readUserVersion(sqlite);
  let backedUpVersion: number | undefined;
  if (priorVersion >= 1 && priorVersion < SQLITE_USER_VERSION) {
    requireIdentity(sqlite);
    if (Number(readSetting(sqlite, SETTING_VERSION)) !== priorVersion) {
      throw new SchemaVersionMismatch({ message: "inconsistent control-plane schema version" });
    }
    const databasePath = sqlite.location();
    if (databasePath !== null) {
      backupBeforeMigration(sqlite, databasePath, priorVersion);
      backedUpVersion = priorVersion;
    }
  }
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    const version = readUserVersion(sqlite);
    if (version > SQLITE_USER_VERSION) {
      throw new SchemaVersionMismatch({ message: "database schema is newer than this binary" });
    }
    if (version === 0) {
      if (applicationTables(sqlite).length > 0) {
        throw new SchemaVersionMismatch({
          message: "unknown database is missing control-plane identity",
        });
      }
    } else {
      requireIdentity(sqlite);
      if (Number(readSetting(sqlite, SETTING_VERSION)) !== version) {
        throw new SchemaVersionMismatch({ message: "inconsistent control-plane schema version" });
      }
    }
    if (backedUpVersion !== undefined && version !== backedUpVersion) {
      throw new SchemaVersionMismatch({
        message: "control-plane schema changed during pre-migration backup",
      });
    }
    for (const [index, migration] of migrations.entries()) {
      if (index < version) continue;
      sqlite.exec(migration);
      if (index === 0) writeIdentity(sqlite, 1);
      setSchemaVersion(sqlite, index + 1);
    }
    sqlite.exec("COMMIT");
  } catch (cause) {
    sqlite.exec("ROLLBACK");
    throw cause;
  }
}
