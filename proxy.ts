import { NextResponse, type NextRequest } from "next/server";
import { env } from "./env.ts";
import { verifyBasic } from "./src/http/basic.ts";

export function proxy(request: NextRequest): NextResponse {
  const path = request.nextUrl.pathname;
  const adminSurface = path === "/" || path.startsWith("/api/admin");
  if (!adminSurface || env.ADMIN_BASIC_AUTH === undefined) {
    return NextResponse.next();
  }
  if (!verifyBasic(request.headers.get("authorization"), env.ADMIN_BASIC_AUTH)) {
    return new NextResponse(
      JSON.stringify({ error: { code: "unauthorized", message: "admin authentication required" } }),
      {
        status: 401,
        headers: {
          "www-authenticate": 'Basic realm="llm-router"',
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
        },
      },
    );
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/", "/api/admin/:path*"],
};
