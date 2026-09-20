import type {
  ChatMessage,
  ChatRole,
  RequestCapabilities,
  TextPart,
  ToolCall,
  ToolDefinition,
} from "./contracts.ts";
import { InvalidInput } from "./errors.ts";

const ROLES: Record<ChatRole, true> = {
  system: true,
  developer: true,
  user: true,
  assistant: true,
  tool: true,
};

const MESSAGE_KEYS: Record<string, true> = {
  role: true,
  content: true,
  name: true,
  tool_call_id: true,
  tool_calls: true,
  reasoning: true,
  reasoning_content: true,
  reasoning_details: true,
};

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidInput(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidInput(`${label} must be a nonempty string`);
  }
  return value;
}

function rejectUnknownKeys(
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

function decodeTextParts(value: unknown): TextPart[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new InvalidInput("message content array must contain text parts");
  }
  const parts: TextPart[] = [];
  for (const item of value) {
    const part = requireObject(item, "content part");
    if (part.type !== "text") {
      throw new InvalidInput("only text content parts are supported");
    }
    if (typeof part.text !== "string") {
      throw new InvalidInput("text content part is required");
    }
    parts.push({ type: "text", text: part.text });
  }
  return parts;
}

function decodeContent(value: unknown, role: ChatRole): string | TextPart[] | null {
  if (value === null) {
    if (role !== "assistant") {
      throw new InvalidInput(`${role} message content is required`);
    }
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  return decodeTextParts(value);
}

function decodeToolCalls(value: unknown): ToolCall[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new InvalidInput("tool_calls must be a nonempty array");
  }
  const calls: ToolCall[] = [];
  const seen: Record<string, true> = {};
  for (const item of value) {
    const call = requireObject(item, "tool_call");
    rejectUnknownKeys(call, { id: true, type: true, function: true, index: true }, "tool_call");
    const id = requireString(call.id, "tool_call.id");
    if (seen[id] === true) {
      throw new InvalidInput("tool_call ids must be unique");
    }
    seen[id] = true;
    if (call.type !== "function") {
      throw new InvalidInput("only function tool calls are supported");
    }
    const fn = requireObject(call.function, "tool_call.function");
    calls.push({
      id,
      type: "function",
      function: {
        name: requireString(fn.name, "tool_call.function.name"),
        arguments:
          typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
      },
    });
  }
  return calls;
}

export function decodeMessage(value: unknown, index: number): ChatMessage {
  const record = requireObject(value, `messages[${index}]`);
  rejectUnknownKeys(record, MESSAGE_KEYS, `messages[${index}]`);
  const role = record.role;
  if (typeof role !== "string" || ROLES[role as ChatRole] !== true) {
    throw new InvalidInput(`messages[${index}] has unsupported role`);
  }
  const typedRole = role as ChatRole;
  const message: ChatMessage = {
    role: typedRole,
    content: decodeContent(record.content, typedRole),
  };
  if (record.name !== undefined) {
    message.name = requireString(record.name, `messages[${index}].name`);
  }
  if (typedRole === "tool") {
    message.tool_call_id = requireString(record.tool_call_id, `messages[${index}].tool_call_id`);
    if (record.tool_calls !== undefined) {
      throw new InvalidInput("tool messages cannot include tool_calls");
    }
    if (message.content === null) {
      throw new InvalidInput("tool message content is required");
    }
    return message;
  }
  if (record.tool_call_id !== undefined) {
    throw new InvalidInput(`messages[${index}] tool_call_id is only valid on tool messages`);
  }
  if (record.tool_calls !== undefined) {
    if (typedRole !== "assistant") {
      throw new InvalidInput("tool_calls are only valid on assistant messages");
    }
    message.tool_calls = decodeToolCalls(record.tool_calls);
  }
  if (record.reasoning !== undefined) {
    message.reasoning = record.reasoning;
  }
  if (record.reasoning_content !== undefined) {
    message.reasoning_content = record.reasoning_content;
  }
  if (record.reasoning_details !== undefined) {
    message.reasoning_details = record.reasoning_details;
  }
  if (typedRole === "assistant" && message.content === null && message.tool_calls === undefined) {
    throw new InvalidInput("assistant message requires content or tool_calls");
  }
  return message;
}

export function validateToolSequence(messages: readonly ChatMessage[]): RequestCapabilities {
  let pending: string[] = [];
  let turns = 0;
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]!;
    if (message.role === "tool") {
      if (pending.length === 0) {
        throw new InvalidInput("orphan tool message");
      }
      const callId = message.tool_call_id;
      const idx = pending.indexOf(callId ?? "");
      if (idx < 0) {
        throw new InvalidInput("tool message does not match a pending tool call");
      }
      pending.splice(idx, 1);
      continue;
    }
    if (pending.length > 0) {
      throw new InvalidInput("unanswered tool calls must be resolved before the next message");
    }
    if (message.role === "user") {
      turns += 1;
    }
    if (message.role === "assistant" && message.tool_calls !== undefined) {
      pending = message.tool_calls.map((call) => call.id);
    }
  }
  return {
    tools: messages.some((message) => message.tool_calls !== undefined || message.role === "tool"),
    json: false,
    vision: false,
    pendingToolCalls: pending.length,
    turns,
  };
}

export function decodeTools(value: unknown): ToolDefinition[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new InvalidInput("tools must be a nonempty array");
  }
  const tools: ToolDefinition[] = [];
  for (const item of value) {
    const record = requireObject(item, "tool");
    if (record.type !== "function") {
      throw new InvalidInput("only function tools are supported");
    }
    const fn = requireObject(record.function, "tool.function");
    tools.push({
      type: "function",
      function: {
        name: requireString(fn.name, "tool.function.name"),
        description: typeof fn.description === "string" ? fn.description : undefined,
        parameters: fn.parameters,
      },
    });
  }
  return tools;
}

export function countPendingToolCalls(messages: readonly ChatMessage[]): number {
  return validateToolSequence(messages).pendingToolCalls;
}
