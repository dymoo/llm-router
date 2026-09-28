import { readJsonObject } from "./body.ts";
import type { AdminDeps } from "./contracts.ts";
import { decodeKeyDraft, decodeKeyPatch, decodeRotateBody } from "./decode.ts";
import { emptyResponse, failureResponse, HttpFailure, jsonResponse } from "./errors.ts";
import {
  ADMIN_MAX_BYTES,
  BODY_READ_TIMEOUT_MS,
  DEFAULT_KEY_PAGE_LIMIT,
  LOGIN_ROTATE_MAX_BYTES,
  MAX_KEY_PAGE_LIMIT,
} from "./limits.ts";
import { requireAdminMutation } from "./security.ts";

function guardAdmin(request: Request, deps: AdminDeps, mutate: boolean): void {
  if (mutate) {
    requireAdminMutation(request, deps.appOrigin);
  }
}

function optionalEpoch(raw: string | null, label: string): number | undefined {
  if (raw === null || raw.length === 0) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw Object.assign(new Error(`${label} must be epoch milliseconds`), { _tag: "InvalidInput" });
  }
  return value;
}

function optionalId(raw: string | null): string | undefined {
  if (raw === null || raw.length === 0) {
    return undefined;
  }
  return raw;
}

function queryFilters(url: URL): {
  keyId?: string;
  deploymentId?: string;
  priority?: "high" | "medium" | "low";
} {
  const priority = optionalId(url.searchParams.get("priority"));
  if (
    priority !== undefined &&
    priority !== "high" &&
    priority !== "medium" &&
    priority !== "low"
  ) {
    throw new HttpFailure(400, "invalid", "Invalid priority");
  }
  return {
    keyId: optionalId(url.searchParams.get("keyId")),
    deploymentId: optionalId(url.searchParams.get("deploymentId")),
    priority,
  };
}

export async function handleListKeys(request: Request, deps: AdminDeps): Promise<Response> {
  try {
    guardAdmin(request, deps, false);
    const url = new URL(request.url);
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const rawLimit = url.searchParams.get("limit");
    let limit = DEFAULT_KEY_PAGE_LIMIT;
    if (rawLimit !== null) {
      limit = Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_KEY_PAGE_LIMIT) {
        throw Object.assign(new Error("limit must be between 1 and 50"), { _tag: "InvalidInput" });
      }
    }
    const page = await deps.keys.listKeys({ cursor, limit });
    return jsonResponse(200, page);
  } catch (error) {
    return failureResponse(error);
  }
}

export async function handleCreateKey(request: Request, deps: AdminDeps): Promise<Response> {
  try {
    guardAdmin(request, deps, true);
    const json = await readJsonObject(request, {
      maxBytes: ADMIN_MAX_BYTES,
      timeoutMs: BODY_READ_TIMEOUT_MS,
    });
    const created = await deps.keys.createKey(decodeKeyDraft(json));
    return jsonResponse(201, created);
  } catch (error) {
    return failureResponse(error);
  }
}

export async function handleUpdateKey(
  request: Request,
  deps: AdminDeps,
  id: string,
): Promise<Response> {
  try {
    guardAdmin(request, deps, true);
    const json = await readJsonObject(request, {
      maxBytes: ADMIN_MAX_BYTES,
      timeoutMs: BODY_READ_TIMEOUT_MS,
    });
    const key = await deps.keys.updateKey(id, decodeKeyPatch(json));
    return jsonResponse(200, { key });
  } catch (error) {
    return failureResponse(error);
  }
}

export async function handleRevokeKey(
  request: Request,
  deps: AdminDeps,
  id: string,
): Promise<Response> {
  try {
    guardAdmin(request, deps, true);
    await deps.keys.revokeKey(id);
    return emptyResponse(204);
  } catch (error) {
    return failureResponse(error);
  }
}

export async function handleRotateKey(
  request: Request,
  deps: AdminDeps,
  id: string,
): Promise<Response> {
  try {
    guardAdmin(request, deps, true);
    const json = await readJsonObject(request, {
      maxBytes: LOGIN_ROTATE_MAX_BYTES,
      timeoutMs: BODY_READ_TIMEOUT_MS,
    });
    const rotated = await deps.keys.rotateKey(id, decodeRotateBody(json).expectedVersion);
    return jsonResponse(200, rotated);
  } catch (error) {
    return failureResponse(error);
  }
}

export async function handleUsage(request: Request, deps: AdminDeps): Promise<Response> {
  try {
    guardAdmin(request, deps, false);
    const url = new URL(request.url);
    const since = optionalEpoch(url.searchParams.get("since"), "since");
    const until = optionalEpoch(url.searchParams.get("until"), "until");
    if (since === undefined || until === undefined) {
      throw new HttpFailure(400, "invalid", "Both since and until are required");
    }
    return jsonResponse(
      200,
      await deps.keys.analytics(
        { since, until, ...queryFilters(url) },
        deps.classifierQualifications,
      ),
    );
  } catch (error) {
    return failureResponse(error);
  }
}

export async function handleRequests(request: Request, deps: AdminDeps): Promise<Response> {
  try {
    guardAdmin(request, deps, false);
    const url = new URL(request.url);
    const rawLimit = url.searchParams.get("limit");
    let limit = DEFAULT_KEY_PAGE_LIMIT;
    if (rawLimit !== null) {
      limit = Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_KEY_PAGE_LIMIT) {
        throw Object.assign(new Error("limit must be between 1 and 50"), { _tag: "InvalidInput" });
      }
    }
    const query = {
      cursor: url.searchParams.get("cursor") ?? undefined,
      limit,
      ...queryFilters(url),
      since: optionalEpoch(url.searchParams.get("since"), "since"),
      until: optionalEpoch(url.searchParams.get("until"), "until"),
    };
    return jsonResponse(200, await deps.keys.recentRequests(query));
  } catch (error) {
    return failureResponse(error);
  }
}
