#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, parseEnv } from "node:util";
import { RUNTIME_CHOICES, runtimeConfiguration } from "./runtime-catalog.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { values, positionals } = parseArgs({
  options: {
    out: { type: "string" },
    "env-file": { type: "string", default: ".env" },
    "native-gateway": { type: "boolean", default: false },
  },
  allowPositionals: true,
});
if (positionals.length !== 1 || !RUNTIME_CHOICES.includes(positionals[0])) {
  throw new Error(
    `usage: node scripts/configure-runtime.mjs ${RUNTIME_CHOICES.join("| ")} [--out catalog.runtime.json] [--env-file .env] [--native-gateway]`,
  );
}
const runtime = positionals[0];
const envPath = path.resolve(values["env-file"]);
if (!existsSync(envPath))
  throw new Error("Create the selected environment file with setup.mjs first");
const config = runtimeConfiguration(
  JSON.parse(readFileSync(path.join(root, "catalog.example.json"), "utf8")),
  runtime,
  parseEnv(readFileSync(envPath, "utf8")),
  values["native-gateway"],
);
const destination = path.resolve(values.out ?? `catalog.${runtime}.json`);
writeFileSync(destination, `${JSON.stringify(config.catalogue, null, 2)}\n`, {
  flag: "wx",
  mode: values["native-gateway"] ? 0o600 : 0o644,
});
console.log(`Created ${destination}; existing catalogues and secrets were not overwritten.`);
if (values["native-gateway"]) {
  console.log(`Set MODEL_CATALOG=${destination} in the native gateway environment and restart it.`);
} else {
  console.log(`Set MODEL_CATALOG_FILE=${path.relative(root, destination)} in .env.`);
  console.log(
    config.profile
      ? `Select only the ${config.profile} GPU profile. Drain the gateway and stop the other GPU runtime before switching.`
      : "No Compose GPU profile is needed for this choice.",
  );
}
console.log(
  "Reconcile model aliases, runtime limits and key allowlists after discovery. Quality/latency values are bootstrap priors; local accounting rates remain unknown until configured.",
);
