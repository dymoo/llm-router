import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  API_KEY_HMAC_DOMAIN,
  API_KEY_SECRET_LENGTH,
  API_KEY_SELECTOR_HEX_LENGTH,
  API_KEY_TOKEN_PREFIX,
} from "../domain.ts";

export const PEPPER_FINGERPRINT_DOMAIN = "dymoo-llm-router/pepper-fingerprint/v1";

const TOKEN_PATTERN = new RegExp(
  `^${API_KEY_TOKEN_PREFIX}([0-9a-f]{${API_KEY_SELECTOR_HEX_LENGTH}})\\.([A-Za-z0-9_-]{${API_KEY_SECRET_LENGTH}})$`,
);

export function hmacHex(pepper: string, domain: string, message: string): string {
  return createHmac("sha256", pepper).update(domain).update("\0").update(message).digest("hex");
}

export function pepperFingerprint(pepper: string): string {
  return hmacHex(pepper, PEPPER_FINGERPRINT_DOMAIN, "fingerprint");
}

export function apiKeyDigest(pepper: string, token: string): string {
  return hmacHex(pepper, API_KEY_HMAC_DOMAIN, token);
}

export function timingSafeEqualHex(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  if (a.length === 0 || a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

export function parseApiKey(token: string): { prefix: string; token: string } | undefined {
  const match = TOKEN_PATTERN.exec(token);
  if (match === null || match[1] === undefined) {
    return undefined;
  }
  return { prefix: `${API_KEY_TOKEN_PREFIX}${match[1]}`, token };
}

export function generateApiKey(): { token: string; prefix: string } {
  const selector = randomBytes(12).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  const prefix = `${API_KEY_TOKEN_PREFIX}${selector}`;
  return { token: `${prefix}.${secret}`, prefix };
}
