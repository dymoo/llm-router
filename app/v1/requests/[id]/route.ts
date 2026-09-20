import { handleRequestStatus } from "@/src/http/inference.ts";
import { methodNotAllowed } from "@/src/http/security.ts";
import { getInferenceDeps } from "@/server/runtime.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { id } = await context.params;
  return handleRequestStatus(request, getInferenceDeps(), id);
}

export function POST(): Response {
  return methodNotAllowed("GET");
}
