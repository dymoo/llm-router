import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { sanitizeStandalone } from "../scripts/sanitize-standalone.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "llm-router-standalone-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const standalone = join(directory, ".next", "standalone");
  await mkdir(standalone, { recursive: true });
  await writeFile(join(standalone, "server.js"), "server fixture");
  return { directory, standalone };
}

test("removes generated dotenv copies without changing source env or package fixtures", async (t) => {
  const { directory, standalone } = await fixture(t);
  const source = join(directory, ".env");
  await writeFile(source, "fixture-only");
  await writeFile(join(standalone, ".env"), "copied fixture");
  await writeFile(join(standalone, ".env.production"), "copied fixture");
  const packageFixture = join(standalone, "node_modules", "example", "test.sqlite");
  await mkdir(dirname(packageFixture), { recursive: true });
  await writeFile(packageFixture, "package fixture");

  await sanitizeStandalone(standalone);

  assert.equal(existsSync(join(standalone, ".env")), false);
  assert.equal(existsSync(join(standalone, ".env.production")), false);
  assert.equal(await readFile(source, "utf8"), "fixture-only");
  assert.equal(await readFile(packageFixture, "utf8"), "package fixture");
  assert.equal(existsSync(join(standalone, "server.js")), true);
});

test("refuses copied runtime data and leaves no shippable standalone output", async (t) => {
  const { directory, standalone } = await fixture(t);
  await mkdir(join(standalone, "data"));
  await writeFile(join(standalone, "data", "control.sqlite"), "fixture-only");
  const source = join(directory, "data", "control.sqlite");
  await mkdir(dirname(source));
  await writeFile(source, "original fixture");

  await assert.rejects(sanitizeStandalone(standalone), /project runtime state/);

  assert.equal(existsSync(standalone), false);
  assert.equal(await readFile(source, "utf8"), "original fixture");
});

test("refuses route traces pointing at project runtime state even if bytes were not copied", async (t) => {
  const { standalone } = await fixture(t);
  const trace = join(standalone, ".next", "server", "route.js.nft.json");
  await mkdir(dirname(trace), { recursive: true });
  await writeFile(trace, JSON.stringify({ version: 1, files: ["../../data/control.sqlite"] }));

  await assert.rejects(sanitizeStandalone(standalone), /trace references project runtime state/);
  assert.equal(existsSync(standalone), false);
});
