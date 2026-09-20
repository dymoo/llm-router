export interface ChatMessage {
  readonly role: string;
  readonly content?: unknown;
  readonly name?: string;
  readonly tool_calls?: unknown;
  readonly tool_call_id?: string;
  readonly reasoning?: unknown;
  readonly reasoning_content?: unknown;
  readonly reasoning_details?: unknown;
}

export function serializeMessages(messages: readonly ChatMessage[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    parts.push(message.role);
    if (typeof message.content === "string") {
      parts.push(message.content);
    } else if (message.content !== undefined) {
      parts.push(JSON.stringify(message.content));
    }
    if (message.tool_calls !== undefined) {
      parts.push(JSON.stringify(message.tool_calls));
    }
    if (message.reasoning !== undefined) {
      parts.push(JSON.stringify(message.reasoning));
    }
    if (message.reasoning_content !== undefined) {
      parts.push(JSON.stringify(message.reasoning_content));
    }
    if (message.reasoning_details !== undefined) {
      parts.push(JSON.stringify(message.reasoning_details));
    }
  }
  return parts.join("\n");
}
