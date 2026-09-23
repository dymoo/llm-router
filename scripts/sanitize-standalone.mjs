import { lstat, readFile, readdir, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const defaultStandalone = fileURLToPath(new URL("../.next/standalone", import.meta.url));

function isPrivateProjectPath(standalone, candidate) {
  const path = relative(standalone, candidate);
  if (!path || path === ".." || path.startsWith(`..${sep}`)) return false;
  const [root] = path.split(sep);
  return (
    root.startsWith(".env") ||
    root === "data" ||
    root === "backups" ||
    /\.(?:sqlite|db)(?:-(?:wal|shm))?$|\.bak$/.test(root)
  );
}

/** Keep generated standalone output free of local runtime state before it can be shipped. */
export async function sanitizeStandalone(directory = defaultStandalone) {
  const standalone = resolve(directory);
  if (basename(standalone) !== "standalone" || basename(dirname(standalone)) !== ".next") {
    throw new Error("Refusing to sanitize outside generated standalone output");
  }
  try {
    const stat = await lstat(standalone);
    if (!stat.isDirectory()) throw new Error("Standalone output is not a directory");

    // Next deliberately copies loaded .env and .env.production independently of NFT traces.
    // Only generated copies are removed; the source files are never touched.
    for (const entry of await readdir(standalone)) {
      if (entry.startsWith(".env"))
        await rm(join(standalone, entry), { recursive: true, force: true });
    }

    async function inspect(directory) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (isPrivateProjectPath(standalone, path)) {
          throw new Error("Standalone output contains project runtime state");
        }
        if (entry.isDirectory()) {
          if (entry.name !== "node_modules") await inspect(path);
        } else if (entry.isFile() && entry.name.endsWith(".nft.json")) {
          const trace = JSON.parse(await readFile(path, "utf8"));
          if (!Array.isArray(trace.files)) throw new Error("Invalid standalone trace manifest");
          for (const file of trace.files) {
            if (
              typeof file !== "string" ||
              isPrivateProjectPath(standalone, resolve(dirname(path), file))
            ) {
              throw new Error("Standalone trace references project runtime state");
            }
          }
        }
      }
    }

    await inspect(standalone);
  } catch (error) {
    // A failed build must not leave a shippable but contaminated standalone tree.
    await rm(standalone, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await sanitizeStandalone();
}
