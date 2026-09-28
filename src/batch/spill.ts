/** Spill rule: when a batch job's undispatched items become eligible for the pinned
 * OpenRouter batch path. Pure — no clock, no I/O. Corrected formula (Main + BatchDocs):
 * spillAt = createdAt + clamp(24h × localityBias, 5min, 23h55m).
 * localityBias=1 (local-until-saturated) spills late; localityBias=0 (cloud-preferred)
 * spills early at the 5-minute floor. */

export const SPILL_WINDOW_MS = 24 * 60 * 60 * 1000;
export const SPILL_MIN_DELAY_MS = 5 * 60 * 1000;
export const SPILL_MAX_DELAY_MS = SPILL_WINDOW_MS - SPILL_MIN_DELAY_MS; // 23h55m

const clamp01 = (localityBias: number): number =>
  Number.isFinite(localityBias) ? Math.min(1, Math.max(0, localityBias)) : 0;

/** Delay from createdAt until spill eligibility: clamp(24h × bias, 5min, 23h55m).
 * Rounded before clamping: `24h × bias` is fractional for most real biases (0.65 →
 * 56159999.99999999) and spillAt must be an integer epoch-ms (ledger rejects otherwise). */
export const spillDelayMs = (localityBias: number): number => {
  const raw = Math.round(SPILL_WINDOW_MS * clamp01(localityBias));
  return Math.min(SPILL_MAX_DELAY_MS, Math.max(SPILL_MIN_DELAY_MS, raw));
};

/** Absolute spill timestamp for a job created at `createdAt` under `localityBias`. */
export const spillAtFor = (createdAt: number, localityBias: number): number =>
  createdAt + spillDelayMs(localityBias);

/** At/after spillAt undispatched items may route to the pinned OpenRouter batch path. */
export const hasSpilled = (spillAt: number, now: number): boolean => now >= spillAt;
