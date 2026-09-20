import type { DatabaseSync } from "node:sqlite";
import { CONTROL_PLANE_SCHEMA_IDENTITY } from "../domain.ts";
import { SchemaVersionMismatch } from "../errors.ts";
import {
  CONTROL_PLANE_V1_SQL,
  CONTROL_PLANE_V2_SQL,
  CONTROL_PLANE_V3_SQL,
  CONTROL_PLANE_V4_SQL,
} from "./migrations-sql.ts";

const migrations = [
  CONTROL_PLANE_V1_SQL,
  CONTROL_PLANE_V2_SQL,
  CONTROL_PLANE_V3_SQL,
  CONTROL_PLANE_V4_SQL,
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

export function migrateControlPlane(sqlite: DatabaseSync): void {
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
