import { Predicate, Schema } from "effect";
import { createDeadline } from "./deadline.ts";

const Nonnegative = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

/**
 * Non-chat deployments. `systemone`: TypeSafe System One classification, local
 * Kev on Gufo or cloud Jev; a request names its deployment and never falls back
 * to another one (Kev and Jev give different probabilities for the same
 * question). `embeddings`: one local OpenAI-compatible `/embeddings` server;
 * there is no cloud fallback (vectors from another model are incompatible).
 */
export const AuxiliaryDeployment = Schema.Struct({
  id: Schema.NonEmptyString,
  modality: Schema.Literals(["systemone", "embeddings"]),
  transport: Schema.Literals(["gufo", "typesafe", "openai"]),
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
    if ((deployment.modality === "embeddings") !== (deployment.transport === "openai"))
      throw new Error("Embeddings deployments, and only they, use the openai transport");
    // The router streams the client's body to the server unchanged, so the id the
    // client sends is the id the server checks, and there is nothing to choose between.
    if (
      deployment.modality === "embeddings" &&
      (deployment.location !== "local" ||
        deployment.id !== deployment.modelId ||
        deployments.filter((item) => item.modality === "embeddings").length > 1)
    )
      throw new Error("Embeddings need exactly one local deployment whose id is its modelId");
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
