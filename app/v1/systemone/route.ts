import { handleSystemOne } from "@/src/http/auxiliary.ts";
import { getAuxiliaryDeps } from "@/server/auxiliary.ts";
import { failureResponse } from "@/src/http/errors.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** TypeSafe System One: typed questions about a state, answered by Kev or Jev. */
export async function POST(request: Request): Promise<Response> {
  try {
    return await handleSystemOne(request, getAuxiliaryDeps());
  } catch (error) {
    return failureResponse(error);
  }
}
