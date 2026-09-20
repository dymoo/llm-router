import { backup, DatabaseSync } from "node:sqlite";
import { chmodSync, closeSync, openSync, unlinkSync } from "node:fs";

// Frozen on-disk protocol identity, shared with src/domain.ts. Versions migrate at app startup.
const IDENTITY = "dymoo-llm-router-control-plane";

export function validateDatabase(path) {
  const db = new DatabaseSync(path, { readOnly: true, timeout: 1000 });
  try {
    const integrity = db.prepare("PRAGMA integrity_check").get();
    if (integrity?.integrity_check !== "ok") throw new Error("SQLite integrity check failed");
    const identity = db.prepare("SELECT value FROM settings WHERE key = 'schema_identity'").get();
    if (identity?.value !== IDENTITY) throw new Error("Not an llm-router control-plane database");
  } finally {
    db.close();
  }
}

/** Exclusive destination creation prevents accidental overwrite and keeps snapshots private. */
export async function snapshotDatabase(source, destination) {
  const db = new DatabaseSync(source, { readOnly: true, timeout: 1000 });
  let created = false;
  try {
    closeSync(openSync(destination, "wx", 0o600));
    created = true;
    await backup(db, destination);
    chmodSync(destination, 0o600);
    validateDatabase(destination);
  } catch (error) {
    if (created) unlinkSync(destination);
    throw error;
  } finally {
    db.close();
  }
}

export function checkpointOffline(path) {
  const db = new DatabaseSync(path, { timeout: 1000 });
  try {
    const result = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    if (result?.busy !== 0)
      throw new Error("Database is still busy; stop every gateway before restore");
  } finally {
    db.close();
  }
}
