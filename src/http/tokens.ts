import type { ChatCompletionRequest } from "./contracts.ts";
import { BYTES_PER_TOKEN, MESSAGE_TOKEN_OVERHEAD, TOKEN_ESTIMATE_RESERVE } from "./limits.ts";

export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function estimateInputTokens(
  request: Pick<ChatCompletionRequest, "messages" | "tools" | "tool_choice" | "response_format">,
): number {
  let bytes = 0;
  let overhead = TOKEN_ESTIMATE_RESERVE;
  for (const message of request.messages) {
    overhead += MESSAGE_TOKEN_OVERHEAD;
    bytes += utf8Bytes(JSON.stringify(message));
  }
  for (const extra of [request.tools, request.tool_choice, request.response_format]) {
    if (extra !== undefined) bytes += utf8Bytes(JSON.stringify(extra));
  }
  // ponytail: 2 bytes per token overestimates English, code and JSON (3-4) and
  // CJK text (~3), so a prompt judged to fit does fit; a byte per token refused
  // agent sessions at a quarter of the context. Use the tokenizer if it is ever
  // too loose.
  return overhead + Math.ceil(bytes / BYTES_PER_TOKEN);
}
