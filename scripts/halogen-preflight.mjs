#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  options: { compose: { type: "boolean", default: false } },
  allowPositionals: true,
});
if (positionals.length > 1)
  throw new Error("usage: node scripts/halogen-preflight.mjs [--compose | <models-directory>]");
const checkpoint = "qwen38-flash-next-w4b.hgn";
const overlay = "qwen38-flash-next-w4b.overlay.hgn";
if (values.compose) {
  const code = `import os, pathlib, sys
paths = [pathlib.Path(os.environ['HALOGEN_CHECKPOINT']), pathlib.Path(os.environ['HALOGEN_CK_OVERLAY']), pathlib.Path(os.environ['HALOGEN_TOKENIZER']) / 'tokenizer.json']
for p in paths:
    if not p.is_file() or p.stat().st_size == 0:
        sys.exit('Missing required Halogen file: ' + str(p))
with paths[1].open('rb') as f:
    if b'mtp.fc_hidden.weight' not in f.read(262144):
        sys.exit('Quality overlay predates the current draft-head projections; fetch the matching sidecar')
print('Required checkpoint, current QUALITY overlay and tokenizer are present')`;
  const result = spawnSync(
    "docker",
    ["compose", "run", "--rm", "--no-deps", "--entrypoint", "python3", "halogen", "-c", code],
    { stdio: "inherit" },
  );
  if (result.error || result.status !== 0) process.exit(result.status ?? 1);
} else {
  const root = path.resolve(
    positionals[0] ??
      process.env.HALOGEN_MODELS_DIR ??
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "halogen-models"),
  );
  for (const name of [checkpoint, overlay, "tokenizer/tokenizer.json"]) {
    const file = path.join(root, name);
    if (!existsSync(file) || !statSync(file).isFile() || statSync(file).size === 0)
      throw new Error(`Missing required Halogen file: ${file}`);
  }
  const fd = openSync(path.join(root, overlay), "r");
  try {
    const header = Buffer.alloc(262144);
    const bytes = readSync(fd, header, 0, header.length, 0);
    if (!header.subarray(0, bytes).includes(Buffer.from("mtp.fc_hidden.weight")))
      throw new Error(
        "Quality overlay predates the current draft-head projections; fetch the matching sidecar",
      );
  } finally {
    closeSync(fd);
  }
  console.log("Required checkpoint, current QUALITY overlay and tokenizer are present.");
}
console.log(
  "File checks are not hardware, checksum, or model-quality validation. Confirm /health and a real request on the AMD host.",
);
