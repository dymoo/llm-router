import { handleDeleteBatch, handleGetBatch } from "@/src/http/batch.ts";
import { failureResponse } from "@/src/http/errors.ts";
import { methodNotAllowed } from "@/src/http/security.ts";
import { getBatchDeps } from "@/server/batch.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { id } = await context.params;
  try {
    return await handleGetBatch(request, getBatchDeps(), id);
  } catch (error) {
    return failureResponse(error);
  }
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  const { id } = await context.params;
  try {
    return await handleDeleteBatch(request, getBatchDeps(), id);
  } catch (error) {
    return failureResponse(error);
  }
}

export function POST(): Response {
  return methodNotAllowed("GET, DELETE");
}
