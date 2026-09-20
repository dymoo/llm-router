import "server-only";

export { disposeControlPlane, getAdminDeps, keys, leaseFor } from "./control.ts";
export { disposeGateway, getInferenceDeps, statusStore } from "./runtime.ts";
export { gatewayHealth } from "./health.ts";
import { gatewayHealth } from "./health.ts";

export function getHealthDeps() {
  return {
    health: {
      snapshot: gatewayHealth,
    },
  };
}
