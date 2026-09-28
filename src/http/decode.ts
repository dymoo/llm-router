import { Schema } from "effect";
import { type AppAttribution, KeyPolicy as DomainKeyPolicy } from "../domain.ts";
import { decodeSampling, SAMPLING_FIELDS } from "../sampling.ts";
import type {
  ChatCompletionRequest,
  ChatMessage,
  KeyDraft,
  KeyPatch,
  KeyPolicy,
  ReasoningEffort,
  RequestCapabilities,
} from "./contracts.ts";
import { InvalidInput } from "./errors.ts";
import { decodeMessage, decodeTools, validateToolSequence } from "./protocol.ts";

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
  reasoning_effort: true,
  prompt_cache_key: true,
  safety_identifier: true,
  ...Object.fromEntries(SAMPLING_FIELDS.map((key) => [key, true as const])),
};

/** `boundary`, `taskBrief` and `qualityOverride` are older clients' session protocol:
 * accepted and ignored. */
const ROUTING_KEYS: Record<string, true> = {
  sessionId: true,
  boundary: true,
  taskBrief: true,
  qualityOverride: true,
};

const REASONING_EFFORTS: Record<string, ReasoningEffort> = {
  none: "none",
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
};

const POLICY_KEYS: Record<string, true> = {
  priority: true,
  cloud: true,
  requestsPerMinute: true,
  maxConcurrent: true,
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
  try {
    return Schema.decodeUnknownSync(DomainKeyPolicy)(record);
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

/** The client's session id, if any. Other `routing` fields are accepted and ignored. */
function decodeSessionId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const record = asRecord(value, "routing");
  rejectUnknown(record, ROUTING_KEYS, "routing");
  if (record.sessionId === undefined) return undefined;
  const sessionId = requireNonempty(record.sessionId, "routing.sessionId");
  // Session ids go into a response header and the in-memory session store: a
  // lone surrogate cannot be encoded, and size is bounded.
  if (sessionId.length > 256 || !sessionId.isWellFormed())
    throw new InvalidInput("routing.sessionId must be well-formed and at most 256 characters");
  return sessionId;
}

function decodeReasoningEffort(value: unknown): ReasoningEffort | undefined {
  if (value === undefined || value === null) return undefined;
  const effort = typeof value === "string" ? REASONING_EFFORTS[value] : undefined;
  if (effort === undefined) {
    throw new InvalidInput("reasoning_effort must be none, minimal, low, medium, high or xhigh");
  }
  return effort;
}

/** Header values are byte strings (≤ U+00FF); this matches C0, DEL and C1 controls. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
/** OpenRouter's documented category format: lowercase, hyphen-separated. */
const APP_CATEGORY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The client app's OpenRouter attribution headers. Each invalid value is
 * ignored, never rejected: attribution is advisory and must not fail a request.
 * Categories and visibility only count alongside a url or title.
 */
export function decodeAppAttribution(headers: Headers): AppAttribution | undefined {
  const url = appUrl(headers.get("http-referer"));
  const title = appTitle(headers.get("x-openrouter-title")) ?? appTitle(headers.get("x-title"));
  if (url === undefined && title === undefined) return undefined;
  const categories = appCategories(headers.get("x-openrouter-categories"));
  const hidden = headers.get("x-openrouter-app-visibility")?.trim() === "hidden";
  return {
    ...(url === undefined ? {} : { url }),
    ...(title === undefined ? {} : { title }),
    ...(categories === undefined ? {} : { categories }),
    ...(hidden ? { visibility: "hidden" as const } : {}),
  };
}

function appUrl(value: string | null): string | undefined {
  const text = value?.trim() ?? "";
  if (text.length === 0 || text.length > 512 || /\s/.test(text) || CONTROL_CHARS.test(text))
    return undefined;
  const url = URL.parse(text);
  return url !== null &&
    (url.protocol === "https:" || url.protocol === "http:") &&
    url.username === "" &&
    url.password === ""
    ? text
    : undefined;
}

function appTitle(value: string | null): string | undefined {
  const text = value?.trim() ?? "";
  return text.length >= 1 && text.length <= 128 && !CONTROL_CHARS.test(text) ? text : undefined;
}

function appCategories(value: string | null): string | undefined {
  if (value === null) return undefined;
  const parts = value.split(",").map((part) => part.trim());
  return parts.length <= 2 && parts.every((part) => part.length <= 30 && APP_CATEGORY.test(part))
    ? parts.join(",")
    : undefined;
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

export function decodeChatCompletion(value: Record<string, unknown>): ChatCompletionRequest {
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
    parallelToolCalls: value.parallel_tool_calls as boolean | undefined,
  };
  const sessionId = decodeSessionId(value.routing);
  if (sessionId !== undefined) request.sessionId = sessionId;
  const reasoningEffort = decodeReasoningEffort(value.reasoning_effort);
  if (reasoningEffort !== undefined) request.reasoningEffort = reasoningEffort;
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
  // Other OpenAI tiers (auto, default, scale, priority) are accepted and served normally.
  if (value.service_tier === "flex") request.serviceTier = "flex";
  return request;
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
