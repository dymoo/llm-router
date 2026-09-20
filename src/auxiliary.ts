import { Schema } from "effect";

const Nonnegative = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

/** Optional NPU endpoints are explicit; they never fall back to GPU or cloud. */
export const AuxiliaryDeployment = Schema.Struct({
  id: Schema.NonEmptyString,
  modality: Schema.Literals(["embeddings", "transcription"]),
  modelId: Schema.NonEmptyString,
  endpoint: Schema.NonEmptyString,
  resourceId: Schema.NonEmptyString,
  capacity: Schema.Struct({ maxParallel: PositiveInt, reservedInteractiveSlots: Nonnegative }),
  maxInputTokens: PositiveInt,
  maxBatchSize: PositiveInt,
  maxBodyBytes: PositiveInt,
  inputUsdPerMillion: Schema.NullOr(Nonnegative),
  requestUsd: Schema.NullOr(Nonnegative),
  priceVersion: Schema.NonEmptyString,
});
export type AuxiliaryDeployment = typeof AuxiliaryDeployment.Type;
export const AuxiliaryCatalogue = Schema.Array(AuxiliaryDeployment);

export function decodeAuxiliaryCatalogue(value: unknown): readonly AuxiliaryDeployment[] {
  const deployments = Schema.decodeUnknownSync(AuxiliaryCatalogue)(value);
  const ids = new Set<string>();
  const resources = new Map<string, string>();
  for (const deployment of deployments) {
    const url = new URL(deployment.endpoint);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("Invalid auxiliary endpoint");
    if (deployment.id === "auto" || ids.has(deployment.id))
      throw new Error("Duplicate auxiliary model id");
    if (deployment.capacity.reservedInteractiveSlots >= deployment.capacity.maxParallel)
      throw new Error("Auxiliary capacity must admit every priority");
    const capacity = JSON.stringify(deployment.capacity);
    if (resources.has(deployment.resourceId) && resources.get(deployment.resourceId) !== capacity)
      throw new Error("Shared NPU resource must have identical capacity");
    resources.set(deployment.resourceId, capacity);
    ids.add(deployment.id);
  }
  return deployments;
}
