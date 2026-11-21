import assert from "node:assert/strict";
import { once } from "node:events";
import { MIMEType } from "node:util";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  SessionFailed,
  StorageRequestError,
  ConversationBusy,
  ConversationIdle,
} from "@earendil-works/pi-durable";
import type * as D from "@earendil-works/pi-durable";
import {
  ConversationId,
  TaskId,
  SessionId,
  SubmissionId,
  decode,
  InvalidRequest,
} from "./identity.ts";
import { observe, Projection } from "./watch.ts";
import { patch, script, redirect, sse, stream } from "./datastar.ts";
import { historyQuery, readHistory } from "./history.ts";
import { LoginError, type ModelAuth } from "./login.ts";
import {
  context,
  field,
  submissionFields,
  InvalidForm,
  SessionUnavailable,
  type Application,
} from "./application.ts";
import {
  alert,
  invalidForm,
  configuration,
  metadata,
  conversationPage,
  home,
  page,
  thinking,
  historyId,
  historyPage,
  sessionPath,
  conversationPath,
  loginPage,
  loginPanel,
} from "./render.ts";

export type Acknowledgement = { scope: string } & (
  | { action: "submit"; id: D.SubmissionId; requestId: string | undefined }
  | { action: "receipt"; record: D.SubmissionRecord | undefined; requestId: string | undefined }
  | {
      action: "abortSubmission";
      id: D.SubmissionId;
      result: Awaited<ReturnType<D.Harness["abortSubmission"]>>;
    }
  | { action: "abort" | "resume" }
);

const acknowledge = (detail: Acknowledgement) =>
  script(
    `document.dispatchEvent(new CustomEvent("pds-acknowledgement", {detail:${JSON.stringify(detail).replaceAll("<", "\\u003c")}}))`,
  );

const assets = new Map<string, readonly [string, string]>([
  ["/assets/datastar.js", ["../assets/datastar.js", "text/javascript"]],
  ["/assets/browser.js", ["../dist/browser.js", "text/javascript"]],
  ["/assets/style.css", ["../assets/style.css", "text/css"]],
] as const);

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

