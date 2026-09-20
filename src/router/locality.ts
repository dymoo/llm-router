import {
  LOCALITY_CLOUD_FIRST_MAX,
  LOCALITY_COMPLEXITY_CLOUD_MAX,
  LOCALITY_SATURATION_MIN,
  LOCAL_SUFFICIENCY_THRESHOLD,
  type Assessment,
  type KeyPolicy,
  type SessionBoundary,
} from "../domain.ts";

export interface SaturationEvidence {
  readonly verified: boolean;
  readonly saturated: boolean;
}

export const UNKNOWN_SATURATION: SaturationEvidence = { verified: false, saturated: false };

export function preferredLocationFromBias(bias: number): "local" | "cloud" {
  return bias >= 0.5 ? "local" : "cloud";
}

export function cloudSpillPermitted(
  policy: KeyPolicy,
  assessment: Assessment,
  saturation: SaturationEvidence,
  boundary: SessionBoundary,
): boolean {
  if (boundary === "continue") {
    return false;
  }
  const bias = policy.localityBias;
  if (bias <= LOCALITY_CLOUD_FIRST_MAX) {
    return true;
  }
  const complex =
    assessment.difficulty.value === "hard" ||
    assessment.localSufficiency < LOCAL_SUFFICIENCY_THRESHOLD;
  if (bias >= LOCALITY_SATURATION_MIN) {
    return saturation.verified && saturation.saturated;
  }
  if (bias < LOCALITY_COMPLEXITY_CLOUD_MAX) {
    return true;
  }
  return complex || (saturation.verified && saturation.saturated);
}
