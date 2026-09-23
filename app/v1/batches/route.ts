import { handleCreateBatch, handleListBatches } from "@/src/http/batch.ts";
import { failureResponse } from "@/src/http/errors.ts";
import { methodNotAllowed } from "@/src/http/security.ts";
import { getBatchDeps } from "@/server/batch.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  try {
    return await handleCreateBatch(request, getBatchDeps());
  } catch (error) {
    return failureResponse(error);
  }
}

export async function GET(request: Request): Promise<Response> {
  try {
    return await handleListBatches(request, getBatchDeps());
  } catch (error) {
    return failureResponse(error);
  }
}

export function DELETE(): Response {
  return methodNotAllowed("GET, POST");
}
