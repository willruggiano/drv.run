import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createGzip, constants } from "node:zlib";
import type { EntryId } from "@earendil-works/pi-durable";
import { observe, Projection, type Patch } from "./watch.ts";
import { context, field, InvalidForm, type Application } from "./application.ts";
import {
  alert,
  configuration,
  metadata,
  conversationPage,
  home,
  page,
  thinking,
  regions,
} from "./render.ts";

// Datastar v1.0.5 wire format: https://data-star.dev/reference/sse_events
export function patch(html: string, options: Omit<Patch, "html"> = {}): string {
  return `event: datastar-patch-elements\n${options.selector ? `data: selector ${options.selector}\n` : ""}${options.mode ? `data: mode ${options.mode}\n` : ""}${html
    .split(/\r\n|\r|\n/)
    .map((line) => `data: elements ${line}`)
    .join("\n")}\n\n`;
}
const script = (source: string) =>
  `event: datastar-patch-elements\ndata: selector body\ndata: mode append\ndata: elements <script>${source};document.currentScript.remove()</script>\n\n`;
const redirect = (id: number) => script(`window.location.assign('/sessions/${id}')`);
const assets = new Map<string, readonly [string, string]>([
  ["/assets/datastar.js", ["../assets/datastar.js", "text/javascript"]],
  ["/assets/browser.js", ["../dist/browser.js", "text/javascript"]],
  ["/assets/style.css", ["../assets/style.css", "text/css"]],
] as const);

