import { handleAuxiliary } from "@/src/http/auxiliary.ts";
import { getAuxiliaryDeps } from "@/server/auxiliary.ts";
import { failureResponse } from "@/src/http/errors.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    return await handleAuxiliary(request, getAuxiliaryDeps(), "embeddings");
  } catch (error) {
    return failureResponse(error);
  }
}
