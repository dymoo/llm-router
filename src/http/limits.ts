export const INFERENCE_MAX_BYTES = 1 * 1024 * 1024;
export const ADMIN_MAX_BYTES = 32 * 1024;
export const LOGIN_ROTATE_MAX_BYTES = 1024;
export const BODY_READ_TIMEOUT_MS = 15_000;
export const UPSTREAM_RESPONSE_MAX_BYTES = 32 * 1024 * 1024;
export const GENERATION_TIMEOUT_MS = 10 * 60 * 1000;
export const GATEWAY_EFFECT_TIMEOUT_MS = 11 * 60 * 1000;
export const ADMIN_SESSION_MS = 8 * 60 * 60 * 1000;
export const MESSAGE_TOKEN_OVERHEAD = 32;
export const TOKEN_ESTIMATE_RESERVE = 1024;
export const DEFAULT_KEY_PAGE_LIMIT = 50;
export const MAX_KEY_PAGE_LIMIT = 50;
export const ADMIN_COOKIE = "jev_admin";
export const ADMIN_HOST_COOKIE = "__Host-jev_admin";
export const ADMIN_MUTATION_HEADER = "x-jev-admin";
export const ADMIN_MUTATION_VALUE = "1";

export type BodyReadOptions = {
  maxBytes: number;
  timeoutMs: number;
};
