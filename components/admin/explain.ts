import { MAX_WAIT_MS } from "./types";
import type { KeyPolicy, Priority } from "./types";

export function explainLocalityBias(value: number): string {
  if (value <= 0.2) {
    return "Cloud-preferred. Local is optional. Complex work can go to cloud without waiting for saturation. This is a preference, not a guaranteed share of traffic.";
  }
  if (value < 0.8) {
    return "Local-preferred. Prefer local hardware; cloud is eligible for clearly complex work or when local is verified saturated. The percentage is a preference, not a routing probability.";
  }
  return "Local until verified saturation. Cloud only after the runtime reports verified saturation. A busy flag, queue, or missing telemetry is not saturation. This is not a guaranteed local percentage.";
}

export function explainPriority(priority: Priority): string {
  if (priority === "high") {
    return "High admission and queue precedence. Does not preempt work already running.";
  }
  if (priority === "medium") {
    return "Medium admission and queue precedence, after high, before low. Does not preempt running work.";
  }
  return "Low admission and queue precedence. Waits behind high and medium. Does not preempt running work.";
}

export function explainCostBias(value: number): string {
  if (value >= 0.85) {
    return "Strong cost bias. Cheaper eligible deployments rank first. Hard allowlists, quality floors, context, and cost caps still win.";
  }
  if (value <= 0.25) {
    return "Weak cost bias. Price barely moves ranking inside the hard limits.";
  }
  return "Moderate cost bias. Estimated token cost affects ranking only among deployments that already pass hard limits.";
}

export function explainQualityBias(value: number): string {
  if (value >= 0.85) {
    return "Strong quality bias. Higher-quality eligible deployments rank first. This cannot widen permissions or caps.";
  }
  if (value <= 0.25) {
    return "Weak quality bias. Configured quality scores barely move ranking.";
  }
  return "Moderate quality bias. Configured quality priors affect ranking inside hard limits.";
}

export function explainLatencyBias(value: number): string {
  if (value >= 0.7) {
    return "Strong latency bias. Faster eligible deployments rank first.";
  }
  if (value <= 0.15) {
    return "Weak latency bias. Speed estimates barely move ranking.";
  }
  return "Moderate latency bias. Estimated latency affects ranking inside hard limits.";
}

export function explainQueueWait(maxWaitMs: number): string {
  if (maxWaitMs <= 0) {
    return "No capacity wait. If the preferred deployment is full, the request fails or spills only when locality and hard limits allow it.";
  }
  const seconds = maxWaitMs / 1000;
  const label = Number.isInteger(seconds) ? `${seconds}` : seconds.toFixed(1);
  return `Wait up to ${label}s for preferred capacity. The client should be told it is queued. Maximum wait is ${MAX_WAIT_MS / 1000}s.`;
}

export function localityLabel(value: number): string {
  if (value <= 0.2) {
    return "Cloud-preferred";
  }
  if (value < 0.8) {
    return "Local-preferred";
  }
  return "Local until saturated";
}

export function policySummary(policy: KeyPolicy): string {
  return `${policy.priority} · ${localityLabel(policy.localityBias)}`;
}
