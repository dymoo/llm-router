import { handleChatCompletions } from "@/src/http/inference.ts";
import { failureResponse } from "@/src/http/errors.ts";
import { methodNotAllowed } from "@/src/http/security.ts";
import { getInferenceDeps } from "@/server/runtime.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  try {
    return await handleChatCompletions(request, getInferenceDeps());
  } catch (error) {
    return failureResponse(error);
  }
}

export function GET(): Response {
  return methodNotAllowed("POST");
}
