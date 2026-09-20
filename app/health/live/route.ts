import { jsonResponse } from "@/src/http/errors.ts";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(): Response {
  return jsonResponse(200, { alive: true });
}
