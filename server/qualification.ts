import "server-only";

import { readFileSync } from "node:fs";
import { Schema } from "effect";
import { getEnv } from "../env.ts";
import { ClassifierQualifications, type ClassifierQualification } from "../src/domain.ts";

let cached: readonly ClassifierQualification[] | undefined;

/**
 * Qualification evidence at CLASSIFIER_QUALIFICATION, process-cached after the
 * first successful load. An unset path yields no records so the gate fails
 * closed; a malformed file throws loudly at load instead of degrading to [].
 */
export function loadClassifierQualifications(): readonly ClassifierQualification[] {
  if (cached !== undefined) {
    return cached;
  }
  const path = getEnv().CLASSIFIER_QUALIFICATION;
  if (path === undefined) {
    cached = [];
    return cached;
  }
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  cached = Schema.decodeUnknownSync(ClassifierQualifications)(parsed);
  return cached;
}
