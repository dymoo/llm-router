import { Predicate, Schema } from "effect";
import { createDeadline } from "./deadline.ts";

const Nonnegative = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

/**
 * TypeSafe System One classification deployments: local Kev on Gufo, or cloud
 * Jev. A request names its deployment and never falls back to another one:
 * Kev and Jev give different probabilities for the same question.
 */
export const AuxiliaryDeployment = Schema.Struct({
  id: Schema.NonEmptyString,
  modality: Schema.Literals(["systemone"]),
  transport: Schema.Literals(["gufo", "typesafe"]),
  location: Schema.optional(Schema.Literals(["local", "cloud"])),
  /** Environment variable holding the upstream bearer key, if it needs one. */
  credentialEnvVar: Schema.optional(Schema.NonEmptyString),
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
    if (deployment.transport === "typesafe" && deployment.location !== "cloud")
      throw new Error("TypeSafe deployments are cloud deployments");
    if (deployment.capacity.reservedInteractiveSlots >= deployment.capacity.maxParallel)
      throw new Error("Auxiliary capacity must admit every priority");
    const capacity = JSON.stringify(deployment.capacity);
    if (resources.has(deployment.resourceId) && resources.get(deployment.resourceId) !== capacity)
      throw new Error("A shared resource must have identical capacity");
    resources.set(deployment.resourceId, capacity);
    ids.add(deployment.id);
  }
  return deployments;
}

/**
 * Readiness: the deployment's `GET <endpoint>/models` lists its model. Kev on
 * Gufo authenticates every route, so the probe sends the deployment's bearer.
 */
export async function probeAuxiliary(
  deployment: AuxiliaryDeployment,
  fetchImpl: typeof fetch = fetch,
  credential: string | undefined = deployment.credentialEnvVar === undefined
    ? undefined
    : process.env[deployment.credentialEnvVar],
): Promise<boolean> {
  const deadline = createDeadline(2_000);
  try {
    const response = await fetchImpl(`${deployment.endpoint.replace(/\/$/, "")}/models`, {
      redirect: "error",
      signal: deadline.signal,
      headers: credential ? { authorization: `Bearer ${credential}` } : {},
    });
    const body: unknown = await response.json();
    return (
      response.ok &&
      Predicate.isObject(body) &&
      Array.isArray(body.data) &&
      body.data.some((item) => Predicate.isObject(item) && item.id === deployment.modelId)
    );
  } catch {
    return false;
  } finally {
    deadline.clear();
  }
}
