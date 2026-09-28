import "server-only";
import { Effect, Predicate } from "effect";
import { getEnv, getProviderCredentials } from "../env.ts";
import { createDeadline } from "../src/deadline.ts";
import { RouterClassifier, type ClassifierHealth } from "../src/classifier.ts";
import { deploymentIsPlaceholder } from "../src/domain.ts";
import { createHealthMonitor } from "../src/health.ts";
import type { DeploymentHealth } from "../src/http/contracts.ts";
import { adaptersFor } from "../src/router/adapters/index.ts";
import { OPENROUTER_APP_HEADERS } from "../src/router/adapters/openrouter.ts";
import { configuredAuxiliaryDeployments } from "./auxiliary.ts";
import { keys } from "./control.ts";
import { loadClassifierQualifications } from "./qualification.ts";
import { configuredChatDeployments } from "./runtime.ts";
import { processState } from "./state.ts";

async function boundedFetch(
  input: string,
  init: RequestInit | undefined,
  consume: (response: Response) => Promise<boolean>,
): Promise<boolean> {
  const deadline = createDeadline(2_000, init?.signal ? [init.signal] : []);
  try {
    const response = await fetch(input, { ...init, redirect: "error", signal: deadline.signal });
    return await consume(response);
  } finally {
    deadline.clear();
  }
}
// Runtime adapters own their probe budgets; Halogen's documented PONG can take 30 seconds.
const adapters = adaptersFor(fetch);

async function classifier(): Promise<ClassifierHealth> {
  const env = getEnv();
  if (env.CLASSIFIER_MODE === "rules") {
    return { backend: "rules", ready: true, local: true, evidence: "deterministic-rules" };
  }
  return Effect.runPromise(
    RouterClassifier.readiness({
      mode: env.CLASSIFIER_MODE,
      layaUrl: env.LAYA_URL,
      layaModelRevision: env.LAYA_MODEL_REVISION,
      jevModel: env.TYPESAFE_MODEL,
      jevApiKey: env.TYPESAFE_API_KEY,
      qualifications: loadClassifierQualifications(),
    }),
  );
}

async function deployments(): Promise<DeploymentHealth[]> {
  const chat = configuredChatDeployments();
  const credentials = getProviderCredentials(
    chat.flatMap((item) => (item.credentialEnvVar === null ? [] : [item.credentialEnvVar])),
  );
  const primary = await Promise.all(
    chat.map(async (deployment): Promise<DeploymentHealth> => {
      const credential =
        deployment.credentialEnvVar === null ? undefined : credentials[deployment.credentialEnvVar];
      let ready = false;
      try {
        if (
          !deploymentIsPlaceholder(deployment) &&
          (deployment.credentialEnvVar === null || credential !== undefined)
        ) {
          if (deployment.location === "local")
            ready = !(await Effect.runPromise(
              adapters[deployment.transport].probeUnavailable(deployment, credential),
            ));
          else {
            ready = await boundedFetch(
              `${deployment.endpoint.replace(/\/$/, "")}/${deployment.transport === "openrouter" ? "auth/key" : "models"}`,
              {
                headers: {
                  ...(deployment.transport === "openrouter" ? OPENROUTER_APP_HEADERS : {}),
                  ...(credential ? { authorization: `Bearer ${credential}` } : {}),
                },
              },
              async (response) => {
                try {
                  return response.ok;
                } finally {
                  await response.body?.cancel();
                }
              },
            );
          }
        }
      } catch {
        ready = false;
      }
      return {
        id: deployment.id,
        ready,
        location: deployment.location,
        evidence: ready ? "runtime-probe" : "unavailable",
      };
    }),
  );
  const auxiliary = await Promise.all(
    configuredAuxiliaryDeployments().map(async (deployment): Promise<DeploymentHealth> => {
      let ready = false;
      try {
        ready = await boundedFetch(
          `${deployment.endpoint.replace(/\/$/, "")}/models`,
          undefined,
          async (response) => {
            const body: unknown = await response.json();
            return (
              response.ok &&
              Predicate.isObject(body) &&
              Array.isArray(body.data) &&
              body.data.some((item) => Predicate.isObject(item) && item.id === deployment.modelId)
            );
          },
        );
      } catch {
        ready = false;
      }
      return {
        id: deployment.id,
        ready,
        location: "local",
        optional: true,
        evidence: ready ? "runtime-probe" : "unavailable",
      };
    }),
  );
  return [...primary, ...auxiliary];
}

const monitor = (processState.health ??= createHealthMonitor({
  classifier,
  deployments,
  persistence: async () => {
    await keys.listKeys({ limit: 1 });
    return true;
  },
}));
export const gatewayHealth = () => monitor.snapshot();
export const stopHealth = () => monitor.stop();
