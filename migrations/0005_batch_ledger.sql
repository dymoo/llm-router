-- Batch ledger: metadata-only job/item/remote-intent tables for low-priority async batch
-- processing. Never stores prompts, completions, reasoning text or raw keys.
-- Request bodies live in the dedicated store's input files (data/batch-results);
-- result rows live beside them, outside this database.
-- Schema identity: dymoo-llm-router-control-plane version 5.

CREATE TABLE "batch_jobs" (
  "id" text PRIMARY KEY,
  "key_id" text NOT NULL,
  "model" text NOT NULL,
  "status" text NOT NULL,
  "completion_window_ms" integer NOT NULL,
  "created_at" integer NOT NULL,
  "finalized_at" integer,
  "spill_at" integer NOT NULL,
  "usage_json" text,
  "request_counts_total" integer NOT NULL,
  "request_counts_completed" integer NOT NULL,
  "request_counts_failed" integer NOT NULL,
  "error_code" text,
  FOREIGN KEY ("key_id") REFERENCES "api_keys" ("id"),
  CONSTRAINT "batch_jobs_status_known" CHECK ("batch_jobs"."status" IN ('validating', 'queued', 'in_progress', 'finalizing', 'completed', 'failed', 'expired', 'cancelling', 'cancelled')),
  CONSTRAINT "batch_jobs_completion_window_positive" CHECK ("batch_jobs"."completion_window_ms" >= 1),
  CONSTRAINT "batch_jobs_created_at_nonneg" CHECK ("batch_jobs"."created_at" >= 0),
  CONSTRAINT "batch_jobs_spill_at_nonneg" CHECK ("batch_jobs"."spill_at" >= 0),
  CONSTRAINT "batch_jobs_finalized_at_nonneg" CHECK ("batch_jobs"."finalized_at" IS NULL OR "batch_jobs"."finalized_at" >= 0),
  CONSTRAINT "batch_jobs_counts_nonneg" CHECK ("batch_jobs"."request_counts_total" >= 0 AND "batch_jobs"."request_counts_completed" >= 0 AND "batch_jobs"."request_counts_failed" >= 0),
  CONSTRAINT "batch_jobs_counts_bounded" CHECK ("batch_jobs"."request_counts_completed" + "batch_jobs"."request_counts_failed" <= "batch_jobs"."request_counts_total")
) STRICT;

CREATE INDEX "batch_jobs_key_created_idx" ON "batch_jobs" ("key_id", "created_at");

CREATE INDEX "batch_jobs_status_created_idx" ON "batch_jobs" ("status", "created_at");

CREATE TABLE "batch_remotes" (
  "id" text PRIMARY KEY,
  "job_id" text NOT NULL,
  "group_key" text NOT NULL,
  "intent" text NOT NULL,
  "submit_token" text NOT NULL,
  "remote_batch_id" text,
  "usage_json" text,
  "harvested_at" integer,
  "created_at" integer NOT NULL,
  "confirmed_at" integer,
  FOREIGN KEY ("job_id") REFERENCES "batch_jobs" ("id"),
  CONSTRAINT "batch_remotes_intent_known" CHECK ("batch_remotes"."intent" IN ('intended', 'confirmed', 'unknown', 'abandoned')),
  CONSTRAINT "batch_remotes_created_at_nonneg" CHECK ("batch_remotes"."created_at" >= 0),
  CONSTRAINT "batch_remotes_confirmed_at_nonneg" CHECK ("batch_remotes"."confirmed_at" IS NULL OR "batch_remotes"."confirmed_at" >= 0),
  CONSTRAINT "batch_remotes_confirmed_needs_id" CHECK ("batch_remotes"."intent" <> 'confirmed' OR "batch_remotes"."remote_batch_id" IS NOT NULL),
  CONSTRAINT "batch_remotes_unconfirmed_has_no_id" CHECK ("batch_remotes"."intent" = 'confirmed' OR "batch_remotes"."remote_batch_id" IS NULL),
  CONSTRAINT "batch_remotes_harvested_at_nonneg" CHECK ("batch_remotes"."harvested_at" IS NULL OR "batch_remotes"."harvested_at" >= 0)
) STRICT;

CREATE UNIQUE INDEX "batch_remotes_token_uq" ON "batch_remotes" ("submit_token");

CREATE UNIQUE INDEX "batch_remotes_remote_id_uq" ON "batch_remotes" ("remote_batch_id");

CREATE INDEX "batch_remotes_job_idx" ON "batch_remotes" ("job_id");

CREATE TABLE "batch_items" (
  "id" text PRIMARY KEY,
  "job_id" text NOT NULL,
  "custom_id" text NOT NULL,
  "status" text NOT NULL,
  "request_id" text,
  "deployment_id" text,
  "error_code" text,
  "created_at" integer NOT NULL,
  "dispatched_at" integer,
  "finished_at" integer,
  "remote_id" text,
  FOREIGN KEY ("job_id") REFERENCES "batch_jobs" ("id"),
  FOREIGN KEY ("remote_id") REFERENCES "batch_remotes" ("id"),
  CONSTRAINT "batch_items_status_known" CHECK ("batch_items"."status" IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'expired', 'interrupted')),
  CONSTRAINT "batch_items_created_at_nonneg" CHECK ("batch_items"."created_at" >= 0),
  CONSTRAINT "batch_items_dispatched_at_nonneg" CHECK ("batch_items"."dispatched_at" IS NULL OR "batch_items"."dispatched_at" >= 0),
  CONSTRAINT "batch_items_finished_at_nonneg" CHECK ("batch_items"."finished_at" IS NULL OR "batch_items"."finished_at" >= 0)
) STRICT;

-- Durable correlation identity: custom_id is valid/nonempty/bounded/unique across ALL items
-- of a job (invalid or duplicate identity rejects the whole submit before create).
CREATE UNIQUE INDEX "batch_items_job_custom_uq" ON "batch_items" ("job_id", "custom_id");

CREATE INDEX "batch_items_job_status_idx" ON "batch_items" ("job_id", "status");

CREATE INDEX "batch_items_status_created_idx" ON "batch_items" ("status", "created_at");

-- Remote accounting: requests authorized before a remote POST are marked deferred=1 so they
-- never hold ordinary HTTP leases/concurrency; finalization reuses the same recorded request.
-- Existing rows take the DEFAULT 0 (no table rebuild).
ALTER TABLE `requests` ADD `deferred` integer NOT NULL DEFAULT 0 CONSTRAINT `requests_deferred_bool` CHECK (`deferred` IN (0, 1));
