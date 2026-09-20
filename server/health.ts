import "server-only";
import { Effect, Predicate } from "effect";
import { getEnv, getProviderCredentials } from "../env.ts";
import { decodeLayaHealth, deploymentIsPlaceholder } from "../src/domain.ts";
import { createHealthMonitor } from "../src/health.ts";
import type { ClassifierHealth, DeploymentHealth } from "../src/http/contracts.ts";
import { adaptersFor } from "../src/router/adapters/index.ts";
import { configuredAuxiliaryDeployments } from "./auxiliary.ts";
import { keys } from "./control.ts";
import { configuredChatDeployments } from "./runtime.ts";
import { processState } from "./state.ts";

const boundedFetch: typeof fetch = (input, init) =>
  fetch(input, {
    ...init,
    redirect: "error",
    signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(2_000)]),
  });
// Runtime adapters own their probe budgets; Halogen's documented PONG can take 30 seconds.
const adapters = adaptersFor(fetch);

async function classifier(): Promise<ClassifierHealth> {
  const env = getEnv();
  if (env.CLASSIFIER_MODE === "jev") {
    // Jev has no documented free authenticated readiness endpoint. Never spend on a probe.
    return {
      ready: env.TYPESAFE_API_KEY !== undefined,
      backend: "jev",
      local: false,
      evidence: "configuration-only",
    };
  }
  if (!env.LAYA_URL) return { ready: false, backend: "laya", local: true, evidence: "unavailable" };
  try {
    const response = await boundedFetch(`${env.LAYA_URL.replace(/\/$/, "")}/healthz`);
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("unavailable");
    }
    const health = await Effect.runPromise(decodeLayaHealth(await response.json()));
    return {
      ready: health.ready && health.model_revision === env.LAYA_MODEL_REVISION,
      backend: health.backend ?? "laya",
      local: true,
      evidence: "runtime-probe",
    };
  } catch {
    return { ready: false, backend: "laya", local: true, evidence: "unavailable" };
  }
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
            const response = await boundedFetch(
              `${deployment.endpoint.replace(/\/$/, "")}/${deployment.transport === "openrouter" ? "auth/key" : "models"}`,
              { headers: credential ? { authorization: `Bearer ${credential}` } : {} },
            );
            ready = response.ok;
            await response.body?.cancel();
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
        const response = await boundedFetch(`${deployment.endpoint.replace(/\/$/, "")}/models`);
        const body: unknown = await response.json();
        ready =
          response.ok &&
          Predicate.isObject(body) &&
          Array.isArray(body.data) &&
          body.data.some((item) => Predicate.isObject(item) && item.id === deployment.modelId);
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
