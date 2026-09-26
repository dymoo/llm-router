import { Schema } from "effect";
import { KeyPolicy as DomainKeyPolicy } from "../domain.ts";
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
  store: true,
  parallel_tool_calls: true,
  user: true,
  metadata: true,
  service_tier: true,
  prompt_cache_key: true,
  safety_identifier: true,
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
  overloadAction: true,
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

export function decodeKeyPolicy(value: unknown): KeyPolicy {
  const record = asRecord(value, "policy");
  rejectUnknown(record, POLICY_KEYS, "policy");
  const bias = asRecord(record.bias, "policy.bias");
  rejectUnknown(bias, { cost: true, quality: true, latency: true }, "policy.bias");
  if (
    record.overloadAction !== undefined &&
    record.overloadAction !== "report" &&
    record.overloadAction !== "failover"
  ) {
    throw new InvalidInput("policy.overloadAction is invalid");
  }
  try {
    return Schema.decodeUnknownSync(DomainKeyPolicy)({
      ...record,
      allowedModels: record.allowedModels ?? null,
    });
  } catch {
    throw new InvalidInput("policy violates configured limits");
  }
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
  const { overloadAction: _default, ...legacyPolicy } = draft.policy;
  const policy = Object.hasOwn(asRecord(value.policy, "policy"), "overloadAction")
    ? draft.policy
    : legacyPolicy;
  return { ...draft, policy, expectedVersion };
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

function decodeToolChoice(value: unknown): unknown {
  if (value === "auto" || value === "none" || value === "required") return value;
  const choice = asRecord(value, "tool_choice");
  rejectUnknown(choice, { type: true, function: true }, "tool_choice");
  if (choice.type !== "function") throw new InvalidInput("tool_choice.type must be function");
  const fn = asRecord(choice.function, "tool_choice.function");
  rejectUnknown(fn, { name: true }, "tool_choice.function");
  requireNonempty(fn.name, "tool_choice.function.name");
  return value;
}

function decodeResponseFormat(value: unknown): unknown {
  const format = asRecord(value, "response_format");
  rejectUnknown(format, { type: true, json_schema: true }, "response_format");
  if (format.type === "text" || format.type === "json_object") {
    if (format.json_schema !== undefined) {
      throw new InvalidInput("json_schema requires response_format.type json_schema");
    }
    return value;
  }
  if (format.type !== "json_schema") {
    throw new InvalidInput("response_format.type is invalid");
  }
  const definition = asRecord(format.json_schema, "response_format.json_schema");
  rejectUnknown(
    definition,
    { name: true, schema: true, strict: true, description: true },
    "response_format.json_schema",
  );
  requireNonempty(definition.name, "response_format.json_schema.name");
  asRecord(definition.schema, "response_format.json_schema.schema");
  if (definition.strict !== undefined && typeof definition.strict !== "boolean") {
    throw new InvalidInput("response_format.json_schema.strict must be a boolean");
  }
  if (definition.description !== undefined && typeof definition.description !== "string") {
    throw new InvalidInput("response_format.json_schema.description must be a string");
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
  if (value.store !== undefined && typeof value.store !== "boolean") {
    throw new InvalidInput("store must be a boolean");
  }
  if (value.parallel_tool_calls !== undefined && typeof value.parallel_tool_calls !== "boolean") {
    throw new InvalidInput("parallel_tool_calls must be a boolean");
  }
  for (const key of ["user", "service_tier", "prompt_cache_key", "safety_identifier"]) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      throw new InvalidInput(`${key} must be a string`);
    }
  }
  if (value.metadata !== undefined) {
    const metadata = asRecord(value.metadata, "metadata");
    if (Object.values(metadata).some((item) => typeof item !== "string")) {
      throw new InvalidInput("metadata values must be strings");
    }
  }
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
    parallelToolCalls: value.parallel_tool_calls as boolean | undefined,
  };
  if (value.tools !== undefined) {
    request.tools = decodeTools(value.tools);
    capabilities.tools = true;
  }
  if (value.tool_choice !== undefined) {
    request.tool_choice = decodeToolChoice(value.tool_choice);
  }
  if (value.response_format !== undefined) {
    const responseFormat = decodeResponseFormat(value.response_format);
    // `text` is the OpenAI default; omit it so adapters without format controls stay eligible.
    if ((responseFormat as { type: string }).type !== "text") {
      request.response_format = responseFormat;
      capabilities.json = true;
    }
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
    json:
      request.response_format !== undefined &&
      (request.response_format as { type: string }).type !== "text",
  };
}

export function decodedInputTokens(request: ChatCompletionRequest): number {
  return estimateInputTokens(request);
}
