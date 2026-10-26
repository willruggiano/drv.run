import { buildAssets as buildElmAssets } from "./elm/build.ts";
import { buildAssets as buildHtmxAssets } from "./htmx/build.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, copyFile, mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// One build path for the Nix package, browser tests and page benchmark.
// esbuild is provided by Nix, not shipped in the frontend's runtime closure.
export async function buildAssets(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  const { stderr } = await promisify(execFile)("esbuild", [
    ...[
      "elm/client.ts",
      "elm/site.ts",
      "htmx/client.ts",
      "htmx/morph.ts",
      "highlight.ts",
      "htmx/activity.ts",
      "styles.css",
      "worker.js",
    ].map((file) => join(source, file)),
    "--bundle",
    "--minify",
    "--format=esm",
    "--target=es2024",
    "--legal-comments=eof",
    "--log-level=warning",
    `--outbase=${source}`,
    `--outdir=${destination}`,
  ]);
  if (stderr) process.stderr.write(stderr);
  await buildElmAssets(join(source, "elm"), join(destination, "elm"));
  await buildHtmxAssets(join(source, "htmx"), join(destination, "htmx"));
  for (const frontend of ["elm", "htmx"])
    await copyFile(join(destination, "worker.js"), join(destination, frontend, "sw.js"));
  // Upstream's CommonJS files omit the package-level BSD notice.
  const require = createRequire(resolve(source, "highlight.ts"));
  const license = await readFile(require.resolve("highlight.js/LICENSE"), "utf8");
  await appendFile(join(destination, "highlight.js"), `\n/*! highlight.js\n${license}*/\n`);
  for (const file of ["design-system.html", "icon-192.png", "icon-512.png"])
    await copyFile(join(source, file), join(destination, file));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 3, "Usage: node packages/app/serve/build.ts $out");
  await buildAssets(dirname(fileURLToPath(import.meta.url)), resolve(process.argv[2]));
}
