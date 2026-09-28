import { backup, DatabaseSync } from "node:sqlite";
import { chmodSync, closeSync, existsSync, openSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Frozen on-disk protocol identity, shared with src/domain.ts. Versions migrate at app startup.
const IDENTITY = "dymoo-llm-router-control-plane";
const SETTING_IDENTITY = "schema_identity";
const SETTING_VERSION = "schema_version";
const MIGRATION_FILE = /^\d{4}_.*\.sql$/;

/** Current schema version from the same migrations directory src/db/migrate.ts consumes
 * (version = migration count, currently v6 with the simple key policy). Candidates cover the
 * repository layout (scripts/../migrations) and the /opt/ops container layout
 * (/opt/ops/../../app/migrations). */
function migrationsDirectory() {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, "..", "migrations"), join(here, "..", "..", "app", "migrations")];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "0001_control_plane.sql"))) return candidate;
  }
  throw new Error("Migrations directory not found; cannot verify the control-plane schema version");
}

export function currentSchemaVersion() {
  const files = readdirSync(migrationsDirectory())
    .filter((name) => MIGRATION_FILE.test(name))
    .sort();
  if (files[0] !== "0001_control_plane.sql")
    throw new Error("Migrations directory is incomplete; cannot verify the schema version");
  return files.length;
}

/** Fail closed on anything the app would refuse to open: corrupt files, foreign databases,
 * inconsistent version stamps, and schemas newer than this binary. Identified older versions
 * (v1..v5) pass through; migrateControlPlane upgrades them on the next app open. */
export function validateDatabase(path) {
  const db = new DatabaseSync(path, { readOnly: true, timeout: 1000 });
  try {
    const integrity = db.prepare("PRAGMA integrity_check").get();
    if (integrity?.integrity_check !== "ok") throw new Error("SQLite integrity check failed");
    const identity = db.prepare("SELECT value FROM settings WHERE key = ?").get(SETTING_IDENTITY);
    if (identity?.value !== IDENTITY) throw new Error("Not an llm-router control-plane database");
    const stored = db.prepare("SELECT value FROM settings WHERE key = ?").get(SETTING_VERSION);
    const version = Number(stored?.value);
    const pragma = db.prepare("PRAGMA user_version").get();
    if (!Number.isInteger(version) || version < 1)
      throw new Error("Control-plane schema version is missing or invalid");
    if (pragma?.user_version !== version)
      throw new Error(
        `Inconsistent control-plane schema version (settings ${version} vs user_version ${pragma?.user_version})`,
      );
    const current = currentSchemaVersion();
    if (version > current)
      throw new Error(
        `Database schema v${version} is newer than the supported v${current}; refusing to touch it`,
      );
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

/** Fail-closed quarantine applied ONLY to the staged copy of a restore — never to the
 * original backup and never on ordinary restart recovery. A snapshot cannot prove that
 * pending batch work was not executed after it was taken, so pending items are
 * terminalized with an explicit review-required outcome instead of silently replaying,
 * unconfirmed submit intents become ambiguous (no new POST is ever derived from them),
 * and running request rows linked to quarantined items are finalized as abandoned
 * (spend metadata preserved — deferred rows skip ordinary stale-lease recovery and
 * would otherwise run forever). Confirmed remote ids, their running items, and the
 * requests linked to those items are untouched: re-polling a proven upstream id cannot
 * duplicate spend. Pre-v5 snapshots have no batch tables and are returned unchanged.
 * Columns/statuses follow the v5 batch ledger (BatchLedger owner) and the deferred
 * request lifecycle (BatchAdmissionLifecycle owner).
 */
export function quarantineRestoredBatchState(path) {
  const summary = { items: 0, requests: 0, remotes: 0, jobs: 0 };
  const db = new DatabaseSync(path, { timeout: 1000 });
  try {
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?");
    if (table.get("batch_jobs") === undefined) return summary; // pre-v5 snapshot
    const at = Date.now();
    db.exec("BEGIN IMMEDIATE");
    try {
      // The same item predicate, evaluated before the item updates below: finalize every
      // running request row linked to an item about to be quarantined, plus items the
      // boot sweep already interrupted (their linked request_id survives, and a deferred
      // binding on an interrupted item has no other finalization path). deferred=1 rows
      // are excluded from ordinary stale-lease recovery and would otherwise stay running
      // forever; spend metadata columns are deliberately untouched. Requests linked to
      // confirmed-remote surviving items keep running for the re-poll.
      summary.requests = db
        .prepare(
          `UPDATE requests
              SET status = 'abandoned', error_code = 'restore_review_required', finished_at = ?
            WHERE status = 'running'
              AND id IN (
                SELECT request_id FROM batch_items
                 WHERE request_id IS NOT NULL
                   AND (status = 'queued'
                        OR status = 'interrupted'
                        OR (status = 'running' AND (remote_id IS NULL OR remote_id NOT IN
                              (SELECT id FROM batch_remotes WHERE intent = 'confirmed')))))`,
        )
        .run(at).changes;
      // Queued and locally-running work may already have executed after the snapshot.
      summary.items = db
        .prepare(
          `UPDATE batch_items
             SET status = 'interrupted', error_code = 'restore_review_required', finished_at = ?
           WHERE status = 'queued'
              OR (status = 'running' AND (remote_id IS NULL OR remote_id NOT IN
                    (SELECT id FROM batch_remotes WHERE intent = 'confirmed')))`,
        )
        .run(at).changes;
      // A snapshot-time intent may already have POSTed: ambiguous, never re-posted.
      summary.remotes = db
        .prepare("UPDATE batch_remotes SET intent = 'unknown' WHERE intent = 'intended'")
        .run().changes;
      // Jobs owning a pending confirmed remote MUST stay nonterminal: pollKnown's
      // completion lands after the restore and the ledger refuses terminal-job writes.
      const pendingRemote = `NOT EXISTS (
        SELECT 1 FROM batch_remotes r
        WHERE r.job_id = batch_jobs.id AND r.intent = 'confirmed' AND r.harvested_at IS NULL)`;
      summary.jobs += db
        .prepare(
          `UPDATE batch_jobs
              SET status = 'failed', error_code = 'restore_review_required', finalized_at = ?
            WHERE status IN ('validating', 'queued', 'in_progress', 'finalizing')
              AND ${pendingRemote}`,
        )
        .run(at).changes;
      // Cancelling closes only when no running items remain (mirrors closeCancelling;
      // running survivors after item quarantine belong to confirmed remotes).
      summary.jobs += db
        .prepare(
          `UPDATE batch_jobs
              SET status = 'cancelled', error_code = 'restore_review_required', finalized_at = ?
            WHERE status = 'cancelling'
              AND ${pendingRemote}
              AND NOT EXISTS (
                SELECT 1 FROM batch_items i WHERE i.job_id = batch_jobs.id AND i.status = 'running')`,
        )
        .run(at).changes;
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    // Leave a self-contained journal-mode snapshot behind: the restore rename must not
    // orphan a WAL sidecar, and the app re-enters WAL mode on its next open.
    db.exec("PRAGMA journal_mode = DELETE");
    return summary;
  } finally {
    db.close();
  }
}
