import { handleCreateKey, handleListKeys } from "@/src/http/admin.ts";
import { methodNotAllowed } from "@/src/http/security.ts";
import { getAdminDeps } from "@/server/control.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return handleListKeys(request, getAdminDeps());
}

export async function POST(request: Request): Promise<Response> {
  return handleCreateKey(request, getAdminDeps());
}

export function PUT(): Response {
  return methodNotAllowed("GET, POST");
}
