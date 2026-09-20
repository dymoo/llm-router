import { decodeSampling, SAMPLING_FIELDS } from "../sampling.ts";
import type {
  ChatCompletionRequest,
  ChatMessage,
  ClassifierInput,
  KeyDraft,
  KeyPatch,
  KeyPolicy,
  RequestCapabilities,
  RoutingHint,
  SessionBoundary,
} from "./contracts.ts";
import { InvalidInput } from "./errors.ts";
import { CLASSIFIER_BRIEF_MAX_CHARS } from "./limits.ts";
import { decodeMessage, decodeTools, validateToolSequence } from "./protocol.ts";
import { estimateInputTokens } from "./tokens.ts";

const REQUEST_KEYS: Record<string, true> = {
  model: true,
  messages: true,
  tools: true,
  tool_choice: true,
  response_format: true,
  max_tokens: true,
  max_completion_tokens: true,
  stream: true,
  routing: true,
  stream_options: true,
  n: true,
  ...Object.fromEntries(SAMPLING_FIELDS.map((key) => [key, true as const])),
};

const ROUTING_KEYS: Record<string, true> = {
  sessionId: true,
  boundary: true,
  taskBrief: true,
};

const BOUNDARIES: Record<SessionBoundary, true> = {
  "new-task": true,
  continue: true,
  checkpoint: true,
};

const POLICY_KEYS: Record<string, true> = {
  priority: true,
  localityBias: true,
  contextLimitTokens: true,
  maxCompletionTokens: true,
  allowedModels: true,
  requestsPerMinute: true,
  maxConcurrent: true,
  maxWaitMs: true,
  maxEstimatedUsd: true,
  bias: true,
};

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidInput(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(
  record: Record<string, unknown>,
  allowed: Record<string, true>,
  label: string,
): void {
  for (const key of Object.keys(record)) {
    if (allowed[key] !== true) {
      throw new InvalidInput(`${label} has unsupported field ${key}`);
    }
  }
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new InvalidInput(`${label} must be a finite number`);
  }
  return value;
}

function optionalNullNumber(value: unknown, label: string): number | null {
  if (value === null) {
    return null;
  }
  return finiteNumber(value, label);
}

export function decodeKeyPolicy(value: unknown): KeyPolicy {
  const record = asRecord(value, "policy");
  rejectUnknown(record, POLICY_KEYS, "policy");
  if (record.priority !== "high" && record.priority !== "medium" && record.priority !== "low") {
    throw new InvalidInput("policy.priority is invalid");
  }
  const localityBias = finiteNumber(record.localityBias, "policy.localityBias");
  if (localityBias < 0 || localityBias > 1) {
    throw new InvalidInput("policy.localityBias must be in [0,1]");
  }
  let allowedModels: readonly string[] | null = null;
  if (record.allowedModels !== null && record.allowedModels !== undefined) {
    if (
      !Array.isArray(record.allowedModels) ||
      record.allowedModels.some((id) => typeof id !== "string")
    ) {
      throw new InvalidInput("policy.allowedModels must be a string array or null");
    }
    allowedModels = record.allowedModels as string[];
  }
  const bias = asRecord(record.bias, "policy.bias");
  rejectUnknown(bias, { cost: true, quality: true, latency: true }, "policy.bias");
  const cost = finiteNumber(bias.cost, "policy.bias.cost");
  const quality = finiteNumber(bias.quality, "policy.bias.quality");
  const latency = finiteNumber(bias.latency, "policy.bias.latency");
  if (
    [cost, quality, latency].some((item) => item < 0 || item > 1) ||
    cost + quality + latency <= 0
  ) {
    throw new InvalidInput("policy.bias values must be in [0,1] with at least one positive");
  }
  return {
    priority: record.priority,
    localityBias,
    contextLimitTokens: finiteNumber(record.contextLimitTokens, "policy.contextLimitTokens"),
    maxCompletionTokens: finiteNumber(record.maxCompletionTokens, "policy.maxCompletionTokens"),
    allowedModels,
    requestsPerMinute: finiteNumber(record.requestsPerMinute, "policy.requestsPerMinute"),
    maxConcurrent: finiteNumber(record.maxConcurrent, "policy.maxConcurrent"),
    maxWaitMs: finiteNumber(record.maxWaitMs, "policy.maxWaitMs"),
    maxEstimatedUsd: optionalNullNumber(record.maxEstimatedUsd, "policy.maxEstimatedUsd"),
    bias: { cost, quality, latency },
  };
}

export function decodeLoginBody(value: Record<string, unknown>): { token: string } {
  rejectUnknown(value, { token: true }, "login");
  if (typeof value.token !== "string" || value.token.length === 0) {
    throw new InvalidInput("token is required");
  }
  return { token: value.token };
}

export function decodeKeyDraft(value: Record<string, unknown>): KeyDraft {
  rejectUnknown(value, { name: true, expiresAt: true, policy: true }, "key");
  if (typeof value.name !== "string" || value.name.length === 0) {
    throw new InvalidInput("name is required");
  }
  let expiresAt: number | null = null;
  if (value.expiresAt !== undefined && value.expiresAt !== null) {
    expiresAt = finiteNumber(value.expiresAt, "expiresAt");
  }
  return {
    name: value.name,
    expiresAt,
    policy: decodeKeyPolicy(value.policy),
  };
}

export function decodeKeyPatch(value: Record<string, unknown>): KeyPatch {
  rejectUnknown(value, { expectedVersion: true, name: true, expiresAt: true, policy: true }, "key");
  const expectedVersion = finiteNumber(value.expectedVersion, "expectedVersion");
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw new InvalidInput("expectedVersion must be a positive integer");
  }
  const draft = decodeKeyDraft({
    name: value.name,
    expiresAt: value.expiresAt,
    policy: value.policy,
  });
  return { ...draft, expectedVersion };
}

