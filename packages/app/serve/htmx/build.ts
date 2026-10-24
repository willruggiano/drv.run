import assert from "node:assert/strict";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

export async function buildAssets(source: string, destination: string): Promise<void> {
  const require = createRequire(resolve(source, "build.ts"));
  const htmx = await readFile(require.resolve("htmx.org/dist/htmx.min.js"), "utf8");
  // htmx 4.0.0 hx-sse cleanup aborts fetch before cancelling its reader. Chromium
  // then rejects cancel() on the already-errored stream as an unhandled AbortError.
  // Cancel the reader first; retain all upstream error handling and reconnection.
  const sse = await readFile(require.resolve("htmx.org/dist/ext/hx-sse.js"), "utf8");
  const cleanup = "connection.abortController?.abort();\n        connection.reader?.cancel?.();";
  assert.equal(sse.split(cleanup).length, 2, "Recheck the pinned hx-sse cleanup patch");
  await writeFile(
    join(destination, "sse.js"),
    sse.replace(
      cleanup,
      "connection.reader?.cancel?.();\n        connection.abortController?.abort();",
    ),
  );
  const htmxLicense = await readFile(require.resolve("htmx.org/LICENSE"), "utf8");
  await writeFile(join(destination, "vendor.js"), `${htmx}\n/*! htmx\n${htmxLicense}*/\n`);
  await appendFile(join(destination, "sse.js"), `\n/*! htmx\n${htmxLicense}*/\n`);
}
