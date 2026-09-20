export function assertCompletionBody(body: unknown): void {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw Object.assign(new Error("provider returned an invalid body"), {
      _tag: "ProviderFailure",
    });
  }
  const record = body as Record<string, unknown>;
  if (record.error !== undefined) {
    throw Object.assign(new Error("provider returned an error"), { _tag: "ProviderFailure" });
  }
  if (!Array.isArray(record.choices) || record.choices.length === 0) {
    throw Object.assign(new Error("provider returned no choices"), { _tag: "ProviderFailure" });
  }
}
