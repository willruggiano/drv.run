import { once } from "node:events";
import type { ServerResponse } from "node:http";
import { createGzip, constants } from "node:zlib";

export type Patch = { html: string; selector?: string; mode?: "append" | "replace" };

// Datastar 1.0.5: library/src/plugins/watchers/patchElements.ts.
export function patch(markup: string, options: Omit<Patch, "html"> = {}): string {
  const lines = ["event: datastar-patch-elements"];
  if (options.selector) lines.push(`data: selector ${options.selector}`);
  if (options.mode) lines.push(`data: mode ${options.mode}`);
  for (const line of markup.split(/\r\n|\r|\n/)) lines.push(`data: elements ${line}`);
  return `${lines.join("\n")}\n\n`;
}

export const script = (source: string) =>
  patch(`<script>${source};document.currentScript.remove()</script>`, {
    selector: "body",
    mode: "append",
  });

export const redirect = (location: string) =>
  script(`window.location.assign(${JSON.stringify(location).replaceAll("<", "\\u003c")})`);

export function sse(response: ServerResponse, events: string) {
  response
    .writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" })
    .end(events);
}

/** One awaited writer per native watch callback; Chord owns folding while drain waits. */
export function stream(response: ServerResponse, gzip: boolean, signal: AbortSignal) {
  signal.throwIfAborted();
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    "X-Accel-Buffering": "no",
    Vary: "Accept-Encoding",
    ...(gzip ? { "Content-Encoding": "gzip" } : {}),
  });
  const output = gzip ? createGzip({ flush: constants.Z_SYNC_FLUSH }) : response;
  if (output !== response) {
    output.on("error", () => response.destroy());
    output.pipe(response);
    response.once("close", () => output.destroy());
  }
  return {
    async write(events: string) {
      signal.throwIfAborted();
      if (!output.write(events)) await once(output, "drain", { signal });
    },
    end() {
      output.end();
    },
  };
}
