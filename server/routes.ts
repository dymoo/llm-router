import "server-only";
import {
  handleCreateKey,
  handleListKeys,
  handleRequests,
  handleRevokeKey,
  handleRotateKey,
  handleUpdateKey,
  handleUsage,
} from "../src/http/admin.ts";
import { handleModels, handleSystemOne } from "../src/http/auxiliary.ts";
import {
  handleCreateBatch,
  handleDeleteBatch,
  handleGetBatch,
  handleListBatches,
} from "../src/http/batch.ts";
import { handleEmbeddings } from "../src/http/embeddings.ts";
import { failureResponse, jsonResponse } from "../src/http/errors.ts";
import { handleHealth } from "../src/http/health.ts";
import { handleChatCompletions, handleRequestStatus } from "../src/http/inference.ts";
import { methodNotAllowed } from "../src/http/security.ts";
import { getAuxiliaryDeps } from "./auxiliary.ts";
import { getBatchDeps } from "./batch.ts";
import { getAdminDeps } from "./control.ts";
import { gatewayHealth } from "./health.ts";
import { getInferenceDeps } from "./runtime.ts";

type Handler = (request: Request, id: string) => Response | Promise<Response>;

const guarded =
  (handler: Handler): Handler =>
  async (request, id) => {
    try {
      return await handler(request, id);
    } catch (error) {
      return failureResponse(error);
    }
  };

export async function readiness(): Promise<Response> {
  try {
    const health = await gatewayHealth();
    return jsonResponse(health.ready ? 200 : 503, health);
  } catch {
    return jsonResponse(503, { ready: false });
  }
}

/** Every HTTP route: path (`:id` is the one parameter) → method → handler. */
export const routes: Record<string, Partial<Record<string, Handler>>> = {
  "/health/live": { GET: () => jsonResponse(200, { alive: true }) },
  "/health/ready": { GET: readiness },
  "/api/health": { GET: (r) => handleHealth(r, { health: { snapshot: gatewayHealth } }) },
  "/v1/models": { GET: guarded((r) => handleModels(r, getAuxiliaryDeps())) },
  "/v1/systemone": { POST: guarded((r) => handleSystemOne(r, getAuxiliaryDeps())) },
  "/v1/embeddings": { POST: guarded((r) => handleEmbeddings(r, getAuxiliaryDeps())) },
  "/v1/chat/completions": { POST: guarded((r) => handleChatCompletions(r, getInferenceDeps())) },
  "/v1/requests/:id": { GET: (r, id) => handleRequestStatus(r, getInferenceDeps(), id) },
  "/v1/batches": {
    GET: guarded((r) => handleListBatches(r, getBatchDeps())),
    POST: guarded((r) => handleCreateBatch(r, getBatchDeps())),
  },
  "/v1/batches/:id": {
    GET: guarded((r, id) => handleGetBatch(r, getBatchDeps(), id)),
    DELETE: guarded((r, id) => handleDeleteBatch(r, getBatchDeps(), id)),
  },
  "/api/admin/usage": { GET: (r) => handleUsage(r, getAdminDeps()) },
  "/api/admin/requests": { GET: (r) => handleRequests(r, getAdminDeps()) },
  "/api/admin/keys": {
    GET: (r) => handleListKeys(r, getAdminDeps()),
    POST: (r) => handleCreateKey(r, getAdminDeps()),
  },
  "/api/admin/keys/:id": {
    PATCH: (r, id) => handleUpdateKey(r, getAdminDeps(), id),
    DELETE: (r, id) => handleRevokeKey(r, getAdminDeps(), id),
  },
  "/api/admin/keys/:id/rotate": { POST: (r, id) => handleRotateKey(r, getAdminDeps(), id) },
};

/** Dispatch one request to its route's method handler, or 405 with the route's methods. */
export function dispatch(path: string, request: Request, id = ""): Response | Promise<Response> {
  const methods = routes[path] ?? {};
  const handler = methods[request.method];
  return handler ? handler(request, id) : methodNotAllowed(Object.keys(methods).join(", "));
}
