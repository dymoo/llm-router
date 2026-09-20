#!/usr/bin/env node
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GUIDE_COMMIT = "f73872fe20dfdef460653f18e2fe63e5366ae958";
const FILES = [
  {
    name: "install.sh",
    sha256: "b339476d3db30b1c70feea175c2dd2eb8abad4cce0bfba1b5777542174a1d1e0",
  },
  {
    name: "install-flash-next.sh",
    sha256: "7fd25b554afcbe76d33b932ca07daadac2166b581c8d8861ea379b45778a0dc8",
  },
];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destDir = path.join(root, "third_party", "strix-halo", GUIDE_COMMIT);
mkdirSync(destDir, { recursive: true, mode: 0o755 });

for (const file of FILES) {
  const url = `https://raw.githubusercontent.com/pwilkin/strix-halo/${GUIDE_COMMIT}/${file.name}`;
  const response = await fetch(url);
  if (!response.ok) {
    console.error(`failed to fetch ${url}: ${response.status}`);
    process.exit(1);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== file.sha256) {
    console.error(`${file.name} checksum mismatch: got ${digest} expected ${file.sha256}`);
    process.exit(1);
  }
  const dest = path.join(destDir, file.name);
  writeFileSync(dest, bytes, { mode: 0o644 });
  chmodSync(dest, 0o644);
  console.log(`verified ${file.name} ${digest} -> ${path.relative(root, dest)}`);
}

console.log("Inspect the scripts. Do not pipe them from the network. On the AMD Linux host:");
console.log(
  `  bash third_party/strix-halo/${GUIDE_COMMIT}/install.sh --skip-packages --check-only`,
);
console.log(`  STRIX_PROFILE=flash-next bash third_party/strix-halo/${GUIDE_COMMIT}/install.sh`);
console.log("This fetch does not execute the installer.");
