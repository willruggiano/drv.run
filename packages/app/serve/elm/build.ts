import { execFile } from "node:child_process";
import { appendFile, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

export async function buildAssets(source: string, destination: string): Promise<void> {
  await promisify(execFile)(
    "elm",
    ["make", "src/Main.elm", "--optimize", `--output=${resolve(destination, "main.js")}`],
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
