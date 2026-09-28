#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  options: {
    native: { type: "boolean", default: false },
    "gufo-endpoint": { type: "string" },
  },
});
const envPath = path.join(root, values.native ? ".env.native" : ".env");
const catalogName = values.native ? "catalog.native.json" : "catalog.json";
const catalogPath = path.join(root, catalogName);
for (const file of [envPath, catalogPath]) {
  if (existsSync(file)) throw new Error(`Refusing to overwrite ${file}; edit it in place instead`);
}
for (const example of ["catalog.batch.example.json"])
  if (!existsSync(path.join(root, example)))
    throw new Error(
      `Missing ${example}; setup ships these examples and Compose binds them read-only`,
    );

/** Gufo's OpenAI base URL: HTTP(S), no credentials, query or fragment, ending in /v1. */
function gufoEndpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("--gufo-endpoint must be a valid HTTP(S) URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "--gufo-endpoint must be an HTTP(S) URL without credentials, query or fragment",
    );
  const base = url.pathname.replace(/\/+$/, "");
  url.pathname = base.endsWith("/v1") ? base : `${base}/v1`;
  return url.toString();
}

let body = readFileSync(path.join(root, ".env.example"), "utf8");
function setValue(name, value) {
  const pattern = new RegExp(`^${name}=.*$`, "m");
  if (!pattern.test(body)) body += `\n${name}=${value}\n`;
  else body = body.replace(pattern, `${name}=${value}`);
}
setValue("API_KEY_PEPPER", randomBytes(32).toString("base64url"));
setValue("WEBUI_SECRET_KEY", randomBytes(32).toString("base64url"));
if (values.native) {
  setValue("SQLITE_PATH", "./data/control.sqlite");
  setValue("MODEL_CATALOG", `./${catalogName}`);
  setValue("BATCH_CATALOG", "./catalog.batch.example.json");
}
setValue("MODEL_CATALOG_FILE", `./${catalogName}`);

const catalogue = JSON.parse(readFileSync(path.join(root, "catalog.example.json"), "utf8"));
const endpoint = values["gufo-endpoint"];
if (endpoint !== undefined)
  for (const deployment of catalogue)
    if (deployment.transport === "gufo") deployment.endpoint = gufoEndpoint(endpoint);

let createdEnv = false;
try {
  writeFileSync(envPath, body, { flag: "wx", mode: 0o600 });
  createdEnv = true;
  // Catalogue contains no credentials. Compose's non-root gateway must be able to read this bind mount.
  writeFileSync(catalogPath, `${JSON.stringify(catalogue, null, 2)}\n`, {
    flag: "wx",
    mode: values.native ? 0o600 : 0o644,
  });
} catch (error) {
  if (createdEnv && existsSync(envPath) && readFileSync(envPath, "utf8") === body)
    unlinkSync(envPath);
  throw error;
}
mkdirSync(path.join(root, "data"), { recursive: true, mode: 0o700 });
console.log(`Created ${path.basename(envPath)} (0600) and ${catalogName}.`);
console.log(
  "API-key pepper and WebUI secret generated; no secrets printed. Inference keys are created in the console.",
);
console.log(
  endpoint === undefined
    ? `Set the Gufo deployment's endpoint in ${catalogName} (or rerun with --gufo-endpoint); the router refuses the placeholder.`
    : `Gufo at ${gufoEndpoint(endpoint)}. Set GUFO_API_KEY in ${path.basename(envPath)} to its --api-key-file value.`,
);
console.log(
  values.native
    ? "Start the native gateway with this environment file."
    : "Start with docker compose up -d --build gateway.",
);
