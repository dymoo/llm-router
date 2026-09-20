import type { SessionHeaders } from "./contracts.ts";
import { noStoreHeaders } from "./errors.ts";

export function sessionResponseHeaders(headers: SessionHeaders, extra?: HeadersInit): Headers {
  const out = noStoreHeaders(extra);
  out.set("x-request-id", headers.requestId);
  out.set("x-deployment-id", encodeURIComponent(headers.deploymentId));
  out.set("x-session-id", encodeURIComponent(headers.sessionId));
  out.set("x-applied-effort", headers.appliedEffort);
  if (headers.priority !== undefined) {
    out.set("x-priority", headers.priority);
  }
  if (headers.queueWaitMs !== undefined) {
    out.set("x-queue-wait-ms", String(headers.queueWaitMs));
  }
  return out;
}

export function sseHeaders(headers: SessionHeaders): Headers {
  const out = sessionResponseHeaders(headers);
  out.set("content-type", "text/event-stream; charset=utf-8");
  out.set("connection", "keep-alive");
  out.set("x-accel-buffering", "no");
  return out;
}