export async function serve(
  app: Application,
  options: { port?: number; host?: string; origin?: string } = {},
) {
  const server = createServer((request, response) => {
    void route(request, response).catch((error: unknown) => {
      if (response.destroyed) return;
      const expected = error instanceof InvalidForm || error instanceof HttpError;
      if (!expected) console.error(error);
      const message = expected
        ? error.message
        : "Request failed. Check the conversation before resending.";
      if (response.headersSent) response.destroy();
      else if (request.headers["datastar-request"] === "true" && error instanceof InvalidForm) {
        // Datastar processes patches on 200 responses; validation errors are visible HTML, not retries.
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
        });
        response.end(patch(alert(message)));
      } else {
        response.writeHead(
          error instanceof HttpError ? error.status : error instanceof InvalidForm ? 400 : 500,
          { "Content-Type": "text/html; charset=utf-8" },
        );
        response.end(page("Error", alert(message)));
      }
    });
  });

  async function route(request: IncomingMessage, response: ServerResponse) {
    assert(request.url && request.headers.host);
    const url = new URL(request.url, options.origin ?? `http://${request.headers.host}`);
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cache-Control", "no-store");
    if (
      request.headers["sec-fetch-site"] === "cross-site" ||
      (request.headers.origin && request.headers.origin !== url.origin)
    ) {
      response.writeHead(403).end();
      return;
    }
    const asset = assets.get(url.pathname);
    if (request.method === "GET" && asset) {
      response.writeHead(200, { "Content-Type": asset[1] });
      response.end(await readFile(new URL(asset[0], import.meta.url)));
      return;
    }
    if (request.method === "GET" && url.pathname === "/") {
      const html = await home(app);
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(html);
      return;
    }
    if (request.method === "POST") {
      if (url.pathname === "/sessions") {
        const form = await formData(request, url);
        const conversation = await app.create(form);
        if (request.headers["datastar-request"] === "true")
          sse(response, redirect(conversation.id));
        else response.writeHead(303, { Location: `/sessions/${conversation.id}` }).end();
        return;
      }
      if (url.pathname === "/thinking") {
        const form = await formData(request, url);
        sse(response, patch(thinking(app, field(form, "model"), field(form, "thinking"))));
        return;
      }
    }
    const match = /^\/sessions\/(\d+)(?:\/(events|entries|message|configure|stop))?$/.exec(
      url.pathname,
    );
    const conversation = match?.[1] && (await app.conversation(match[1]));
    if (!conversation) {
      response.writeHead(404).end();
      return;
    }
    const action = match?.[2];
    if (request.method === "GET" && !action) {
      const abort = new AbortController();
      response.once("close", () => abort.abort());
      const watch = await observe(app, conversation, abort.signal);
      const initial = watch.value;
      await watch.stop();
      const html = await conversationPage(app, conversation, initial);
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(html);
    } else if (request.method === "GET" && action === "events") {
      const abort = new AbortController();
      response.once("close", () => abort.abort());
      const watch = await observe(app, conversation, abort.signal);
      const compressed = request.headers["accept-encoding"]?.split(/[, ]+/).includes("gzip");
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "X-Accel-Buffering": "no",
        ...(compressed ? { "Content-Encoding": "gzip", Vary: "Accept-Encoding" } : {}),
      });
      const output = compressed ? createGzip({ flush: constants.Z_SYNC_FLUSH }) : response;
      if (output !== response) {
        output.on("error", () => response.destroy());
        output.pipe(response);
        response.once("close", () => output.destroy());
      }
      const write = async (data: string) => {
        abort.signal.throwIfAborted();
        if (!output.write(data)) await once(output, "drain", { signal: abort.signal });
      };
      const projection = new Projection({
        configuration: () => configuration(app, conversation),
        metadata: (view) => metadata(app, conversation, view),
      });
      const render = async (value: typeof watch.value, ops?: Parameters<Projection["update"]>[1]) =>
        (await projection.update(value, ops))
          .map(({ html, ...options }) => patch(html, options))
          .join("");
      try {
        await write(
          patch('<div id="connection" class="sr-only" role="status">Connected</div>') +
            (await render(watch.value)),
        );
        watch.start(async (call) => {
          assert(call.kind === "value");
          await write(await render(call.value, call.ops));
        });
      } catch (error) {
        await watch.stop();
        throw error;
      }
      const end = await watch.closed;
      if (!response.destroyed) {
        if (end.kind === "failed" || end.kind === "listener_error")
          output.write(patch(alert("Conversation stream failed. Reconnecting…")));
        output.end();
      }
    } else if (request.method === "GET" && action === "entries") {
      const before = Number(url.searchParams.get("before"));
      const after = url.searchParams.has("after")
        ? Number(url.searchParams.get("after"))
        : undefined;
      if (
        !url.searchParams.has("before") ||
        !Number.isSafeInteger(before) ||
        before < 1 ||
        (after !== undefined && (!Number.isSafeInteger(after) || after < 0 || after >= before))
      ) {
        response.writeHead(400).end();
        return;
      }
      const result = await conversation.entries(
        {
          order: "descending",
          maxEntryId: (before - 1) as EntryId,
          ...(after === undefined ? {} : { minEntryId: (after + 1) as EntryId }),
        },
        50,
        undefined,
        context,
      );
      const records = [...result.items].reverse();
      const view = { entries: records, docs: {} };
      const states = regions.tools(view);
      const html = `<section id="history-${after ?? "start"}-${before}">${result.next && records[0] ? regions.history(conversation.id, records[0].id, after) : ""}${records.map((entry) => regions.entry(entry, states)).join("")}</section>`;
      if (request.headers["datastar-request"] === "true") sse(response, patch(html));
      else
        response
          .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
          .end(
            page(
              "Earlier messages",
              `<main><a href="/sessions/${conversation.id}">Conversation</a>${html}</main>`,
            ),
          );
    } else if (request.method === "POST" && action === "message") {
      const form = await formData(request, url);
      const result = await app.send(conversation, form);
      const next = typeof result === "object" ? result : undefined;
      const directory = /^\/cd(?:\s|$)/.test(field(form, "message").trim())
        ? patch((await configuration(app, conversation)).cwd)
        : "";
      if (request.headers["datastar-request"] !== "true") {
        response.writeHead(303, { Location: `/sessions/${next?.id ?? conversation.id}` }).end();
        return;
      }
      sse(
        response,
        next
          ? redirect(next.id)
          : patch(
              alert() +
                `<div id="admission" hidden${typeof result === "number" ? ` data-submission-id="${result}"` : ""}></div>`,
            ) +
              directory +
              script("document.getElementById('composer').reset()"),
      );
    } else if (request.method === "POST" && action === "configure") {
      const form = await formData(request, url);
      await app.configure(conversation, form);
      if (request.headers["datastar-request"] !== "true") {
        response.writeHead(303, { Location: `/sessions/${conversation.id}` }).end();
        return;
      }
      const controls = await configuration(app, conversation);
      sse(
        response,
        patch(alert()) +
          patch(
            Object.entries(controls)
              .filter(([name]) => form.has(name) || (name === "thinking" && form.has("model")))
              .map(([, html]) => html)
              .join(""),
          ),
      );
    } else if (request.method === "POST" && action === "stop") {
      await conversation.abort(context, { background: true });
      if (request.headers["datastar-request"] === "true") sse(response, patch(alert("Stopped.")));
      else response.writeHead(303, { Location: `/sessions/${conversation.id}` }).end();
    } else {
      response.writeHead(405).end();
    }
  }

  server.listen(options.port ?? 8082, options.host ?? "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  return {
    origin: `http://${options.host ?? "127.0.0.1"}:${address.port}`,
    async close() {
      const closed = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      server.closeAllConnections();
      await closed;
    },
  };
}

function sse(response: ServerResponse, events: string) {
  response.writeHead(200, { "Content-Type": "text/event-stream" }).end(events);
}

async function formData(request: IncomingMessage, url: URL): Promise<FormData> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 32 * 1024 * 1024) {
      request.resume();
      throw new HttpError(413, "Maximum upload size is 32 MiB.");
    }
    chunks.push(bytes);
  }
  const type = request.headers["content-type"] ?? "application/x-www-form-urlencoded";
  if (
    !type.startsWith("multipart/form-data") &&
    !type.startsWith("application/x-www-form-urlencoded")
  )
    throw new HttpError(415, "Use a multipart or URL-encoded form.");
  try {
    return await new Request(url, {
      method: "POST",
      headers: {
        "Content-Type": request.headers["content-type"] ?? "application/x-www-form-urlencoded",
      },
      body: new Uint8Array(Buffer.concat(chunks)),
    }).formData();
  } catch (error) {
    if (error instanceof TypeError) throw new HttpError(400, "Malformed form body.");
    throw error;
  }
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
