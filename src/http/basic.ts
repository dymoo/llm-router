import { createHash, timingSafeEqual } from "node:crypto";
import { HttpFailure } from "./errors.ts";
import { noStoreHeaders } from "./errors.ts";

export type BasicCredentials = {
  username: string;
  password: string;
};

export function parseBasicAuthConfig(value: string | undefined): BasicCredentials | undefined {
  if (value === undefined || value.length === 0) {
    return undefined;
  }
  const idx = value.indexOf(":");
  if (idx <= 0 || idx === value.length - 1) {
    throw new Error("ADMIN_BASIC_AUTH must be username:password");
  }
  return {
    username: value.slice(0, idx),
    password: value.slice(idx + 1),
  };
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function verifyBasic(header: string | null, expected: BasicCredentials): boolean {
  if (header === null || !header.startsWith("Basic ")) {
    return false;
  }
  let decoded: string;
  try {
    decoded = atob(header.slice("Basic ".length).trim());
  } catch {
    return false;
  }
  const idx = decoded.indexOf(":");
  if (idx < 0) {
    return false;
  }
  const userOk = timingSafeEqual(sha256(decoded.slice(0, idx)), sha256(expected.username));
  const passOk = timingSafeEqual(sha256(decoded.slice(idx + 1)), sha256(expected.password));
  return userOk && passOk;
}

export function requireBasic(request: Request, expected: BasicCredentials | undefined): void {
  if (expected === undefined) {
    return;
  }
  if (!verifyBasic(request.headers.get("authorization"), expected)) {
    throw new HttpFailure(401, "unauthorized", "admin authentication required");
  }
}

export function unauthorizedBasic(): Response {
  const headers = noStoreHeaders();
  headers.set("www-authenticate", 'Basic realm="llm-router"');
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(
    JSON.stringify({ error: { code: "unauthorized", message: "admin authentication required" } }),
    {
      status: 401,
      headers,
    },
  );
}
