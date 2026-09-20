export const RUNTIME_CHOICES = ["llamacpp-native", "llamacpp", "halogen", "cloud"];

function integer(env, name, fallback, max = 1_048_576) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }
  return value;
}

function endpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Runtime endpoint must be a valid HTTP(S) URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Runtime endpoint must be an HTTP(S) URL without credentials, query or fragment",
    );
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  if (!url.pathname.endsWith("/v1")) url.pathname += "/v1";
  return url.toString().replace(/\/$/, "");
}

/** One cloud template and one shared local template; runtime selection changes only explicit runtime facts. */
export function runtimeConfiguration(template, runtime, env = {}, nativeGateway = false) {
  if (!RUNTIME_CHOICES.includes(runtime))
    throw new Error(`Choose --runtime ${RUNTIME_CHOICES.join(" | ")}`);
  const cloud = template.filter((deployment) => deployment.location === "cloud");
  if (runtime === "cloud") return { catalogue: cloud, profile: "" };
  const local = template.find((deployment) => deployment.location === "local");
  if (!local) throw new Error("Catalogue template has no local deployment");
  const halogen = runtime === "halogen";
  const slots = integer(env, halogen ? "HALOGEN_KV_SLOTS" : "LLAMACPP_SLOTS", halogen ? 4 : 1, 64);
  const context = integer(
    env,
    halogen ? "HALOGEN_CTX" : "LLAMACPP_CONTEXT",
    halogen ? 262144 : 65536,
  );
  const modelId =
    env[halogen ? "HALOGEN_MODEL_ID" : "LLAMACPP_MODEL_ID"] ||
    (halogen ? "halogen-qwen3.8-flash-next" : "local-llamacpp");
  if (!/^[a-zA-Z0-9._/:+-]{1,128}$/.test(modelId))
    throw new Error("Runtime model ID must be one nonempty model alias, not a list");
  const defaultEndpoint = halogen
    ? nativeGateway
      ? "http://127.0.0.1:8731/v1"
      : "http://halogen:8731/v1"
    : runtime === "llamacpp" && !nativeGateway
      ? "http://llamacpp:8080/v1"
      : nativeGateway
        ? "http://127.0.0.1:8080/v1"
        : "http://host.docker.internal:8080/v1";
  const contextLimitTokens = halogen ? context : Math.floor(context / slots);
  if (contextLimitTokens < 512)
    throw new Error("Configured context must leave at least 512 tokens per runtime slot");
  const maxOutputTokens = integer(
    env,
    halogen ? "HALOGEN_MAX_TOKENS_CAP" : "LLAMACPP_MAX_OUTPUT_TOKENS",
    halogen ? 65536 : 8192,
  );
  const configured = {
    ...local,
    id: halogen ? "local-halogen" : "local-llamacpp",
    modelId,
    endpoint: endpoint(env[halogen ? "HALOGEN_ENDPOINT" : "LLAMACPP_ENDPOINT"] || defaultEndpoint),
    transport: halogen ? "halogen" : "llamacpp",
    contextLimitTokens,
    maxOutputTokens,
    capabilities: { tools: true, json: true, vision: false },
    capacity: { maxParallel: slots, reservedInteractiveSlots: 0 },
    quality: {
      chat: 0.7,
      coding: 0.7,
      math: 0.7,
      analysis: 0.7,
      writing: 0.7,
      extraction: 0.7,
      provenance: {
        unit: "prior",
        source: "operator-bootstrap-ranking-prior-not-a-benchmark",
        asOf: null,
      },
    },
    latency: {
      initialMs: 1000,
      tokensPerSecond: 30,
      provenance: {
        unit: "tokens-per-second",
        source: "operator-bootstrap-latency-prior-not-measured",
        asOf: null,
      },
    },
    reasoning: { kind: "graded", levels: ["none", "low", "medium", "xhigh"] },
    reasoningTokenEstimates: { none: 0, low: 1024, medium: 4096, high: 8192, xhigh: 16384 },
  };
  return {
    catalogue: [configured, ...cloud],
    profile: runtime === "llamacpp-native" ? "" : runtime,
  };
}
