import { HttpFailure } from "./errors.ts";
import { ADMIN_MUTATION_HEADER, ADMIN_MUTATION_VALUE } from "./limits.ts";

export function requireOrigin(request: Request, appOrigin: string): void {
  const origin = request.headers.get("origin");
  if (origin === null || origin !== appOrigin) {
    throw new HttpFailure(403, "forbidden", "origin is not allowed");
  }
}

export function requireAdminMutation(request: Request, appOrigin: string): void {
  requireOrigin(request, appOrigin);
  if (request.headers.get(ADMIN_MUTATION_HEADER) !== ADMIN_MUTATION_VALUE) {
    throw new HttpFailure(403, "forbidden", "admin mutation header is required");
  }
}

export function bearerToken(request: Request): string {
  const header = request.headers.get("authorization");
  if (header === null || !header.startsWith("Bearer ")) {
    throw new HttpFailure(401, "unauthorized", "bearer token required");
  }
  const token = header.slice("Bearer ".length).trim();
  if (token.length === 0) {
    throw new HttpFailure(401, "unauthorized", "bearer token required");
  }
  return token;
}

export function methodNotAllowed(allow: string): Response {
  const headers = new Headers();
  headers.set("allow", allow);
  headers.set("cache-control", "no-store");
  return new Response(null, { status: 405, headers });
}
