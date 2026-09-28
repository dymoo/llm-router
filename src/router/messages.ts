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
