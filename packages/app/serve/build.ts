import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, copyFile, mkdir, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// One build path for the Nix package, browser tests and page benchmark.
// esbuild is provided by Nix, not shipped in the frontend's runtime closure.
export async function buildAssets(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  const { stderr } = await promisify(execFile)("esbuild", [
    ...Object.entries({
      client: "elm/client.ts",
      site: "elm/site.ts",
      highlight: "highlight.ts",
      styles: "styles.css",
      sw: "worker.js",
    }).map(([name, file]) => `${name}=${join(source, file)}`),
    "--bundle",
    "--minify",
    "--format=esm",
    "--target=es2024",
    "--legal-comments=eof",
    "--log-level=warning",
    `--outdir=${destination}`,
  ]);
  if (stderr) process.stderr.write(stderr);
  await buildElm(join(source, "elm"), destination);
  // Upstream's CommonJS files omit the package-level BSD notice.
  const require = createRequire(resolve(source, "highlight.ts"));
  const license = await readFile(require.resolve("highlight.js/LICENSE"), "utf8");
  await appendFile(join(destination, "highlight.js"), `\n/*! highlight.js\n${license}*/\n`);
  for (const file of ["design-system.html", "icon-192.png", "icon-512.png"])
    await copyFile(join(source, file), join(destination, file));
}

async function buildElm(source: string, destination: string): Promise<void> {
  await promisify(execFile)(
    "elm",
    [
      "make",
      "src/Main.elm",
      "src/Site.elm",
      "--optimize",
      `--output=${resolve(destination, "main.js")}`,
    ],
    { cwd: source },
  );
  // Elm exports through top-level `this`. An enclosing type=module package makes
  // esbuild replace it with undefined, so give the minifier explicit CommonJS input.
  const elmSource = join(destination, "main.cjs");
  await rename(join(destination, "main.js"), elmSource);
  try {
    await promisify(execFile)("esbuild", [
      elmSource,
      "--minify",
      "--target=es2024",
      "--legal-comments=eof",
      `--outfile=${join(destination, "main.js")}`,
      "--log-level=warning",
    ]);
  } finally {
    await rm(elmSource);
  }
  const manifest = JSON.parse(await readFile(join(source, "elm.json"), "utf8")) as {
    "elm-version": string;
    dependencies: { direct: Record<string, string>; indirect: Record<string, string> };
  };
  const elmHome = process.env.ELM_HOME ?? join(homedir(), ".elm");
  for (const [name, version] of Object.entries({
    ...manifest.dependencies.direct,
    ...manifest.dependencies.indirect,
  })) {
    const notice = await readFile(
      join(elmHome, manifest["elm-version"], "packages", name, version, "LICENSE"),
      "utf8",
    );
    await appendFile(join(destination, "main.js"), `\n/*! ${name} ${version}\n${notice}*/\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 3, "Usage: node packages/app/serve/build.ts $out");
  await buildAssets(dirname(fileURLToPath(import.meta.url)), resolve(process.argv[2]));
}
