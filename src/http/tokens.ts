import type { ChatCompletionRequest } from "./contracts.ts";
import { MESSAGE_TOKEN_OVERHEAD, TOKEN_ESTIMATE_RESERVE } from "./limits.ts";

export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function estimateInputTokens(
  request: Pick<ChatCompletionRequest, "messages" | "tools" | "tool_choice" | "response_format">,
): number {
  let total = TOKEN_ESTIMATE_RESERVE;
  for (const message of request.messages) {
    total += MESSAGE_TOKEN_OVERHEAD;
    total += utf8Bytes(JSON.stringify(message));
  }
  for (const extra of [request.tools, request.tool_choice, request.response_format]) {
    if (extra !== undefined) total += utf8Bytes(JSON.stringify(extra));
  }
  return total;
}
