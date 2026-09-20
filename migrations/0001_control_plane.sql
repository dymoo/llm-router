-- Frozen v1 from live control-plane schema. Do not mutate.
-- Schema identity: dymoo-llm-router-control-plane version 1.

CREATE TABLE "settings" (
  "key" text PRIMARY KEY,
  "value" text NOT NULL
) STRICT;

CREATE TABLE "api_keys" (
  "id" text PRIMARY KEY,
  "prefix" text NOT NULL,
  "digest" text NOT NULL,
  "name" text NOT NULL,
  "policy_json" text NOT NULL,
  "created_at" integer NOT NULL,
  "expires_at" integer,
  "revoked_at" integer,
  "last_used_at" integer,
  "version" integer NOT NULL,
  CONSTRAINT "api_keys_version_positive" CHECK ("api_keys"."version" >= 1),
  CONSTRAINT "api_keys_expires_at_positive" CHECK ("api_keys"."expires_at" IS NULL OR "api_keys"."expires_at" >= 0),
  CONSTRAINT "api_keys_revoked_at_positive" CHECK ("api_keys"."revoked_at" IS NULL OR "api_keys"."revoked_at" >= 0)
) STRICT;

CREATE UNIQUE INDEX "api_keys_prefix_uq" ON "api_keys" ("prefix");

CREATE UNIQUE INDEX "api_keys_digest_uq" ON "api_keys" ("digest");

CREATE INDEX "api_keys_created_id_idx" ON "api_keys" ("created_at", "id");

CREATE TABLE "requests" (
  "id" text PRIMARY KEY,
  "key_id" text NOT NULL,
  "started_at" integer NOT NULL,
  "lease_expires_at" integer NOT NULL,
  "finished_at" integer,
  "status" text NOT NULL,
  "deployment_id" text,
  "prompt_tokens" integer,
  "completion_tokens" integer,
  "classifier_backend" text,
  "classifier_model_revision" text,
  "classifier_source" text,
  "classifier_input_tokens" integer,
  "classifier_elapsed_ms" integer,
  "classifier_reuse" text,
  "reasoning_tokens" integer,
  "cached_input_tokens" integer,
  "ttft_ms" integer,
  "generation_elapsed_ms" integer,
  "provider_reported_usd" real,
  "estimated_cost_usd" real,
  "estimated_cache_savings_usd" real,
  "local_compute_estimated_usd" real,
  "price_version" text,
  "trajectory_hash" text,
  "error_code" text,
  "priority" text,
  "location" text,
  "queue_wait_ms" integer,
  "decision_reason" text,
  "exclusion_json" text,
  "task_kind" text,
  "difficulty" text,
  "requested_effort" text,
  "decode_tps" real,
  "cache_observation" text,
  FOREIGN KEY ("key_id") REFERENCES "api_keys" ("id"),
  CONSTRAINT "requests_status_known" CHECK ("requests"."status" IN ('running', 'success', 'error', 'abandoned')),
  CONSTRAINT "requests_classifier_source_known" CHECK ("requests"."classifier_source" IS NULL OR "requests"."classifier_source" IN ('full-input', 'caller-brief')),
  CONSTRAINT "requests_classifier_reuse_known" CHECK ("requests"."classifier_reuse" IS NULL OR "requests"."classifier_reuse" IN ('classified', 'exact-cache', 'session')),
  CONSTRAINT "requests_location_known" CHECK ("requests"."location" IS NULL OR "requests"."location" IN ('local', 'cloud')),
  CONSTRAINT "requests_cache_observation_known" CHECK ("requests"."cache_observation" IS NULL OR "requests"."cache_observation" IN ('observed-hit', 'observed-miss', 'unknown'))
) STRICT;

CREATE INDEX "requests_key_status_idx" ON "requests" ("key_id", "status");

CREATE INDEX "requests_status_lease_idx" ON "requests" ("status", "lease_expires_at");

CREATE INDEX "requests_started_idx" ON "requests" ("started_at");

CREATE INDEX "requests_key_started_idx" ON "requests" ("key_id", "started_at");

CREATE INDEX "requests_deployment_started_idx" ON "requests" ("deployment_id", "started_at");

CREATE INDEX "requests_priority_started_idx" ON "requests" ("priority", "started_at");

CREATE INDEX "requests_location_started_idx" ON "requests" ("location", "started_at");

CREATE TABLE "rate_limits" (
  "key_id" text NOT NULL,
  "minute" integer NOT NULL,
  "count" integer NOT NULL,
  PRIMARY KEY ("key_id", "minute"),
  FOREIGN KEY ("key_id") REFERENCES "api_keys" ("id"),
  CONSTRAINT "rate_limits_count_nonneg" CHECK ("rate_limits"."count" >= 0)
) STRICT;

CREATE TABLE "audit_log" (
  "id" text PRIMARY KEY,
  "at" integer NOT NULL,
  "action" text NOT NULL,
  "key_id" text,
  FOREIGN KEY ("key_id") REFERENCES "api_keys" ("id")
) STRICT;

CREATE INDEX "audit_log_at_idx" ON "audit_log" ("at");

CREATE INDEX "audit_log_key_idx" ON "audit_log" ("key_id");
