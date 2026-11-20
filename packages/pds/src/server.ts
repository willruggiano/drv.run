import assert from "node:assert/strict";
import { once } from "node:events";
import { MIMEType } from "node:util";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createGzip, constants } from "node:zlib";
import {
  SessionFailed,
  StorageRequestError,
  ConversationBusy,
  ConversationIdle,
} from "@earendil-works/pi-durable";
import type * as D from "@earendil-works/pi-durable";
import { ConversationId, EntryId, TaskId, SessionId, decode, InvalidRequest } from "./identity.ts";
import { observe, Projection, type Patch } from "./watch.ts";
import {
  context,
  field,
  InvalidForm,
  SessionUnavailable,
  type Application,
} from "./application.ts";
import {
  alert,
  configuration,
  metadata,
  conversationPage,
  home,
  page,
  thinking,
  regions,
  escape,
  sessionList,
  sessionPage,
  modelsPage,
  sessionPath,
  conversationPath,
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
const redirect = (location: string) =>
  script(`window.location.assign(${JSON.stringify(location)})`);
const assets = new Map<string, readonly [string, string]>([
  ["/assets/datastar.js", ["../assets/datastar.js", "text/javascript"]],
  ["/assets/browser.js", ["../dist/browser.js", "text/javascript"]],
  ["/assets/style.css", ["../assets/style.css", "text/css"]],
] as const);

export async function serve(
  sessions: Application,
  options: { port?: number; host?: string; origin?: string } = {},
) {
  const base = new URL(options.origin ?? "http://pds.invalid/");
  assert(
    ["http:", "https:"].includes(base.protocol) &&
      !base.username &&
      !base.password &&
      !base.search &&
      !base.hash,
    "Use an HTTP(S) public base URL",
  );
  if (base.pathname.at(-1) !== "/") base.pathname += "/";
  const prefix = base.pathname.slice(0, -1);
  const sessionRoute = new URLPattern("api/s/:session", base.href);
  const sessionAction = new URLPattern("api/s/:session/:action", base.href);
  const conversationRoute = new URLPattern("api/s/:session/c/:conversation/:action?", base.href);
  const inFlight = new Set<Promise<void>>();
  let closing = false;
  const server = createServer((request, response) => {
    const work = route(request, response)
      .catch((error: unknown) => {
        if (response.destroyed) return;
        const expected =
          error instanceof InvalidForm ||
          error instanceof HttpError ||
          error instanceof InvalidRequest ||
          error instanceof SessionUnavailable ||
          error instanceof SessionFailed ||
          error instanceof ConversationBusy ||
          error instanceof ConversationIdle;
        if (!expected) console.error("PDS request failed unexpectedly.");
        const message =
          error instanceof SessionUnavailable || error instanceof SessionFailed
            ? "Session is unavailable."
            : expected
              ? error.message
              : "Request failed. Check the conversation before resending.";
        if (response.headersSent) response.destroy();
        else if (request.headers["datastar-request"] === "true" && error instanceof InvalidForm) {
          response.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-store",
          });
          response.end(patch(alert(message)));
        } else {
          response.writeHead(
            error instanceof HttpError
              ? error.status
              : error instanceof InvalidForm
                ? 200
                : error instanceof InvalidRequest
                  ? 400
                  : error instanceof SessionUnavailable || error instanceof SessionFailed
                    ? 503
                    : error instanceof ConversationBusy || error instanceof ConversationIdle
                      ? 409
                      : 500,
            { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
          );
          response.end(page("Error", alert(message), "home", prefix));
        }
      })
      .finally(() => {
        inFlight.delete(work);
      });
    inFlight.add(work);
  });

  function method(request: IncomingMessage, response: ServerResponse, allowed: string[]) {
    if (!request.method || !allowed.includes(request.method)) {
      response.setHeader("Allow", allowed.join(", "));
      throw new HttpError(405, "Method not allowed.");
    }
  }
  function navigate(request: IncomingMessage, response: ServerResponse, location: string) {
    if (request.headers["datastar-request"] === "true") sse(response, redirect(location));
    else response.writeHead(303, { Location: location }).end();
  }
  function html(response: ServerResponse, content: string) {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(content);
  }
  async function route(request: IncomingMessage, response: ServerResponse) {
    assert(request.url);
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cache-Control", "no-store");
    if (closing) throw new SessionUnavailable("PDS is closing.");
    const url = new URL(request.url, base);
    const address = server.address();
    assert(address && typeof address !== "string");
    const origin = options.origin
      ? base.origin
      : `http://${options.host ?? "127.0.0.1"}:${address.port}`;
    if (
      request.method !== "GET" &&
      (request.headers["sec-fetch-site"] === "cross-site" ||
        (request.headers.origin && request.headers.origin !== origin))
    )
      throw new HttpError(403, "Foreign request origin.");
    const asset = [...assets].find(
      ([path]) => url.pathname === new URL(`.${path}`, base).pathname,
    )?.[1];
    if (asset) {
      method(request, response, ["GET"]);
      response.writeHead(200, { "Content-Type": asset[1] });
      response.end(await readFile(new URL(asset[0], import.meta.url)));
      return;
    }
    if (url.pathname === base.pathname) {
      method(request, response, ["GET", "POST"]);
      queryFields(request, url, []);
      if (request.method === "GET") html(response, await home(sessions, prefix));
      else {
        const form = await formData(request, url);
        fields(form, [
          "sessionId",
          "model",
          "thinking",
          "cwd",
          "environment",
          "message",
          "attachments",
        ]);
        const result = await sessions.compose(form);
        navigate(
          request,
          response,
          conversationPath(prefix, result.sessionId, result.conversation.id),
        );
      }
      return;
    }
    if (url.pathname === new URL("thinking", base).pathname) {
      method(request, response, ["POST"]);
      queryFields(request, url, []);
      const form = await formData(request, url);
      fields(form, [
        "sessionId",
        "model",
        "thinking",
        "cwd",
        "environment",
        "message",
        "attachments",
      ]);
      sse(response, patch(thinking(sessions, field(form, "model"), field(form, "thinking"))));
      return;
    }
    if (url.pathname === new URL("api/models", base).pathname) {
      method(request, response, ["GET"]);
      queryFields(request, url, []);
      html(response, await modelsPage(sessions, prefix));
      return;
    }
    if (url.pathname === new URL("api/s", base).pathname) {
      method(request, response, ["GET"]);
      queryFields(request, url, []);
      html(response, page("Sessions", await sessionList(sessions, prefix), "home", prefix));
      return;
    }
    if (url.pathname === new URL("api/s/open", base).pathname) {
      // GET still addresses the opaque session ID "open".
      method(request, response, ["GET", "POST"]);
      if (request.method === "POST") {
        queryFields(request, url, []);
        const form = await formData(request, url);
        fields(form, ["sessionId"]);
        const app = await sessions.open(
          form.has("sessionId") ? decode(SessionId, field(form, "sessionId")) : undefined,
        );
        navigate(request, response, sessionPath(prefix, app.id));
        return;
      }
    }
    const conversationMatch = conversationRoute.exec(url.href)?.pathname.groups;
    const sessionMatch =
      sessionRoute.exec(url.href)?.pathname.groups ?? sessionAction.exec(url.href)?.pathname.groups;
    const match = conversationMatch ?? sessionMatch;
    if (!match?.session) throw new HttpError(404, "Not found.");
    let sessionId: SessionId;
    try {
      sessionId = decode(SessionId, decodeURIComponent(match.session));
    } catch (error) {
      if (error instanceof URIError) throw new InvalidRequest("Malformed session address.");
      throw error;
    }
    const action = match.action;
    const read = conversationMatch
      ? action === undefined || action === "watch" || action === "entries"
      : action === undefined;
    const write = conversationMatch
      ? ["submit", "composer", "configure", "abort", "compact"].includes(action ?? "")
      : ["root", "createConversation"].includes(action ?? "");
    if (!read && !write) throw new HttpError(404, "Not found.");
    method(request, response, read ? ["GET"] : ["POST"]);
    queryFields(request, url, action === "entries" ? ["before", "after"] : []);
    const app = await sessions.get(sessionId);
    if (!app) throw new HttpError(404, "Session not found.");
    if (!conversationMatch) {
      if (!action) html(response, await sessionPage(app, prefix));
      else {
        const form = await formData(request, url);
        fields(
          form,
          action === "root"
            ? ["model", "thinking", "cwd", "environment"]
            : ["model", "thinking", "cwd", "environment", "ownership", "taskId"],
        );
        let ownership: D.ConversationOwnership = { kind: "ownerless" };
        if (form.has("ownership")) {
          const kind = field(form, "ownership");
          if (kind === "task") {
            const taskId = decode(TaskId, field(form, "taskId"));
            if (!(await app.harness.getTask(taskId, context)))
              throw new InvalidForm("Owning task does not exist in this session.");
            ownership = { kind: "task", taskId };
          } else if (kind !== "ownerless") throw new InvalidForm("Unknown conversation ownership.");
        }
        if (ownership.kind === "ownerless" && form.has("taskId"))
          throw new InvalidRequest("Task ID requires task ownership.");
        const conversation =
          action === "root" ? await app.root(form) : await app.createConversation(form, ownership);
        navigate(request, response, conversationPath(prefix, app.id, conversation.id));
      }
      return;
    }
    assert(match.conversation !== undefined);
    const conversation = await app
      .conversation(decode(ConversationId, match.conversation))
      .catch((error: unknown) => {
        if (error instanceof StorageRequestError)
          throw new InvalidRequest("Invalid conversation read.", { cause: error });
        throw error;
      });
    if (!conversation) throw new HttpError(404, "Conversation not found.");
    const path = conversationPath(prefix, app.id, conversation.id);
    if (!action) {
      const abort = new AbortController();
      response.once("close", () => abort.abort());
      const watch = await observe(app, conversation, abort.signal);
      const initial = watch.value;
      await watch.stop();
      const html = await conversationPage(app, conversation, initial, prefix);
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(html);
    } else if (request.method === "GET" && action === "watch") {
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
      const projection = new Projection(path, {
        configuration: () => configuration(app, conversation, prefix),
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
      const before = decode(EntryId, url.searchParams.get("before"));
      const after = url.searchParams.has("after")
        ? decode(EntryId, url.searchParams.get("after"))
        : undefined;
      if (before < 1 || (after !== undefined && after >= before))
        throw new InvalidRequest("Invalid history interval.");
      // The checked exclusive interval yields safe, nonnegative inclusive IDs.
      const result = await conversation
        .entries(
          {
            order: "descending",
            maxEntryId: (before - 1) as D.EntryId,
            ...(after === undefined ? {} : { minEntryId: (after + 1) as D.EntryId }),
          },
          50,
          undefined,
          context,
        )
        .catch((error: unknown) => {
          if (error instanceof StorageRequestError)
            throw new InvalidRequest("Invalid history request.", { cause: error });
          throw error;
        });
      const records = [...result.items].reverse();
      const view = { entries: records, docs: {} };
      const states = regions.tools(view);
      const html = `<section id="history-${after ?? "start"}-${before}">${result.next && records[0] ? regions.history(path, records[0].id, after) : ""}${records.map((entry) => regions.entry(entry, states)).join("")}</section>`;
      if (request.headers["datastar-request"] === "true") sse(response, patch(html));
      else
        response
          .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
          .end(
            page(
              "Earlier messages",
              `<main><a href="${escape(path)}">Conversation</a>${html}</main>`,
              "home",
              prefix,
            ),
          );
    } else if (request.method === "POST" && (action === "composer" || action === "submit")) {
      const form = await formData(request, url);
      fields(form, ["message", "attachments"]);
      const result =
        action === "composer"
          ? await app.send(conversation, form)
          : await app.submit(conversation, form);
      const next = typeof result === "object" ? result : undefined;
      const directory =
        typeof result === "number" || next
          ? ""
          : patch((await configuration(app, conversation, prefix)).cwd);
      if (request.headers["datastar-request"] !== "true") {
        response
          .writeHead(303, {
            Location: conversationPath(prefix, app.id, next?.id ?? conversation.id),
          })
          .end();
        return;
      }
      sse(
        response,
        next
          ? redirect(conversationPath(prefix, app.id, next.id))
          : patch(
              alert() +
                `<div id="admission" hidden${typeof result === "number" ? ` data-submission-id="${result}"` : ""}></div>`,
            ) +
              directory +
              script("document.getElementById('composer').reset()"),
      );
    } else if (request.method === "POST" && action === "configure") {
      const form = await formData(request, url);
      fields(form, ["model", "thinking", "cwd", "environment"]);
      await app.configure(conversation, form);
      if (request.headers["datastar-request"] !== "true") {
        response.writeHead(303, { Location: path }).end();
        return;
      }
      const controls = await configuration(app, conversation, prefix);
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
    } else if (request.method === "POST" && action === "abort") {
      fields(await formData(request, url), []);
      await conversation.abort(context);
      if (request.headers["datastar-request"] === "true") sse(response, patch(alert("Stopped.")));
      else response.writeHead(303, { Location: path }).end();
    } else if (action === "compact") {
      const form = await formData(request, url);
      fields(form, ["instructions"]);
      await conversation.compact(
        form.has("instructions") ? field(form, "instructions") : undefined,
        context,
      );
      navigate(request, response, path);
    }
  }

  server.listen(options.port ?? 8082, options.host ?? "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  return {
    origin: `http://${options.host ?? "127.0.0.1"}:${address.port}`,
    prefix,
    async close() {
      closing = true;
      const closed = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      server.closeAllConnections();
      await closed;
      await Promise.allSettled([...inFlight]);
    },
  };
}

function sse(response: ServerResponse, events: string) {
  response.writeHead(200, { "Content-Type": "text/event-stream" }).end(events);
}

async function formData(request: IncomingMessage, url: URL): Promise<FormData> {
  const type = request.headers["content-type"] ?? "application/x-www-form-urlencoded";
  let media: string;
  try {
    media = new MIMEType(type).essence;
  } catch (error) {
    if (error instanceof TypeError) throw new HttpError(415, "Unsupported media type.");
    throw error;
  }
  if (!["multipart/form-data", "application/x-www-form-urlencoded"].includes(media)) {
    request.resume();
    throw new HttpError(415, "Use a multipart or URL-encoded form.");
  }
  const limit = 32 * 1024 * 1024;
  if (Number(request.headers["content-length"]) > limit) {
    request.resume();
    throw new HttpError(413, "Maximum upload size is 32 MiB.");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) {
      request.resume();
      throw new HttpError(413, "Maximum upload size is 32 MiB.");
    }
    chunks.push(bytes);
  }
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

function fields(input: FormData | URLSearchParams, allowed: readonly string[]) {
  for (const name of input.keys()) {
    if (!allowed.includes(name) || (name !== "attachments" && input.getAll(name).length !== 1))
      throw new InvalidRequest("Unknown or repeated request field.");
    if (name === "attachments" && input.getAll(name).some((value) => !(value instanceof File)))
      throw new InvalidRequest("Expected a file field.");
    if (name !== "attachments" && typeof input.get(name) !== "string")
      throw new InvalidRequest("Expected a text field.");
  }
}

function queryFields(request: IncomingMessage, url: URL, allowed: readonly string[]) {
  const enhanced = request.headers["datastar-request"] === "true";
  fields(url.searchParams, enhanced ? [...allowed, "datastar"] : allowed);
  const envelope = url.searchParams.get("datastar");
  if (envelope !== null) {
    // Datastar 1.0.5 sends signals on GET. They never supply read arguments or durable state.
    let signals: unknown;
    try {
      signals = JSON.parse(envelope);
    } catch (error) {
      if (error instanceof SyntaxError) throw new InvalidRequest("Malformed signal envelope.");
      throw error;
    }
    if (typeof signals !== "object" || signals === null || Array.isArray(signals))
      throw new InvalidRequest("Expected a signal object.");
  }
}
