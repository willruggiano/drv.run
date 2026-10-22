import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// One build path for the Nix package, browser tests and renderer benchmark.
// esbuild is provided by Nix, not shipped in the frontend's runtime closure.
export async function buildAssets(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  const { stderr } = await promisify(execFile)("esbuild", [
    ...[
      "client.ts",
      "hypermedia-client.ts",
      "hypermedia-morph.ts",
      "hypermedia.css",
      "highlight.ts",
      "styles.css",
      "sw.js",
      "hypermedia-sw.js",
    ].map((file) => join(source, file)),
    "--bundle",
    "--minify",
    "--format=esm",
    "--target=es2024",
    "--legal-comments=eof",
    "--log-level=warning",
    `--outdir=${destination}`,
  ]);
  if (stderr) process.stderr.write(stderr);
  // Upstream's CommonJS files omit the package-level BSD notice.
  const require = createRequire(resolve(source, "highlight.ts"));
  const htmx = await readFile(require.resolve("htmx.org/dist/htmx.min.js"), "utf8");
  // htmx 4.0.0 hx-sse cleanup aborts fetch before cancelling its reader. Chromium
  // then rejects cancel() on the already-errored stream as an unhandled AbortError.
  // Cancel the reader first; retain all upstream error handling and reconnection.
  const sse = await readFile(require.resolve("htmx.org/dist/ext/hx-sse.js"), "utf8");
  const cleanup = "connection.abortController?.abort();\n        connection.reader?.cancel?.();";
  assert.equal(sse.split(cleanup).length, 2, "Recheck the pinned hx-sse cleanup patch");
  await writeFile(
    join(destination, "hx-sse.js"),
    sse.replace(
      cleanup,
      "connection.reader?.cancel?.();\n        connection.abortController?.abort();",
    ),
  );
  const htmxLicense = await readFile(require.resolve("htmx.org/LICENSE"), "utf8");
  await writeFile(join(destination, "htmx.js"), `${htmx}\n/*! htmx\n${htmxLicense}*/\n`);
  await appendFile(join(destination, "hx-sse.js"), `\n/*! htmx\n${htmxLicense}*/\n`);
  const license = await readFile(require.resolve("highlight.js/LICENSE"), "utf8");
  await appendFile(join(destination, "highlight.js"), `\n/*! highlight.js\n${license}*/\n`);
  for (const file of ["index.html", "design-system.html", "icon-192.png", "icon-512.png"])
    await copyFile(join(source, file), join(destination, file));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 3, "Usage: node packages/app/serve/build.ts $out");
  await buildAssets(dirname(fileURLToPath(import.meta.url)), resolve(process.argv[2]));
}
