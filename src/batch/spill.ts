/** Spill rule: when a batch job's undispatched items may leave for the pinned OpenRouter
 * batch path. Only a key with `cloud: true` spills, after local has had the first hour;
 * any other job stays local until it expires. Pure: no clock, no I/O. */

export const SPILL_WINDOW_MS = 24 * 60 * 60 * 1000;
/** ponytail: one local-first hour for every cloud key; a per-key knob only if asked for. */
export const CLOUD_SPILL_DELAY_MS = 60 * 60 * 1000;

/** A cloud job spills after CLOUD_SPILL_DELAY_MS. A local-only job never spills, so its
 * spillAt is its creation time and its expiry (spillAt + window) ends its 24h window. */
export const spillAtFor = (createdAt: number, cloud: boolean): number =>
  cloud ? createdAt + CLOUD_SPILL_DELAY_MS : createdAt;

/** At/after spillAt a cloud job's undispatched items may route to the OpenRouter batch path. */
export const hasSpilled = (
  job: { readonly cloud: boolean; readonly spillAt: number },
  now: number,
) => job.cloud && now >= job.spillAt;
