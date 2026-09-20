import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { drizzle, type NodeSQLiteDatabase } from "drizzle-orm/node-sqlite";
import { Context, Effect, Layer } from "effect";
import { DatabaseError, SchemaVersionMismatch } from "../errors.ts";
import { migrateControlPlane } from "./migrate.ts";

export type ControlPlaneDb = NodeSQLiteDatabase;
export type ControlPlaneSession = Pick<
  NodeSQLiteDatabase,
  "select" | "insert" | "update" | "delete"
>;

export class SqliteDatabase extends Context.Service<
  SqliteDatabase,
  {
    readonly path: string;
    readonly sqlite: DatabaseSync;
    readonly db: ControlPlaneDb;
  }
>()("dymoo/llm-router/db/SqliteDatabase") {}

function isMemoryPath(databasePath: string): boolean {
  return (
    databasePath === "" || databasePath === ":memory:" || databasePath.startsWith("file:memory:")
  );
}
function persistenceFailure(): DatabaseError {
  return new DatabaseError({ message: "persistence failure" });
}

function mapOpenError(cause: unknown): DatabaseError | SchemaVersionMismatch {
  if (cause instanceof SchemaVersionMismatch) {
    return cause;
  }
  if (cause instanceof DatabaseError) {
    return cause;
  }
  return persistenceFailure();
}

function applyPrivatePermissions(databasePath: string): void {
  if (isMemoryPath(databasePath)) {
    return;
  }
  const directory = dirname(databasePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    closeSync(openSync(databasePath, "wx", 0o600));
  } catch (error) {
    if (
      !(error !== null && typeof error === "object" && "code" in error && error.code === "EEXIST")
    )
      throw error;
  }
  chmodSync(databasePath, 0o600);
}

export function openControlPlaneSqlite(databasePath: string): SqliteDatabase["Service"] {
  applyPrivatePermissions(databasePath);
  const sqlite = new DatabaseSync(databasePath);
  try {
    sqlite.exec("PRAGMA journal_mode = WAL");
    sqlite.exec("PRAGMA synchronous = FULL");
    sqlite.exec("PRAGMA foreign_keys = ON");
    sqlite.exec("PRAGMA busy_timeout = 1000");
    migrateControlPlane(sqlite);
    const db = drizzle({ client: sqlite });
    return { path: databasePath, sqlite, db };
  } catch (cause) {
    try {
      sqlite.close();
    } catch {
      // ignore close failure after a failed open
    }
    throw cause;
  }
}

export const sqliteDatabaseLayer = (
  databasePath: string,
): Layer.Layer<SqliteDatabase, DatabaseError | SchemaVersionMismatch> =>
  Layer.effect(
    SqliteDatabase,
    Effect.acquireRelease(
      Effect.try({
        try: () => openControlPlaneSqlite(databasePath),
        catch: mapOpenError,
      }),
      (opened) =>
        Effect.sync(() => {
          try {
            opened.sqlite.close();
          } catch {
            // already closed
          }
        }),
    ),
  );
