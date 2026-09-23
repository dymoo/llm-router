import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import test from "node:test";
import { Schema } from "effect";
import { Catalogue } from "../src/domain.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "runtime-setup-"));
  mkdirSync(join(root, "scripts"));
  for (const file of ["setup.mjs", "runtime-catalog.mjs", "configure-runtime.mjs"])
    copyFileSync(`scripts/${file}`, join(root, "scripts", file));
  for (const file of [
    ".env.example",
    "catalog.example.json",
    "catalog.batch.example.json",
    "classifier-qualification.example.json",
  ])
    copyFileSync(file, join(root, file));
  return root;
}
function run(root: string, script: string, args: string[]) {
  return spawnSync(process.execPath, [join(root, "scripts", script), ...args], {
    cwd: root,
    encoding: "utf8",
  });
}
function hash(file: string) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}
function catalogue(file: string) {
  return Schema.decodeUnknownSync(Catalogue)(JSON.parse(readFileSync(file, "utf8")));
}

for (const runtime of ["llamacpp", "halogen"]) {
  test(`${runtime} setup pairs its Compose profile with the correct endpoint and model alias`, () => {
    const root = fixture();
    try {
      const result = run(root, "setup.mjs", ["--runtime", runtime]);
      assert.equal(result.status, 0, result.stderr);
      const env = parseEnv(readFileSync(join(root, ".env"), "utf8"));
      const configured = catalogue(join(root, "catalog.json"));
      const local = configured.find((item) => item.location === "local");
      assert.ok(local);
      assert.equal(local.transport, runtime);
      assert.equal(new URL(local.endpoint).hostname, runtime);
      assert.equal(
        local.modelId,
        env[runtime === "halogen" ? "HALOGEN_MODEL_ID" : "LLAMACPP_MODEL_ID"],
      );
      assert.equal(env.COMPOSE_PROFILES, runtime);
      assert.equal(
        configured.find((item) => item.location === "cloud")?.modelId,
        "z-ai/glm-5.3-flash",
      );
      assert.equal(statSync(join(root, ".env")).mode & 0o777, 0o600);
      assert.equal(result.stdout.includes(env.API_KEY_PEPPER!), false);
      const before = hash(join(root, ".env"));
      assert.notEqual(run(root, "setup.mjs", ["--runtime", runtime]).status, 0);
      assert.equal(hash(join(root, ".env")), before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("native and Compose setup do not overwrite each other's catalogue or secrets", () => {
  const root = fixture();
  try {
    assert.equal(run(root, "setup.mjs", ["--runtime", "halogen"]).status, 0);
    const beforeEnv = hash(join(root, ".env"));
    const beforeCatalogue = hash(join(root, "catalog.json"));
    const native = run(root, "setup.mjs", ["--native", "--runtime", "llamacpp-native"]);
    assert.equal(native.status, 0, native.stderr);
    assert.equal(hash(join(root, ".env")), beforeEnv);
    assert.equal(hash(join(root, "catalog.json")), beforeCatalogue);
    const env = parseEnv(readFileSync(join(root, ".env.native"), "utf8"));
    assert.equal(env.MODEL_CATALOG, "./catalog.native.json");
    assert.equal(env.BATCH_CATALOG, "./catalog.batch.example.json");
    assert.equal(env.CLASSIFIER_QUALIFICATION, undefined, "native qualification stays optional");
    assert.equal(
      new URL(catalogue(join(root, "catalog.native.json"))[0]!.endpoint).hostname,
      "127.0.0.1",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime switch preparation derives per-slot context and preserves the active configuration", () => {
  const root = fixture();
  try {
    assert.equal(run(root, "setup.mjs", ["--runtime", "halogen"]).status, 0);
    const envFile = join(root, ".env");
    writeFileSync(
      envFile,
      readFileSync(envFile, "utf8")
        .replace("LLAMACPP_CONTEXT=65536", "LLAMACPP_CONTEXT=32768")
        .replace("LLAMACPP_SLOTS=1", "LLAMACPP_SLOTS=2"),
    );
    const previous = hash(join(root, "catalog.json"));
    const prepared = run(root, "configure-runtime.mjs", [
      "llamacpp",
      "--out",
      "catalog.llamacpp.json",
    ]);
    assert.equal(prepared.status, 0, prepared.stderr);
    const local = catalogue(join(root, "catalog.llamacpp.json"))[0]!;
    assert.equal(local.contextLimitTokens, 16384);
    assert.equal(local.capacity.maxParallel, 2);
    assert.equal(hash(join(root, "catalog.json")), previous);
    assert.notEqual(
      run(root, "configure-runtime.mjs", ["llamacpp", "--out", "catalog.llamacpp.json"]).status,
      0,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unknown runtime selection fails before creating configuration", () => {
  const root = fixture();
  try {
    assert.notEqual(run(root, "setup.mjs", ["--runtime", "guess"]).status, 0);
    assert.equal(existsSync(join(root, ".env")), false);
    assert.equal(existsSync(join(root, "catalog.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compose setup selects the shipped batch catalogue and keeps sync/batch provider pins isolated", () => {
  const root = fixture();
  try {
    const shipped = join(root, "catalog.batch.example.json");
    const before = hash(shipped);
    assert.equal(run(root, "setup.mjs", ["--runtime", "llamacpp"]).status, 0);
    const env = parseEnv(readFileSync(join(root, ".env"), "utf8"));
    assert.equal(env.BATCH_CATALOG, "/etc/llm-router/batch-catalog.json");
    assert.equal(env.BATCH_CATALOG_FILE, "./catalog.batch.example.json");
    assert.equal(env.BATCH_RESULTS_DIR, undefined, "setup must not force a content-dir override");
    assert.equal(env.CLASSIFIER_QUALIFICATION_FILE, "./classifier-qualification.example.json");
    assert.equal(
      env.CLASSIFIER_QUALIFICATION,
      undefined,
      "setup must leave record selection to the operator; compose pins the container path itself",
    );
    assert.equal(env.OPENROUTER_API_KEY, undefined, "setup must never fabricate provider secrets");
    assert.equal(hash(shipped), before, "setup must not rewrite the shipped batch catalogue");

    const batch = catalogue(shipped);
    assert.equal(batch.length, 1);
    const spill = batch[0]!;
    assert.equal(spill.id, "cloud-glm-batch");
    assert.equal(spill.modelId, "z-ai/glm-5.3-flash");
    assert.equal(spill.endpoint, "https://openrouter.ai/api/v1");
    assert.equal(spill.transport, "openrouter");
    assert.equal(spill.credentialEnvVar, "OPENROUTER_API_KEY");
    assert.equal(spill.providerRestriction, "deepinfra/fp4");
    assert.equal(spill.contextLimitTokens, 1048576);
    assert.equal(spill.maxOutputTokens, 131072);
    assert.deepEqual(
      [
        spill.prices.inputUsdPerMillion,
        spill.prices.cachedInputUsdPerMillion,
        spill.prices.outputUsdPerMillion,
      ],
      [0.06, 0.012, 0.2],
    );

    // Sync/batch isolation: disjoint deployment ids keep per-key allowlists precise,
    // and the synchronous Sail FP8 pin must survive untouched.
    const chat = catalogue(join(root, "catalog.json"));
    assert.equal(
      chat.find((item) => item.id === "cloud-glm")?.providerRestriction,
      "sail-research/fp8",
    );
    assert.equal(
      chat.some((item) => item.id === "cloud-glm-batch"),
      false,
    );
    assert.equal(
      batch.some((item) => item.id === "cloud-glm"),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup fails before writing configuration when a shipped example is missing", () => {
  for (const missing of ["catalog.batch.example.json", "classifier-qualification.example.json"]) {
    const root = fixture();
    try {
      rmSync(join(root, missing));
      assert.notEqual(run(root, "setup.mjs", ["--runtime", "llamacpp"]).status, 0);
      assert.equal(existsSync(join(root, ".env")), false);
      assert.equal(existsSync(join(root, "catalog.json")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
