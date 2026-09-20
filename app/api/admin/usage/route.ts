import { handleUsage } from "@/src/http/admin.ts";
import { methodNotAllowed } from "@/src/http/security.ts";
import { getAdminDeps } from "@/server/control.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return handleUsage(request, getAdminDeps());
}

export function POST(): Response {
  return methodNotAllowed("GET");
}
