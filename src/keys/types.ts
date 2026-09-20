import type {
  ApiKeyPublic,
  ClassificationReuse,
  ClassifierMode,
  ClassifierSource,
  KeyPolicy,
} from "../domain.ts";

export const REQUEST_LEASE_MS = 12 * 60 * 1000;
export const REQUEST_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const AUDIT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const MAINTENANCE_INTERVAL_MS = 5 * 60 * 1000;

export interface CreatedKey {
  readonly key: ApiKeyPublic;
  readonly secret: string;
}

export interface KeyUsage {
  readonly requestCount: number;
  readonly runningCount: number;
  readonly successCount: number;
  readonly errorCount: number;
  readonly abandonedCount: number;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
}

export interface ListedKey extends ApiKeyPublic {
  readonly usage: KeyUsage;
}

export interface KeyList {
  readonly items: readonly ListedKey[];
  readonly nextCursor: string | null;
}

export interface Admission {
  readonly requestId: string;
  readonly keyId: string;
  readonly prefix: string;
  readonly name: string;
  readonly policy: KeyPolicy;
  readonly version: number;
  readonly leaseExpiresAt: number;
  readonly admittedAt: number;
}

export interface FinalizeOutcome {
  readonly status: "success" | "error" | "abandoned";
  readonly deploymentId?: string | null;
  readonly promptTokens?: number | null;
  readonly completionTokens?: number | null;
  readonly reasoningTokens?: number | null;
  readonly cachedInputTokens?: number | null;
  readonly ttftMs?: number | null;
  readonly generationElapsedMs?: number | null;
  readonly providerReportedUsd?: number | null;
  readonly estimatedCostUsd?: number | null;
  readonly estimatedCacheSavingsUsd?: number | null;
  readonly localComputeEstimatedUsd?: number | null;
  readonly priceVersion?: string | null;
  readonly trajectoryHash?: string | null;
  readonly errorCode?: string | null;
  readonly classifierBackend?: ClassifierMode | null;
  readonly modelRevision?: string | null;
  readonly source?: ClassifierSource | null;
  readonly classifierInputTokens?: number | null;
  readonly classifierElapsedMs?: number | null;
  readonly reuse?: ClassificationReuse | null;
  readonly location?: "local" | "cloud" | null;
  readonly transport?: string | null;
  readonly boundary?: string | null;
  readonly saturation?: boolean;
  readonly queueWaitMs?: number | null;
  readonly decisionReason?: string | null;
  readonly selectionReasonCode?: string | null;
  readonly selectionReasonDetail?: string | null;
  readonly exclusionJson?: string | null;
  readonly taskKind?: string | null;
  readonly difficulty?: string | null;
  readonly requestedEffort?: string | null;
  readonly decodeTps?: number | null;
  readonly cacheObservation?: "observed-hit" | "observed-miss" | "unknown" | null;
  readonly costSource?: "provider-reported" | "local-rate-card" | "estimated" | null;
  readonly decisionTraceJson?: string | null;
}

export interface UsageSummary {
  readonly requestCount: number;
  readonly runningCount: number;
  readonly successCount: number;
  readonly errorCount: number;
  readonly abandonedCount: number;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly estimatedCostUsd: number | null;
  readonly providerReportedUsd: number | null;
  readonly localComputeEstimatedUsd: number | null;
  readonly missingUsageCount: number;
  readonly missingCostCount: number;
  readonly zeroApiPriceMissingLocalCogsCount: number;
}

export interface RecentRequest {
  readonly id: string;
  readonly keyId: string;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly status: "running" | "success" | "error" | "abandoned";
  readonly deploymentId: string | null;
  readonly classifierBackend: ClassifierMode | null;
  readonly modelRevision: string | null;
  readonly source: ClassifierSource | null;
  readonly classifierInputTokens: number | null;
  readonly classifierElapsedMs: number | null;
  readonly reuse: ClassificationReuse | null;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly ttftMs: number | null;
  readonly generationElapsedMs: number | null;
  readonly providerReportedUsd: number | null;
  readonly estimatedCostUsd: number | null;
  readonly estimatedCacheSavingsUsd: number | null;
  readonly localComputeEstimatedUsd: number | null;
  readonly priceVersion: string | null;
  readonly trajectoryHash: string | null;
  readonly errorCode: string | null;
  readonly priority: string | null;
  readonly localityBias: number | null;
  readonly location: string | null;
  readonly transport: string | null;
  readonly boundary: string | null;
  readonly saturation: boolean;
  readonly queueWaitMs: number | null;
  readonly decisionReason: string | null;
  readonly exclusions: readonly { deploymentId: string; code: string; detail: string }[];
  readonly taskKind: string | null;
  readonly difficulty: string | null;
  readonly requestedEffort: string | null;
  readonly decodeTps: number | null;
  readonly cacheObservation: string | null;
  readonly costSource: string | null;
  readonly decisionTrace: unknown;
}

export interface RecentRequestList {
  readonly items: readonly RecentRequest[];
  readonly nextCursor: string | null;
}
