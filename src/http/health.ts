import type { HealthDeps } from "./contracts.ts";
import { failureResponse, jsonResponse } from "./errors.ts";

export async function handleHealth(_request: Request, deps: HealthDeps): Promise<Response> {
  try {
    const snapshot = await deps.health.snapshot();
    return jsonResponse(200, snapshot);
  } catch (error) {
    return failureResponse(error);
  }
}
