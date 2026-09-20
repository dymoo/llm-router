import type { PublicKey } from "./types";

export type KeyLifecycle = "active" | "expired" | "revoked";

export function keyLifecycle(key: PublicKey, now = Date.now()): KeyLifecycle {
  if (key.revokedAt !== null) {
    return "revoked";
  }
  if (key.expiresAt !== null && key.expiresAt <= now) {
    return "expired";
  }
  return "active";
}

export function formatEpoch(value: number | null): string {
  if (value === null) {
    return "—";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function formatCount(value: number): string {
  if (!Number.isFinite(value)) {
    return "0";
  }
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
}

export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0";
  }
  if (value >= 1_000_000) {
    return `${trimNumber(value / 1_000_000)}M`;
  }
  if (value >= 10_000) {
    return `${trimNumber(value / 1_000)}k`;
  }
  return formatCount(value);
}

export function toDateTimeLocal(value: number | null): string {
  if (value === null) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function fromDateTimeLocal(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const ms = new Date(trimmed).getTime();
  if (!Number.isFinite(ms)) {
    return null;
  }
  return ms;
}

export function formatUnknown(
  value: number | null,
  format: (value: number) => string = formatCount,
): string {
  if (value === null) {
    return "—";
  }
  return format(value);
}

const usdFormatter = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 8,
});

export function formatUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 0) return "—";
  if (value > 0 && value < 0.00000001) return `<${usdFormatter.format(0.00000001)}`;
  return usdFormatter.format(value);
}

export function formatRatio(value: number | null): string {
  if (value === null) {
    return "—";
  }
  return `${Math.round(value * 100)}%`;
}

function trimNumber(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}
