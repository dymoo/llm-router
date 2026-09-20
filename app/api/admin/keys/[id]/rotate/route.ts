import { handleRotateKey } from "@/src/http/admin.ts";
import { methodNotAllowed } from "@/src/http/security.ts";
import { getAdminDeps } from "@/server/control.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const { id } = await context.params;
  return handleRotateKey(request, getAdminDeps(), id);
}

export function GET(): Response {
  return methodNotAllowed("POST");
}
