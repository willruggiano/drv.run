import type { GlobalSettingsStore } from "../server.ts";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "@earendil-works/chord/context";
import type { SubmissionId } from "@earendil-works/pi-durable";
import {
  getConversation,
  sessionInfo,
  completePaths,
  completeWorkingDirectories,
  changeDirectory,
  rename,
  type Sessions,
} from "../sessions.ts";
import {
  form,
  field,
  inputContent,
  FormError,
  saveSessionSettings,
  createSession,
} from "../forms.ts";
import { conversationURL, history } from "../presentation.ts";
import { Review } from "harness";
import { startReview, endReview } from "../review.ts";
import { selectionOptions, directoryCompletions } from "../settings.ts";
import {
  completionToken,
  commandCompletions,
  pathCompletion,
  directoryCompletion,
} from "../completions.ts";
import { conversationFrames } from "./stream.ts";

function json(response: ServerResponse, value: unknown) {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}
export function elmDocument(response: ServerResponse, site = false): void {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#151719"><title>Pi</title><link rel="icon" href="/icon.svg"><link rel="manifest" href="/manifest.webmanifest"><link rel="stylesheet" href="/styles.css"><script src="/main.js" defer></script><script src="/${site ? "site" : "client"}.js" type="module"></script></head><body class="stacked-layout bottom-align"><div id="elm"></div></body></html>`,
  );
}
export async function elmFrontend(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  sessions: Sessions,
  context: Context,
  settings?: GlobalSettingsStore,
): Promise<void> {
  const root = /^\/sessions\/([^/]+)$/.exec(url.pathname);
  if (root && request.method === "GET") {
    response.writeHead(303, {
      Location: conversationURL(await sessions.get(root[1])),
    });
    response.end();
    return;
  }
  const match =
    /^\/sessions\/([^/]+)\/conversations\/(\d+)(?:\/(events|command|completions|receipt|panel|settings|context|branches|tree|reset|compact|export|directories|archive))?$/.exec(
      url.pathname,
    );
  if (!match) throw new FormError(404, "Not found.");
  const operation = match[3];
  if (operation === "archive") {
    if (request.method !== "POST") throw new FormError(405, "Method not allowed.");
    await form(request);
    await sessions.archive(match[1]);
    json(response, { archived: true });
    return;
  }
  const session = await sessions.get(match[1]);
  const conversation = await getConversation(session, Number(match[2]), context);
  if (
    request.method === "GET" &&
    (!operation ||
      ["settings", "context", "branches", "tree", "reset", "compact"].includes(operation))
  ) {
    elmDocument(response);
    return;
  }
  if (request.method === "GET" && operation === "panel") {
    const pane = url.searchParams.get("view");
    if (pane === "settings") {
      const choices = await sessions.choices(context);
      const info = await sessionInfo(session, conversation, choices.targets, context);
      json(response, selectionOptions(choices, info));
    } else throw new FormError(400, "Unknown panel.");
    return;
  }
  if (request.method === "GET" && operation === "directories") {
    json(
      response,
      await directoryCompletions(
        sessions,
        url.searchParams.get("target"),
        url.searchParams.get("directory") ?? "",
        context,
      ),
    );
    return;
  }
  if (request.method === "POST" && operation === "settings") {
    await saveSessionSettings(await form(request), sessions, session, conversation, context);
    json(response, { saved: true });
    return;
  }
  if (request.method === "GET" && operation === "export") {
    response.setHeader("Content-Type", "application/json");
    response.setHeader(
      "Content-Disposition",
      `attachment; filename="pi-${session.id}-${conversation.id}.json"`,
    );
    response.end(JSON.stringify(await history(conversation, context), null, 2));
    return;
  }
  if (request.method === "GET" && operation === "receipt") {
    const requestId = url.searchParams.get("requestId") ?? "";
    if (!requestId.trim() || requestId.length > 200)
      throw new FormError(400, "Invalid request identity.");
    const submission = await session.harness.commit(
      (tx) => tx.submissionByRequest(conversation.id, requestId),
      context,
    );
    // Presence acknowledges admission, not successful execution. A missing receipt is not proof of failure.
    json(response, { accepted: submission?.type === "input" });
    return;
  }
  if (request.method === "GET" && operation === "completions") {
    const text = url.searchParams.get("text") ?? "";
    const caret = Number(url.searchParams.get("caret"));
    if (text.length > 100_000 || !Number.isSafeInteger(caret) || caret < 0 || caret > text.length)
      throw new FormError(400, "Invalid completion query.");
    const token = completionToken(text, caret);
    const items =
      token?.kind === "command"
        ? commandCompletions(
            token.query,
            (await session.harness.snapshot(Review, conversation.id, context))?.original !==
              undefined,
          )
        : token?.kind === "directory"
          ? (await completeWorkingDirectories(session, token.query, conversation, context)).map(
              directoryCompletion,
            )
          : token?.kind === "path"
            ? (await completePaths(session, token.query, conversation, context)).map(pathCompletion)
            : [];
    json(response, {
      start: token?.start ?? caret,
      end: token?.end ?? caret,
      items,
    });
    return;
  }
  if (request.method === "GET" && operation === "events") {
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    try {
      for await (const frame of conversationFrames(session, conversation, context, {
        pane: url.searchParams.get("pane"),
        settings,
      })) {
        if (response.destroyed) break;
        if (!response.headersSent) {
          response.writeHead(200, {
            "Content-Type": "text/event-stream",
            "X-Accel-Buffering": "no",
          });
          heartbeat = setInterval(() => {
            if (response.writableLength > 1024 * 1024) response.destroy();
            else response.write(": heartbeat\n\n");
          }, 15_000);
        }
        if (response.writableLength > 1024 * 1024) {
          response.destroy();
          break;
        }
        response.write(`data: ${JSON.stringify(frame)}\n\n`);
      }
      if (!response.destroyed) response.end();
    } catch {
      response.destroy();
    } finally {
      clearInterval(heartbeat);
    }
    return;
  }
  if (request.method !== "POST" || operation !== "command")
    throw new FormError(405, "Method not allowed.");
  let data: FormData;
  if (request.headers["content-type"]?.split(";")[0] === "application/json") {
    if (!request.headers.origin) throw new FormError(403, "Origin header required.");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > 128 * 1024) throw new FormError(413, "Request too large.");
      chunks.push(buffer);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      throw new FormError(400, "Invalid JSON.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new FormError(400, "Expected an object.");
    data = new FormData();
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== "string") throw new FormError(400, "Expected string fields.");
      data.set(key, value);
    }
  } else data = await form(request, 8 * 1024 * 1024);
  const command = field(data, "command", 20);
  const requestId = field(data, "requestId", 200);
  const revision = field(data, "revision", 200);
  if (!requestId.trim() || !revision.trim()) throw new FormError(400, "Missing request identity.");
  const argument = data.has("argument") ? field(data, "argument") : "";
  if (command === "submit") {
    if (data.has("content") && field(data, "content").trimStart().startsWith("/"))
      throw new FormError(400, "Slash commands must use the command interface.");
    const content = await inputContent(data);
    if (content === undefined) throw new FormError(400, "Enter a message or attach an image.");
    const mode = field(data, "whenBusy", 20);
    if (mode !== "reject" && mode !== "steer" && mode !== "followUp")
      throw new FormError(400, "Invalid submission mode.");
    await conversation.submit({ type: "input", requestId, content, whenBusy: mode }, context);
  } else if (command === "new") {
    const info = await sessionInfo(session, conversation, undefined, context);
    if (!info.binding || !info.model) throw new FormError(409, "Target or model is unavailable.");
    const creation = new FormData();
    for (const [key, value] of Object.entries({
      id: randomUUID(),
      target: JSON.stringify([info.binding.provider, info.binding.target]),
      model: JSON.stringify([info.model.provider, info.model.modelId]),
      thinkingLevel: info.thinkingLevel,
      baseDirectory:
        info.directoryRoot && info.cwd.startsWith(info.directoryRoot + "/")
          ? info.cwd.slice(info.directoryRoot.length + 1)
          : "",
    }))
      creation.set(key, value);
    const created = await createSession(creation, sessions, context);
    json(response, { requestId, revision, path: conversationURL(created) });
    return;
  } else if (command === "abort") await conversation.abort(context);
  else if (command === "resume") session.harness.resume();
  else if (command === "compact") await conversation.compact(argument || undefined, context);
  else if (command === "reset") await conversation.reset(argument || undefined, context);
  else if (command === "cancel") {
    const id = Number(argument);
    if (!Number.isSafeInteger(id) || id < 0) throw new FormError(400, "Invalid submission ID.");
    const result = await session.harness.abortSubmission(
      id as SubmissionId,
      context,
      conversation.id,
    );
    if (result !== "aborted") {
      if (result === "not_found")
        throw new FormError(404, "Submission not found in this conversation.");
      if (result === "already_placed") throw new FormError(409, "Submission was already placed.");
    }
  } else if (command === "cd") await changeDirectory(session, argument, conversation, context);
  else if (command === "rename") await rename(session, argument);
  else if (command === "review" || command === "endreview") {
    const result =
      command === "review"
        ? await startReview(session, conversation, context, argument || undefined)
        : await endReview(session, conversation, context);
    json(response, { requestId, revision, path: conversationURL(session, result.id) });
    return;
  } else throw new FormError(400, "Unsupported command.");
  json(response, { requestId, revision });
}