export async function serve(
  sessions: Application,
  options: { auth: ModelAuth; port?: number; host?: string; origin?: string },
) {
  assert.equal(sessions.models, options.auth.models, "Sessions and login must share model auth");
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
  const loginRoute = new URLPattern("login/:action?", base.href);
  const sessionRoute = new URLPattern("api/s/:session", base.href);
  const sessionAction = new URLPattern("api/s/:session/:action", base.href);
  const conversationRoute = new URLPattern("api/s/:session/c/:conversation/:action?", base.href);
  const submissionRoute = new URLPattern(
    "api/s/:session/c/:conversation/submissions/status",
    base.href,
  );
  const inFlight = new Set<Promise<void>>();
  let closing = false;
  const server = createServer((request, response) => {
    const input: { form?: FormData } = {};
    const work = route(request, response, input)
      .catch((error: unknown) => {
        if (response.destroyed) return;
        const failure = httpFailure(error);
        if (failure.unexpected) console.error("PDS request failed unexpectedly.");
        const requestId = input.form?.get("requestId");
        const invalid =
          error instanceof InvalidForm
            ? invalidForm(error.issue, typeof requestId === "string" ? requestId : undefined)
            : undefined;
        if (response.headersSent) response.destroy();
        else if (request.headers["datastar-request"] === "true" && error instanceof InvalidForm) {
          response.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-store",
          });
          response.end(patch(invalid!));
        } else {
          response.writeHead(failure.status, {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
          });
          response.end(page("Error", invalid ?? alert(failure.message), "home", prefix));
        }
      })
      .finally(() => {
        inFlight.delete(work);
      });
    inFlight.add(work);
  });

  async function route(
    request: IncomingMessage,
    response: ServerResponse,
    input: { form?: FormData },
  ) {
    assert(request.url);
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cache-Control", "no-store");
    if (closing) throw new SessionUnavailable("PDS is closing.");
    const url = new URL(request.url, base);
    async function readForm() {
      input.form = await formData(request, url);
      return input.form;
    }
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
    const loginMatch = loginRoute.exec(url.href);
    if (loginMatch) {
      response.setHeader("Referrer-Policy", "same-origin");
      const action = loginMatch.pathname.groups.action;
      const auth = options.auth;
      // Disconnecting observation must not cancel the owner-scoped login itself.
      const abort = new AbortController();
      response.once("close", () => abort.abort());
      const view = (provider?: string) => auth.view(provider, { signal: abort.signal });
      if (!action || action === "status") {
        method(request, response, ["GET"]);
        queryFields(request, url, ["provider"]);
        const provider = url.searchParams.get("provider") ?? undefined;
        if (provider !== undefined && !auth.models.getProvider(provider))
          throw new InvalidRequest("Select an available provider.");
        const snapshot = await view(provider);
        if (action === "status") sse(response, patch(loginPanel(snapshot, prefix)));
        else html(response, loginPage(snapshot, prefix));
        return;
      }
      if (!["start", "respond", "cancel", "logout"].includes(action))
        throw new HttpError(404, "Not found.");
      method(request, response, ["POST"]);
      queryFields(request, url, []);
      const form = await readForm();
      fields(
        form,
        action === "start"
          ? ["provider", "method"]
          : action === "respond"
            ? ["provider", "attempt", "prompt", "answer"]
            : action === "cancel"
              ? ["provider", "attempt"]
              : ["provider"],
      );
      const provider = field(form, "provider");
      if (!auth.models.getProvider(provider))
        throw new InvalidRequest("Select an available provider.");
      let notice = "";
      try {
        if (action === "start") auth.start(provider, field(form, "method"));
        else if (action === "respond")
          auth.respond(
            provider,
            field(form, "attempt"),
            field(form, "prompt"),
            field(form, "answer"),
          );
        else if (action === "cancel") await auth.cancel(provider, field(form, "attempt"));
        else await auth.logout(provider);
      } catch (error) {
        if (!(error instanceof LoginError)) throw error;
        notice = error.message;
      }
      if (request.headers["datastar-request"] === "true")
        sse(response, patch(alert(notice)) + patch(loginPanel(await view(provider), prefix)));
      else if (notice) html(response, loginPage(await view(provider), prefix, notice));
      else
        response
          .writeHead(303, { Location: `${prefix}/login?${new URLSearchParams({ provider })}` })
          .end();
      return;
    }
    if (url.pathname === base.pathname) {
      method(request, response, ["GET", "POST"]);
      queryFields(request, url, []);
      if (request.method === "GET") html(response, await home(sessions, prefix));
      else {
        const form = await readForm();
        fields(form, [
          "sessionId",
          "model",
          "thinking",
          "cwd",
          "env",
          "clear",
          ...submissionFields,
        ]);
        const result = await sessions.compose(form);
        const destination = conversationPath(prefix, result.sessionId, result.conversation.id);
        if (result.submissionId === undefined) navigate(request, response, destination);
        else if (request.headers["datastar-request"] === "true")
          sse(
            response,
            patch(alert()) +
              acknowledge({
                action: "submit",
                scope: destination,
                id: result.submissionId,
                requestId: form.has("requestId") ? field(form, "requestId") : undefined,
              }),
          );
        else
          response
            .writeHead(303, { Location: `${destination}?submissionId=${result.submissionId}` })
            .end();
      }
      return;
    }
    if (url.pathname === new URL("thinking", base).pathname) {
      method(request, response, ["POST"]);
      queryFields(request, url, []);
      const form = await readForm();
      fields(form, ["sessionId", "model", "thinking", "cwd", "env", "clear", ...submissionFields]);
      sse(response, patch(thinking(sessions, field(form, "model"), field(form, "thinking"))));
      return;
    }
    if (url.pathname === new URL("api/s", base).pathname) {
      method(request, response, ["GET"]);
      queryFields(request, url, []);
      navigate(request, response, `${prefix}/`);
      return;
    }
    if (url.pathname === new URL("api/s/open", base).pathname) {
      // GET still addresses the opaque session ID "open".
      method(request, response, ["GET", "POST"]);
      if (request.method === "POST") {
        queryFields(request, url, []);
        const form = await readForm();
        fields(form, ["sessionId"]);
        const app = await sessions.open(
          form.has("sessionId") ? decode(SessionId, field(form, "sessionId")) : undefined,
        );
        navigate(request, response, sessionPath(prefix, app.id));
        return;
      }
    }
    const statusMatch = submissionRoute.exec(url.href)?.pathname.groups;
    const conversationMatch = statusMatch
      ? { ...statusMatch, action: "submissions/status" }
      : conversationRoute.exec(url.href)?.pathname.groups;
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
      ? action === undefined ||
        ["watch", "entries", "submissionByRequest", "submissions/status"].includes(action)
      : action === undefined;
    const write = conversationMatch
      ? ["submit", "composer", "configure", "abortSubmission", "abort", "compact"].includes(
          action ?? "",
        )
      : ["root", "createConversation", "resume"].includes(action ?? "");
    if (!read && !write) throw new HttpError(404, "Not found.");
    method(request, response, read ? ["GET"] : ["POST"]);
    queryFields(
      request,
      url,
      action === "entries"
        ? ["minEntryId", "maxEntryId", "order", "cursor", "projection"]
        : action === "submissionByRequest"
          ? ["requestId"]
          : action === "submissions/status"
            ? ["id"]
            : action === undefined && conversationMatch
              ? ["submissionId", "withdrawal", "id", "aborted"]
              : [],
    );
    const app = await sessions.get(sessionId);
    if (!app) throw new HttpError(404, "Session not found.");
    if (!conversationMatch) {
      if (!action) navigate(request, response, `${prefix}/`);
      else if (action === "resume") {
        fields(await readForm(), []);
        app.harness.resume();
        if (request.headers["datastar-request"] === "true")
          sse(response, acknowledge({ action: "resume", scope: sessionPath(prefix, app.id) }));
        else navigate(request, response, `${prefix}/`);
      } else {
        const form = await readForm();
        fields(
          form,
          action === "root"
            ? ["model", "thinking", "cwd", "env", "clear"]
            : ["model", "thinking", "cwd", "env", "clear", "ownership", "taskId"],
        );
        let ownership: D.ConversationOwnership = { kind: "ownerless" };
        if (form.has("ownership")) {
          const kind = field(form, "ownership");
          if (kind === "task") {
            const taskId = decode(TaskId, field(form, "taskId"));
            if (!(await app.harness.getTask(taskId, context)))
              throw new InvalidForm({
                kind: "field",
                field: "taskId",
                message: "Owning task does not exist in this session.",
              });
            ownership = { kind: "task", taskId };
          } else if (kind !== "ownerless")
            throw new InvalidForm({
              kind: "field",
              field: "ownership",
              message: "Unknown conversation ownership.",
            });
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
    const statusOf = async (id: D.SubmissionId) => {
      try {
        const handle = await app.harness.submission(id, context);
        const record = await handle?.status(context);
        return record?.conversationId === conversation.id ? record : undefined;
      } catch (error) {
        if (error instanceof StorageRequestError)
          throw new InvalidRequest("Invalid submission read.", { cause: error });
        throw error;
      }
    };
    if (action === "submissionByRequest" || action === "submissions/status") {
      const requestId = url.searchParams.get("requestId");
      if (
        action === "submissionByRequest" &&
        (requestId === null || !requestId.trim() || requestId.length > 200)
      )
        throw new InvalidRequest("Use a nonempty request ID of at most 200 characters.");
      const record =
        action === "submissions/status"
          ? await statusOf(decode(SubmissionId, url.searchParams.get("id")))
          : await app.harness
              .commit((tx) => tx.submissionByRequest(conversation.id, requestId!), context)
              .catch((error: unknown) => {
                if (error instanceof StorageRequestError)
                  throw new InvalidRequest("Invalid submission read.", { cause: error });
                throw error;
              });
      const receipt = record && { ...record };
      if (receipt) delete receipt.trace;
      if (request.headers["datastar-request"] === "true")
        sse(
          response,
          acknowledge({
            action: "receipt",
            scope: path,
            record: receipt,
            requestId: record?.requestId ?? requestId ?? undefined,
          }),
        );
      else navigate(request, response, path);
    } else if (!action) {
      const abort = new AbortController();
      response.once("close", () => abort.abort());
      const watch = await observe(app, conversation, abort.signal);
      const initial = watch.value;
      await watch.stop();
      if (url.searchParams.has("submissionId"))
        decode(SubmissionId, url.searchParams.get("submissionId"));
      const withdrawal = url.searchParams.get("withdrawal");
      if (withdrawal !== null) {
        if (
          withdrawal !== "aborted" &&
          withdrawal !== "already_placed" &&
          withdrawal !== "settled" &&
          withdrawal !== "not_found"
        )
          throw new InvalidRequest("Invalid withdrawal result.");
        decode(SubmissionId, url.searchParams.get("id"));
      } else if (url.searchParams.has("id"))
        throw new InvalidRequest("Submission ID requires a withdrawal result.");
      if (url.searchParams.has("aborted")) {
        if (url.searchParams.get("aborted") !== "true" || withdrawal !== null)
          throw new InvalidRequest("Invalid abort acknowledgement.");
      }
      const markup = await conversationPage(app, conversation, initial, prefix);
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(markup);
    } else if (request.method === "GET" && action === "watch") {
      const abort = new AbortController();
      response.once("close", () => abort.abort());
      const watch = await observe(app, conversation, abort.signal);
      try {
        const projection = new Projection(path, {
          configuration: () => configuration(app, conversation, prefix),
          metadata: (view) => metadata(app, conversation, view),
        });
        const render = async (
          value: typeof watch.value,
          ops?: Parameters<Projection["update"]>[1],
        ) =>
          (await projection.update(value, ops))
            .map(({ html: markup, ...patchOptions }) => patch(markup, patchOptions))
            .join("");
        // Acquisition and first rendering can still return a declared HTTP error.
        const baseline = await render(watch.value);
        const compressed =
          request.headers["accept-encoding"]?.split(/[, ]+/).includes("gzip") ?? false;
        const output = stream(response, compressed, abort.signal);
        await output.write(
          patch('<div id="connection" class="sr-only" role="status">Connected</div>') + baseline,
        );
        let delivery: Promise<void> | undefined;
        watch.start((call) => {
          assert(call.kind === "value");
          delivery = render(call.value, call.ops).then((events) => output.write(events));
          return delivery;
        });
        const end = await watch.closed;
        // stop/abort detaches immediately; a callback already running must finish too.
        // Watch.closed carries its failure; joining here must not replace that outcome.
        await delivery?.catch(() => {});
        if (response.destroyed) return;
        if (end.kind === "failed" || end.kind === "listener_error")
          await output.write(
            patch(
              '<div id="connection" role="status">Conversation stream failed. Reconnecting…</div>',
            ),
          );
        output.end();
      } finally {
        await watch.stop();
      }
    } else if (request.method === "GET" && action === "entries") {
      const selection = historyQuery(url.searchParams);
      const result = await readHistory(conversation, selection);
      if (request.headers["datastar-request"] === "true") {
        // Consume this exact placeholder. A duplicate or stale response has no target.
        sse(
          response,
          patch(historyPage(path, selection, result), {
            selector: `#${historyId(path, selection)}`,
            mode: "replace",
          }),
        );
      } else navigate(request, response, path);
    } else if (request.method === "POST" && (action === "composer" || action === "submit")) {
      const form = await readForm();
      fields(form, submissionFields);
      const result =
        action === "composer"
          ? await app.send(conversation, form)
          : await app.submit(conversation, form);
      const next = typeof result === "object" ? result : undefined;
      if (request.headers["datastar-request"] !== "true") {
        response
          .writeHead(303, {
            Location:
              conversationPath(prefix, app.id, next?.id ?? conversation.id) +
              (typeof result === "number" ? `?submissionId=${result}` : ""),
          })
          .end();
        return;
      }
      let events: string;
      if (next) events = redirect(conversationPath(prefix, app.id, next.id));
      else if (typeof result === "number")
        events =
          patch(alert()) +
          acknowledge({
            action: "submit",
            scope: path,
            id: result,
            requestId: form.has("requestId") ? field(form, "requestId") : undefined,
          });
      else events = patch(alert()) + script("document.getElementById('composer').reset()");
      sse(response, events);
    } else if (request.method === "POST" && action === "configure") {
      const form = await readForm();
      fields(form, ["model", "thinking", "cwd", "env", "clear"]);
      await app.configure(conversation, form);
      if (request.headers["datastar-request"] !== "true") {
        response.writeHead(303, { Location: path }).end();
        return;
      }
      sse(response, patch(alert()));
    } else if (action === "abortSubmission") {
      const form = await readForm();
      fields(form, ["id"]);
      const id = decode(SubmissionId, form.get("id"));
      const result = await app.harness.abortSubmission(id, context, conversation.id);
      if (request.headers["datastar-request"] === "true")
        sse(response, acknowledge({ action: "abortSubmission", scope: path, id, result }));
      else navigate(request, response, `${path}?withdrawal=${result}&id=${id}`);
    } else if (request.method === "POST" && action === "abort") {
      fields(await readForm(), []);
      await conversation.abort(context);
      if (request.headers["datastar-request"] === "true")
        sse(response, acknowledge({ action: "abort", scope: path }));
      else navigate(request, response, `${path}?aborted=true`);
    } else if (action === "compact") {
      const form = await readForm();
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
      await options.auth.close();
      await closed;
      await Promise.allSettled(inFlight);
    },
  };
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

function httpFailure(error: unknown): { status: number; message: string; unexpected?: boolean } {
  if (error instanceof HttpError) return { status: error.status, message: error.message };
  if (error instanceof InvalidForm) return { status: 200, message: error.message };
  if (error instanceof InvalidRequest) return { status: 400, message: error.message };
  if (error instanceof SessionUnavailable || error instanceof SessionFailed)
    return { status: 503, message: "Session is unavailable." };
  if (error instanceof ConversationBusy || error instanceof ConversationIdle)
    return { status: 409, message: error.message };
  return {
    status: 500,
    message: "Request failed. Check the conversation before resending.",
    unexpected: true,
  };
}

function fields(input: FormData | URLSearchParams, allowed: readonly string[]) {
  for (const name of input.keys()) {
    if (
      !allowed.includes(name) ||
      (!["attachments", "clear"].includes(name) && input.getAll(name).length !== 1)
    )
      throw new InvalidRequest("Unknown or repeated request field.");
    if (name === "attachments" && input.getAll(name).some((value) => !(value instanceof File)))
      throw new InvalidRequest("Expected a file field.");
    if (name !== "attachments" && input.getAll(name).some((value) => typeof value !== "string"))
      throw new InvalidRequest("Expected a text field.");
  }
}

function queryFields(request: IncomingMessage, url: URL, allowed: readonly string[]) {
  if (
    request.method === "GET" &&
    (Number(request.headers["content-length"]) > 0 || request.headers["transfer-encoding"])
  )
    throw new InvalidRequest("GET requests must not contain a body.");
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
