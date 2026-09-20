import { gatewayHealth } from "@/server/health.ts";
import { jsonResponse } from "@/src/http/errors.ts";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(): Promise<Response> {
  try {
    const health = await gatewayHealth();
    return jsonResponse(health.ready ? 200 : 503, health);
  } catch {
    return jsonResponse(503, { ready: false });
  }
}
