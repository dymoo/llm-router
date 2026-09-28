import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../../migrations");

export const CONTROL_PLANE_V1_SQL = readFileSync(
  join(migrationsDir, "0001_control_plane.sql"),
  "utf8",
);
export const CONTROL_PLANE_V2_SQL = readFileSync(
  join(migrationsDir, "0002_add_request_analytics_columns.sql"),
  "utf8",
);
export const CONTROL_PLANE_V3_SQL = readFileSync(
  join(migrationsDir, "0003_add_cost_source.sql"),
  "utf8",
);
export const CONTROL_PLANE_V4_SQL = readFileSync(
  join(migrationsDir, "0004_add_decision_trace.sql"),
  "utf8",
);
export const CONTROL_PLANE_V5_SQL = readFileSync(
  join(migrationsDir, "0005_batch_ledger.sql"),
  "utf8",
);
export const CONTROL_PLANE_V6_SQL = readFileSync(
  join(migrationsDir, "0006_add_app_attribution.sql"),
  "utf8",
);
export const CONTROL_PLANE_V7_SQL = readFileSync(
  join(migrationsDir, "0007_simple_key_policy.sql"),
  "utf8",
);
