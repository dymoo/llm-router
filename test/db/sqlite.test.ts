import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import { Effect, Layer, ManagedRuntime } from "effect";
import { CONTROL_PLANE_SCHEMA_IDENTITY } from "../../src/domain.ts";
import { DatabaseError, SchemaVersionMismatch } from "../../src/errors.ts";
import { generateControlPlaneSql } from "../../src/db/sql.ts";
import {
  openControlPlaneSqlite,
  sqliteDatabaseLayer,
  SqliteDatabase,
} from "../../src/db/sqlite.ts";
import { CONTROL_PLANE_V1_SQL } from "../../src/db/migrations-sql.ts";
import { CONTROL_PLANE_SCHEMA_VERSION } from "../../src/db/migrate.ts";

const dirs: string[] = [];

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "llm-router-db-"));
  dirs.push(dir);
  return join(dir, "control.sqlite");
}

after(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("SqliteDatabase", () => {
  it("creates an identified STRICT control-plane schema", async () => {
    const path = tempDb();
    const runtime = ManagedRuntime.make(sqliteDatabaseLayer(path));
    await runtime.runPromise(
      Effect.gen(function* () {
        const db = yield* SqliteDatabase;
        const identity = db.sqlite
          .prepare("SELECT value FROM settings WHERE key = 'schema_identity'")
          .get() as {
          value: string;
        };
        assert.equal(identity.value, CONTROL_PLANE_SCHEMA_IDENTITY);
        const version = db.sqlite.prepare("PRAGMA user_version").get() as { user_version: number };
        assert.equal(version.user_version, CONTROL_PLANE_SCHEMA_VERSION);
        const table = db.sqlite
          .prepare("SELECT sql FROM sqlite_master WHERE name = 'api_keys'")
          .get() as {
          sql: string;
        };
        assert.match(table.sql, /STRICT/);
        const columns = db.sqlite.prepare("PRAGMA table_info(requests)").all() as Array<{
          name: string;
        }>;
        const names = columns.map((column) => column.name);
        assert.equal(names.includes("locality_bias"), true);
        assert.equal(names.includes("selection_reason_detail"), true);
      }),
    );
    await runtime.dispose();
  });

  it("rejects a newer user_version", async () => {
    const path = tempDb();
    const first = ManagedRuntime.make(sqliteDatabaseLayer(path));
    await first.runPromise(Effect.void);
    await first.dispose();
    const sqlite = new DatabaseSync(path);
    sqlite.exec("PRAGMA user_version = 99");
    sqlite.close();
    const second = ManagedRuntime.make(sqliteDatabaseLayer(path));
    await assert.rejects(
      () => second.runPromise(Effect.void),
      (error: unknown) => error instanceof SchemaVersionMismatch,
    );
    await second.dispose();
  });

  it("rejects an unknown database without control-plane identity", async () => {
    const path = tempDb();
    const sqlite = new DatabaseSync(path);
    sqlite.exec("PRAGMA user_version = 1");
    sqlite.exec("CREATE TABLE leftover (id TEXT PRIMARY KEY) STRICT");
    sqlite.close();
    const runtime = ManagedRuntime.make(sqliteDatabaseLayer(path));
    await assert.rejects(
      () => runtime.runPromise(Effect.void),
      (error: unknown) => error instanceof SchemaVersionMismatch,
    );
    await runtime.dispose();
  });

  it("closes the connection when the layer scope is released", async () => {
    const path = tempDb();
    const runtime = ManagedRuntime.make(sqliteDatabaseLayer(path));
    const sqlite = await runtime.runPromise(SqliteDatabase.useSync((db) => db.sqlite));
    await runtime.dispose();
    assert.throws(() => sqlite.prepare("SELECT 1").get());
  });

  it("maps failed-init driver errors to DatabaseError without SQL text", async () => {
    const runtime = ManagedRuntime.make(sqliteDatabaseLayer("/no/such/dir/control.sqlite"));
    try {
      await runtime.runPromise(Effect.void);
      assert.fail("expected open to fail");
    } catch (error) {
      assert.equal(error instanceof DatabaseError || error instanceof SchemaVersionMismatch, true);
      if (error instanceof DatabaseError) {
        assert.equal(error.message, "persistence failure");
      }
    } finally {
      await runtime.dispose();
    }
  });

  it("emits STRICT DDL from the ORM schema", () => {
    const sql = generateControlPlaneSql();
    assert.match(sql, /CREATE TABLE "settings"/);
    assert.match(sql, /\) STRICT;/);
    assert.doesNotMatch(sql, /admin_sessions/);
    assert.doesNotMatch(sql, /login_buckets/);
  });

  it("upgrades a v1 database and keeps existing keys", async () => {
    const path = tempDb();
    const sqlite = new DatabaseSync(path);
    sqlite.exec(CONTROL_PLANE_V1_SQL);
    sqlite.exec("PRAGMA user_version = 1");
    sqlite
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?)")
      .run("schema_identity", CONTROL_PLANE_SCHEMA_IDENTITY);
    sqlite.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("schema_version", "1");
    sqlite
      .prepare(
        "INSERT INTO api_keys (id, prefix, digest, name, policy_json, created_at, expires_at, revoked_at, last_used_at, version) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 1)",
      )
      .run(
        "upgrade-key",
        "jrv_aaaaaaaaaaaaaaaaaaaaaaaa",
        "ab".repeat(32),
        "kept",
        JSON.stringify({
          priority: "low",
          localityBias: 1,
          contextLimitTokens: 1024,
          maxCompletionTokens: 256,
          allowedModels: null,
          requestsPerMinute: 1,
          maxConcurrent: 1,
          maxWaitMs: 0,
          maxEstimatedUsd: null,
          bias: { cost: 1, quality: 0.3, latency: 0.05 },
        }),
        1,
      );
    sqlite.close();
    const runtime = ManagedRuntime.make(sqliteDatabaseLayer(path));
    await runtime.runPromise(
      Effect.gen(function* () {
        const db = yield* SqliteDatabase;
        const version = db.sqlite.prepare("PRAGMA user_version").get() as { user_version: number };
        assert.equal(version.user_version, CONTROL_PLANE_SCHEMA_VERSION);
        const key = db.sqlite
          .prepare("SELECT id, name FROM api_keys WHERE id = ?")
          .get("upgrade-key") as {
          id: string;
          name: string;
        };
        assert.equal(key.name, "kept");
        const columns = db.sqlite.prepare("PRAGMA table_info(requests)").all() as Array<{
          name: string;
        }>;
        assert.equal(
          columns.some((column) => column.name === "locality_bias"),
          true,
        );
      }),
    );
    await runtime.dispose();
  });
});

it("keeps database files private without changing an existing parent directory", () => {
  const path = tempDb();
  chmodSync(dirname(path), 0o755);
  const opened = openControlPlaneSqlite(path);
  try {
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(path)).mode & 0o777, 0o755);
  } finally {
    opened.sqlite.close();
  }
});
