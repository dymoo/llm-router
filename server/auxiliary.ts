import "server-only";
import { readFileSync } from "node:fs";
import { getEnv } from "../env.ts";
import { decodeAuxiliaryCatalogue, type AuxiliaryDeployment } from "../src/auxiliary.ts";
import { pinnableModels } from "../src/domain.ts";
import { type AuxiliaryDeps } from "../src/http/auxiliary.ts";
import { processState } from "./state.ts";
import { assertAcceptingWork } from "./lifecycle.ts";
import { keys } from "./control.ts";
import { configuredChatDeployments, statusStore } from "./runtime.ts";
import { registerDeployments } from "./metrics.ts";

export function configuredAuxiliaryDeployments(): readonly AuxiliaryDeployment[] {
  if (processState.auxiliary === undefined) {
    const path = getEnv().AUXILIARY_CATALOG;
    processState.auxiliary =
      path === undefined ? [] : decodeAuxiliaryCatalogue(JSON.parse(readFileSync(path, "utf8")));
    registerDeployments(processState.auxiliary.map((item) => item.id));
    const chatIds = new Set(configuredChatDeployments().map((item) => item.id));
    if (processState.auxiliary.some((item) => chatIds.has(item.id)))
      throw new Error("Chat and auxiliary deployment ids must be unique");
  }
  return processState.auxiliary;
}

export function getAuxiliaryDeps(): AuxiliaryDeps {
  assertAcceptingWork();
  return {
    keys,
    deployments: configuredAuxiliaryDeployments(),
    chatModels: pinnableModels(configuredChatDeployments()),
    pool: processState.auxiliaryPool,
    status: statusStore,
  };
}