export function decodeRotateBody(value: Record<string, unknown>): { expectedVersion: number } {
  rejectUnknown(value, { expectedVersion: true }, "rotate");
  const expectedVersion = finiteNumber(value.expectedVersion, "expectedVersion");
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw new InvalidInput("expectedVersion must be a positive integer");
  }
  return { expectedVersion };
}

function decodeRouting(value: unknown, newId: () => string): RoutingHint {
  if (value === undefined) {
    return { sessionId: newId(), boundary: "new-task" };
  }
  const record = asRecord(value, "routing");
  rejectUnknown(record, ROUTING_KEYS, "routing");
  const sessionId =
    record.sessionId === undefined
      ? newId()
      : requireNonempty(record.sessionId, "routing.sessionId");
  let boundary: SessionBoundary = "new-task";
  if (record.boundary !== undefined) {
    if (
      typeof record.boundary !== "string" ||
      BOUNDARIES[record.boundary as SessionBoundary] !== true
    ) {
      throw new InvalidInput("routing.boundary is invalid");
    }
    boundary = record.boundary as SessionBoundary;
  }
  let taskBrief: string | undefined;
  if (record.taskBrief !== undefined) {
    if (typeof record.taskBrief !== "string" || record.taskBrief.length === 0) {
      throw new InvalidInput("routing.taskBrief must be a nonempty string");
    }
    if (record.taskBrief.length > CLASSIFIER_BRIEF_MAX_CHARS) {
      throw new InvalidInput("routing.taskBrief exceeds 24000 characters");
    }
    taskBrief = record.taskBrief;
  }
  return taskBrief === undefined
    ? { sessionId, boundary }
    : { sessionId, boundary, taskBrief, taskBriefSource: "caller-brief" };
}

function requireNonempty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidInput(`${label} must be a nonempty string`);
  }
  return value;
}

export function decodeChatCompletion(
  value: Record<string, unknown>,
  options: { newId: () => string },
): ChatCompletionRequest {
  rejectUnknown(value, REQUEST_KEYS, "request");
  if (value.model !== "auto") {
    throw new InvalidInput("model must be auto");
  }
  if (!Array.isArray(value.messages) || value.messages.length === 0) {
    throw new InvalidInput("messages must be a nonempty array");
  }
  const messages: ChatMessage[] = value.messages.map((item, index) => decodeMessage(item, index));
  const capabilities = validateToolSequence(messages);
  if (value.stream !== undefined && typeof value.stream !== "boolean") {
    throw new InvalidInput("stream must be a boolean");
  }
  if (value.max_tokens !== undefined && value.max_completion_tokens !== undefined) {
    throw new InvalidInput("provide only one of max_tokens or max_completion_tokens");
  }
  const maxField = value.max_completion_tokens ?? value.max_tokens;
  let maxCompletionTokens: number | undefined;
  if (maxField !== undefined) {
    maxCompletionTokens = finiteNumber(maxField, "max_completion_tokens");
    if (!Number.isInteger(maxCompletionTokens) || maxCompletionTokens < 1) {
      throw new InvalidInput("max_completion_tokens must be a positive integer");
    }
  }
  if (value.n !== undefined && value.n !== 1) throw new InvalidInput("Only n=1 is supported");
  if (value.stream_options !== undefined) {
    const streamOptions = asRecord(value.stream_options, "stream_options");
    rejectUnknown(streamOptions, { include_usage: true }, "stream_options");
    if (
      streamOptions.include_usage !== undefined &&
      typeof streamOptions.include_usage !== "boolean"
    )
      throw new InvalidInput("include_usage must be boolean");
  }
  const request: ChatCompletionRequest = {
    model: "auto",
    stream: value.stream === true,
    sampling: decodeSampling(value),
    messages,
    routing: decodeRouting(value.routing, options.newId),
  };
  if (value.tools !== undefined) {
    request.tools = decodeTools(value.tools);
    capabilities.tools = true;
  }
  if (value.tool_choice !== undefined) {
    request.tool_choice = value.tool_choice;
  }
  if (value.response_format !== undefined) {
    request.response_format = value.response_format;
    capabilities.json = true;
  }
  if (maxCompletionTokens !== undefined) {
    request.maxCompletionTokens = maxCompletionTokens;
  }
  return request;
}

export function classifierInputFor(
  request: ChatCompletionRequest,
  capabilities: RequestCapabilities,
  inputTokens: number,
): ClassifierInput {
  if (request.routing.taskBrief !== undefined) {
    return {
      source: "caller-brief",
      state: request.routing.taskBrief,
      advisory: true,
      inputTokens,
      tools: capabilities.tools || request.tools !== undefined,
      turns: capabilities.turns,
      pendingToolCalls: capabilities.pendingToolCalls,
    };
  }
  return {
    source: "full-input",
    state: serializeMessages(request.messages),
    advisory: false,
    inputTokens,
    tools: capabilities.tools || request.tools !== undefined,
    turns: capabilities.turns,
    pendingToolCalls: capabilities.pendingToolCalls,
  };
}

export function serializeMessages(messages: readonly ChatMessage[]): string {
  return JSON.stringify(
    messages.map((message) => ({
      role: message.role,
      content: message.content,
      tool_call_id: message.tool_call_id,
      tool_calls: message.tool_calls,
    })),
  );
}

export function requestCapabilities(request: ChatCompletionRequest): RequestCapabilities {
  const capabilities = validateToolSequence(request.messages);
  return {
    ...capabilities,
    tools: capabilities.tools || request.tools !== undefined,
    json: request.response_format !== undefined,
  };
}

export function decodedInputTokens(request: ChatCompletionRequest): number {
  return estimateInputTokens(request);
}
