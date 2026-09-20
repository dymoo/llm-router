import { handleHealth } from "@/src/http/health.ts";
import { methodNotAllowed } from "@/src/http/security.ts";
import { gatewayHealth } from "@/server/health.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return handleHealth(request, { health: { snapshot: gatewayHealth } });
}

export function POST(): Response {
  return methodNotAllowed("GET");
}
