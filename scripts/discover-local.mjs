#!/usr/bin/env node
const input =
  process.argv[2] ?? process.env.LLAMACPP_ENDPOINT ?? "http://host.docker.internal:8080";
try {
  const url = new URL(input);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Use an HTTP endpoint without credentials, query or fragment.");
  url.pathname = url.pathname.replace(/\/v1\/?$/, "").replace(/\/$/, "");
  const base = url.toString().replace(/\/$/, "");
  const get = async (path, timeout) => {
    try {
      const response = await fetch(base + path, {
        signal: AbortSignal.timeout(timeout),
        redirect: "error",
      });
      const json = await response.json();
      return { ok: response.ok, status: response.status, json };
    } catch {
      return { ok: false, status: null, json: null };
    }
  };
  const [health, models] = await Promise.all([get("/health", 3000), get("/v1/models", 5000)]);
  const ids = Array.isArray(models.json?.data)
    ? models.json.data.flatMap((item) => (typeof item?.id === "string" && item.id ? [item.id] : []))
    : [];
  const ready = health.ok;
  const listed = models.ok && ids.length > 0;
  console.log(
    JSON.stringify(
      {
        endpoint: base + "/v1",
        transport: "llamacpp",
        healthOk: ready,
        healthStatus: health.status,
        health: health.json,
        modelsOk: listed,
        modelsStatus: models.status,
        modelIds: ids,
        models: models.json,
        unverified: [
          "No catalogue was modified.",
          "Confirm actual model/template capabilities and launch limits before serving traffic.",
          "Quality, prices and throughput require separate operator configuration or measurement.",
        ],
      },
      null,
      2,
    ),
  );
  if (!ready || !listed) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : "Runtime discovery failed.");
  process.exitCode = 1;
}
