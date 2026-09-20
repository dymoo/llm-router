import { handleModels } from "@/src/http/auxiliary.ts";
import { getAuxiliaryDeps } from "@/server/auxiliary.ts";
import { failureResponse } from "@/src/http/errors.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    return await handleModels(request, getAuxiliaryDeps());
  } catch (error) {
    return failureResponse(error);
  }
}
