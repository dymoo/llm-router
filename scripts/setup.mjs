#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, parseEnv } from "node:util";
import { runtimeConfiguration } from "./runtime-catalog.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  options: {
    native: { type: "boolean", default: false },
    runtime: { type: "string", default: "llamacpp-native" },
  },
});
const envPath = path.join(root, values.native ? ".env.native" : ".env");
const catalogName = values.native ? "catalog.native.json" : "catalog.json";
const catalogPath = path.join(root, catalogName);
for (const file of [envPath, catalogPath]) {
  if (existsSync(file))
    throw new Error(
      `Refusing to overwrite ${file}; use configure-runtime.mjs with a new output path when switching runtimes`,
    );
}
for (const example of ["catalog.batch.example.json", "classifier-qualification.example.json"])
  if (!existsSync(path.join(root, example)))
    throw new Error(
      `Missing ${example}; setup ships these examples and Compose binds them read-only`,
    );
let body = readFileSync(path.join(root, ".env.example"), "utf8");
function setValue(name, value) {
  const pattern = new RegExp(`^${name}=.*$`, "m");
  if (!pattern.test(body)) body += `\n${name}=${value}\n`;
  else body = body.replace(pattern, `${name}=${value}`);
}
setValue("API_KEY_PEPPER", randomBytes(32).toString("base64url"));
setValue("WEBUI_SECRET_KEY", randomBytes(32).toString("base64url"));
if (values.native) {
  for (const [name, value] of Object.entries({
    SQLITE_PATH: "./data/control.sqlite",
    MODEL_CATALOG: `./${catalogName}`,
    BATCH_CATALOG: "./catalog.batch.example.json",
    LAYA_URL: "http://127.0.0.1:8090",
    LAYA_HOST: "127.0.0.1",
    LAYA_CACHE_DIR: "./data/laya-cache",
    LAYA_ONNX_PATH: "./data/laya-cache/onnx/laya.onnx",
    LAYA_EP_CONTEXT_DIR: "./data/laya-cache/ep-context",
  }))
    setValue(name, value);
}
if (process.platform === "linux") {
  for (const [name, device] of [
    ["GPU_RENDER_GID", "/dev/kfd"],
    ["GPU_VIDEO_GID", "/dev/dri/card0"],
  ]) {
    if (existsSync(device)) setValue(name, String(statSync(device).gid));
  }
}
const config = runtimeConfiguration(
  JSON.parse(readFileSync(path.join(root, "catalog.example.json"), "utf8")),
  values.runtime,
  parseEnv(body),
  values.native,
);
setValue("COMPOSE_PROFILES", config.profile);
setValue("MODEL_CATALOG_FILE", `./${catalogName}`);
let createdEnv = false;
try {
  writeFileSync(envPath, body, { flag: "wx", mode: 0o600 });
  createdEnv = true;
  // Catalogue contains no credentials. Compose's non-root gateway must be able to read this bind mount.
  writeFileSync(catalogPath, `${JSON.stringify(config.catalogue, null, 2)}\n`, {
    flag: "wx",
    mode: values.native ? 0o600 : 0o644,
  });
} catch (error) {
  if (createdEnv && existsSync(envPath) && readFileSync(envPath, "utf8") === body)
    unlinkSync(envPath);
  throw error;
}
mkdirSync(path.join(root, "data"), { recursive: true, mode: 0o700 });
if (values.native) {
  mkdirSync(path.join(root, "data/laya-cache/onnx"), { recursive: true, mode: 0o700 });
  mkdirSync(path.join(root, "data/laya-cache/ep-context"), { recursive: true, mode: 0o700 });
}
console.log(`Created ${path.basename(envPath)} (0600) and ${catalogName} for ${values.runtime}.`);
console.log(
  "API-key pepper and WebUI secret generated; no secrets printed. Inference keys are created in the console.",
);
if (values.runtime === "halogen")
  console.log(
    "Halogen profile selected: first start may download about 118 GiB. The QUALITY overlay is required. Keep IOMMU enabled when using the NPU.",
  );
if (values.runtime === "llamacpp")
  console.log(
    "Set LLAMACPP_MODELS_DIR and LLAMACPP_MODEL_FILE before starting the llama.cpp profile. Use a compatible GGUF on local SSD.",
  );
if (values.runtime === "llamacpp-native")
  console.log(
    "Start the native llama-server with --alias local-llamacpp, or set LLAMACPP_MODEL_ID and regenerate the catalogue.",
  );
console.log(
  values.native
    ? "Start the native gateway with this environment file; runtime endpoints must be reachable from the host."
    : "Start with docker compose up -d --build. Never enable both GPU runtime profiles on the same full-size-model host.",
);
console.log(
  "Quality/latency entries are editable bootstrap priors, not measurements. Configure local accounting rates and verify runtime limits before production use.",
);
