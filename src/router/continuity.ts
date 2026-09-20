import { createHash } from "node:crypto";
import type { ChatMessage } from "./messages.ts";

export function continuityKey(input: {
  readonly messages: readonly ChatMessage[];
  readonly tools: unknown;
  readonly toolChoice: unknown;
  readonly responseFormat: unknown;
}): string {
  const stable = {
    system: input.messages.filter(
      (message) => message.role === "system" || message.role === "developer",
    ),
    tools: input.tools ?? null,
    toolChoice: input.toolChoice ?? null,
    responseFormat: input.responseFormat ?? null,
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}
