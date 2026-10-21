import * as runtime from "./sessions.ts";
import { openApplication } from "./application.ts";
import { ownerOptions } from "./instances.ts";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
  awaitWithContext,
} from "@earendil-works/chord/context";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getAgentDir, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  ConversationBusy,
  StorageRequestError,
  type Cursor,
  type SubmissionId,
  type SubmissionDraft,
  type AgentChange,
  type ConversationCreateOptions,
  type EntryId,
  type WatchHandle,
  AgentDoc,
  InboxDoc,
  LiveDoc,
  UsageDoc,
  ProviderDoc,
} from "@earendil-works/pi-durable";
import {
  DEFAULT_THINKING_LEVEL,
  stateDirectory,
  Sessions,
  SessionError,
  type SessionOptions,
} from "./sessions.ts";
import { settingFields, thinkingLevels, type GlobalSettings } from "./settings.ts";

export class GlobalSettingsStore {
  readonly manager: SettingsManager;
  private writes: Promise<void> = Promise.resolve();
  private readonly observers = new Set<() => void>();

  watch(observer: () => void): () => void {
    this.observers.add(observer);
    return () => {
      this.observers.delete(observer);
    };
  }

  constructor(manager: SettingsManager) {
    this.manager = manager;
    const errors = manager.drainErrors();
    if (errors.length) throw errors[0].error;
  }

  read(): GlobalSettings {
    const s = this.manager;
    const compaction = s.getCompactionSettings();
    const retry = s.getRetrySettings();
    const provider = s.getDefaultProvider(),
      modelId = s.getDefaultModel();
    return {
      model: provider && modelId ? { provider, modelId } : null,
      modelThinkingLevels: s.getAllModelThinkingLevels(),
      values: {
        defaultThinkingLevel: s.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL,
        transport: s.getTransport(),
        steeringMode: s.getSteeringMode(),
        followUpMode: s.getFollowUpMode(),
        "compaction.enabled": compaction.enabled,
        "compaction.reserveTokens": compaction.reserveTokens,
        "compaction.keepRecentTokens": compaction.keepRecentTokens,
        "retry.enabled": retry.enabled,
        "retry.maxRetries": retry.maxRetries,
        "retry.baseDelayMs": retry.baseDelayMs,
        "retry.maxAgentDelayMs": retry.maxAgentDelayMs,
        hideThinkingBlock: s.getHideThinkingBlock(),
        "terminal.showImages": s.getShowImages(),
      },
    };
  }

  // Getters are intentional: Durable resolves host policy on every run. Agent
  // model/thinking remain persisted in the conversation, not changed by defaults.
  bind<T extends SessionOptions>(options: T): T & Pick<SessionOptions, "settings" | "defaults"> {
    const manager = this.manager;
    return {
      ...options,
      defaults: {
        get model() {
          const provider = manager.getDefaultProvider(),
            modelId = manager.getDefaultModel();
          return provider && modelId ? { provider, modelId } : undefined;
        },
        get thinkingLevel() {
          return manager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
        },
        get modelThinkingLevels() {
          return manager.getAllModelThinkingLevels();
        },
      },
      settings: {
        get stream() {
          return {
            transport: manager.getTransport(),
            ...manager.getProviderRetrySettings(),
          };
        },
        get retry() {
          return manager.getRetrySettings();
        },
        get compaction() {
          // Durable has harness-wide thresholds, not per-conversation/model overrides.
          return manager.getCompactionSettings();
        },
        get steeringMode() {
          return manager.getSteeringMode();
        },
        get followUpMode() {
          return manager.getFollowUpMode();
        },
      },
    };
  }

  update(data: Record<string, unknown>, sessions: Sessions): Promise<GlobalSettings> {
    const write = this.writes.then(() => this.apply(data, sessions));
    this.writes = write.then(
      () => {},
      () => {},
    );
    return write;
  }

  private async apply(data: Record<string, unknown>, sessions: Sessions): Promise<GlobalSettings> {
    for (const key of Object.keys(data))
      if (!["values", "model", "modelThinkingLevel"].includes(key))
        throw new RequestError(400, "Unknown settings field.");
    const values = data.values === undefined ? {} : object(data.values);
    for (const [key, value] of Object.entries(values)) {
      const field = settingFields.find((field) => field.key === key);
      if (!field || ("readonly" in field && field.readonly))
        throw new RequestError(400, `Unsupported setting: ${key}`);
      const valid =
        "choices" in field
          ? field.choices.some((choice) => choice === value)
          : typeof value === "boolean";
      if (!valid) throw new RequestError(400, `Invalid setting: ${key}`);
    }
    let model: { provider: string; modelId: string } | undefined;
    if (data.model !== undefined) {
      const ref = object(data.model);
      model = { provider: string(ref.provider, 200), modelId: string(ref.modelId, 300) };
      const available = await sessions.options.models.getAvailable();
      if (!available.some((item) => item.provider === model?.provider && item.id === model.modelId))
        throw new RequestError(400, "Model is unavailable.");
    }
    const level = data.modelThinkingLevel;
    if (level !== undefined && (!model || (level !== null && !isThinkingLevel(level))))
      throw new RequestError(400, "Invalid per-model thinking preference.");
    // Validate the entire request before scheduling any of Pi's locked writes.
    // Use public setters: applyOverrides() is not persistent.
    const s = this.manager;
    for (const [key, value] of Object.entries(values)) {
      if (key === "defaultThinkingLevel" && isThinkingLevel(value))
        s.setDefaultThinkingLevel(value);
      else if (
        key === "transport" &&
        (value === "auto" ||
          value === "sse" ||
          value === "websocket" ||
          value === "websocket-cached")
      )
        s.setTransport(value);
      else if (key === "steeringMode" && (value === "all" || value === "one-at-a-time"))
        s.setSteeringMode(value);
      else if (key === "followUpMode" && (value === "all" || value === "one-at-a-time"))
        s.setFollowUpMode(value);
      else if (key === "compaction.enabled" && typeof value === "boolean")
        s.setCompactionEnabled(value);
      else if (key === "retry.enabled" && typeof value === "boolean") s.setRetryEnabled(value);
      else if (key === "hideThinkingBlock" && typeof value === "boolean")
        s.setHideThinkingBlock(value);
      else if (key === "terminal.showImages" && typeof value === "boolean") s.setShowImages(value);
    }
    if (model) {
      s.setDefaultModelAndProvider(model.provider, model.modelId);
      if (level === null) s.removeModelThinkingLevel(model.provider, model.modelId);
      else if (isThinkingLevel(level))
        s.setModelThinkingLevel(model.provider, model.modelId, level);
    }
    await s.flush();
    const errors = s.drainErrors();
    if (errors.length) {
      await s.reload();
      throw errors[0].error;
    }
    for (const observer of this.observers) observer();
    return this.read();
  }
}

function isThinkingLevel(value: unknown): value is ModelThinkingLevel {
  return thinkingLevels.some((level) => level === value);
}

export class RequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RequestError(400, "Expected a JSON object.");
  return value as Record<string, unknown>;
}
function string(value: unknown, maximum = 100_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum)
    throw new RequestError(400, "Invalid text value.");
  return value;
}
async function body(
  request: IncomingMessage,
  maximum = 128 * 1024,
): Promise<Record<string, unknown>> {
  if (request.headers["content-type"]?.split(";")[0] !== "application/json")
    throw new RequestError(415, "Expected application/json.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > maximum) throw new RequestError(413, "Request too large.");
    chunks.push(buffer);
  }
  try {
    return object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError(400, "Invalid JSON.");
  }
}
function json(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(data));
}

async function stream<T>(watch: WatchHandle<T>, response: ServerResponse): Promise<void> {
  // The watch uses the request context; disconnect cancels it upstream.
  if (response.destroyed) return;
  response.writeHead(200, { "Content-Type": "text/event-stream", "X-Accel-Buffering": "no" });
  async function send(value: T, ops: readonly unknown[]) {
    if (response.destroyed) return;
    if (response.writableLength > 1024 * 1024) {
      response.destroy();
      return;
    }
    if (!response.write(`data: ${JSON.stringify({ value, ops })}\n\n`))
      await new Promise<void>((resolve) => {
        const done = () => {
          response.off("drain", done);
          response.off("close", done);
          resolve();
        };
        response.once("drain", done);
        response.once("close", done);
      });
  }
  await send(watch.value, []);
  if (response.destroyed) return;
  watch.start(send);
  const heartbeat = setInterval(() => {
    if (response.writableLength > 1024 * 1024) response.destroy();
    else response.write(": heartbeat\n\n");
  }, 15_000);
  void watch.closed.then((end) => {
    clearInterval(heartbeat);
    if (!response.destroyed) response.end(`event: end\ndata: ${JSON.stringify(end)}\n\n`);
  });
}

function queryObject(url: URL, name: "query" | "cursor"): Record<string, unknown> | undefined {
  const value = url.searchParams.get(name);
  if (value === null) return undefined;
  try {
    return object(JSON.parse(value));
  } catch {
    throw new RequestError(400, `Invalid ${name}.`);
  }
}

function directoryInput(value: unknown): string {
  if (typeof value !== "string") throw new RequestError(400, "Invalid base directory.");
  return value;
}

export function httpServer(
  sessions: Sessions,
  host: string,
  assets = dirname(fileURLToPath(import.meta.url)),
  publicOrigin?: string,
  settings?: GlobalSettingsStore,
) {
  const external = publicOrigin === undefined ? undefined : new URL(validateOrigin(publicOrigin));
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    void (async () => {
      // No authentication, but reject cross-site writes and DNS rebinding.
      const authority = request.headers.host;
      if (!authority) throw new RequestError(400, "Host header required.");
      const proxied = external?.host === authority;
      const origin = proxied ? external : new URL(`http://${authority}`);
      const hostname = origin.hostname.replace(/^\[|\]$/g, "");
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 80;
      const destination = host === "0.0.0.0" ? request.socket.localAddress : host;
      if (
        !proxied &&
        (![destination, ...(destination === "127.0.0.1" ? ["localhost"] : [])].includes(hostname) ||
          Number(origin.port || 80) !== port)
      )
        throw new RequestError(403, "Unexpected Host.");
      if (
        (request.headers.origin && request.headers.origin !== origin.origin) ||
        request.headers["sec-fetch-site"] === "cross-site"
      )
        throw new RequestError(403, "Cross-origin requests are not allowed.");
      const url = new URL(request.url ?? "/", origin);
      const controller = new AbortController();
      response.once("close", () => controller.abort());
      const context = withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
      if (request.method === "GET" && url.pathname === "/api/settings/watch") {
        if (!settings) return json(response, 200, null);
        response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
        const send = () => {
          if (response.writableLength > 1024 * 1024) response.destroy();
          else response.write(`data: ${JSON.stringify(settings.read())}\n\n`);
        };
        const stop = settings.watch(send);
        response.once("close", stop);
        send();
        return;
      }
      if (url.pathname === "/api/settings") {
        if (!settings) {
          if (request.method === "GET") return json(response, 200, null);
          throw new RequestError(503, "Shared settings are not configured.");
        }
        if (request.method === "GET") return json(response, 200, settings.read());
        if (request.method === "POST")
          return json(response, 200, await settings.update(await body(request), sessions));
        throw new RequestError(405, "Method not allowed.");
      }
      if (request.method === "GET" && url.pathname === "/api/catalog")
        return json(response, 200, await sessions.catalog(context));
      if (request.method === "POST" && url.pathname === "/api/directories") {
        const data = await body(request);
        const binding = object(data.binding);
        if (typeof data.query !== "string") throw new RequestError(400, "Invalid directory query.");
        return json(
          response,
          200,
          await sessions.completeDirectories(
            {
              provider: string(binding.provider, 200),
              target: string(binding.target, 4096),
              cwd: string(binding.cwd, 4096),
            },
            data.query,
            context,
          ),
        );
      }
      if (request.method === "POST" && url.pathname === "/api/sessions") {
        const data = await body(request);
        const model = data.model === undefined ? undefined : object(data.model);
        const binding = data.binding === undefined ? undefined : object(data.binding);
        if (data.thinkingLevel !== undefined && !isThinkingLevel(data.thinkingLevel))
          throw new RequestError(400, "Invalid thinking level.");
        const session = await sessions.create(
          string(data.id, 36),
          binding && {
            provider: string(binding.provider, 200),
            target: string(binding.target, 4096),
            cwd: string(binding.cwd, 4096),
          },
          model && {
            provider: string(model.provider, 200),
            modelId: string(model.modelId, 300),
          },
          data.thinkingLevel,
          data.baseDirectory === undefined ? undefined : directoryInput(data.baseDirectory),
        );
        return json(response, 201, await runtime.sessionInfo(session));
      }
      const harnessRoute = /^\/api\/harness\/([^/]+)\/([a-zA-Z/]+)$/.exec(url.pathname);
      if (harnessRoute) {
        const session = await awaitWithContext(sessions.get(harnessRoute[1]), context);
        const harness = session.harness;
        const conversation = await runtime.getConversation(
          session,
          url.searchParams.has("conversation")
            ? Number(url.searchParams.get("conversation"))
            : undefined,
          context,
        );
        const method = harnessRoute[2];
        if (request.method === "GET") {
          if (method === "watch") return stream(await conversation.watch(context), response);
          if (method === "snapshot" || method === "watchDoc") {
            const kind = url.searchParams.get("kind");
            // Only the document capabilities this application exposes. Tokens remain server-side.
            const token = [
              AgentDoc,
              InboxDoc,
              LiveDoc,
              ProviderDoc,
              UsageDoc,
              runtime.Environment,
              runtime.Metadata,
            ].find((token) => token.definition.kind === kind);
            if (!token) throw new RequestError(404, "Document capability is not exposed.");
            // Each token has the same conversation scope; widening its JSON value does not change its definition.
            const document = token as import("@earendil-works/pi-durable").ConversationDocToken<
              import("@earendil-works/pi-durable").JsonObject
            >;
            if (method === "snapshot")
              return json(
                response,
                200,
                (await harness.snapshot(document, conversation.id, context)) ?? null,
              );
            const watch = await harness.watchDoc(document, conversation.id, context);
            if (!watch) return json(response, 200, null);
            return await stream(watch, response);
          }
        }
        async function invoke(): Promise<unknown> {
          if (request.method === "GET") {
            if (method === "entries" || method === "scanTasks" || method === "scanConversations") {
              const args = [
                queryObject(url, "query") ?? {},
                Number(url.searchParams.get("limit") ?? 256),
                queryObject(url, "cursor") as Cursor | undefined,
              ] as const;
              if (method === "entries") return conversation.entries(...args, context);
              if (method === "scanTasks")
                return harness.commit((tx) => tx.scanTasks(...args), context);
              return harness.commit((tx) => tx.scanConversations(...args), context);
            }
            if (method === "context")
              return await conversation.context(
                context,
                url.searchParams.has("at")
                  ? { at: Number(url.searchParams.get("at")) as EntryId }
                  : undefined,
              );
            if (method === "inspect") return await harness.inspect(context);
            if (method === "getTask")
              return harness.getTask(
                Number(url.searchParams.get("id")) as Parameters<typeof harness.getTask>[0],
                context,
              );
            if (method === "submission/status") {
              const submission = await harness.submission(
                Number(url.searchParams.get("id")) as SubmissionId,
                context,
              );
              return submission?.status(context);
            }
          }
          if (request.method === "POST") {
            const data = await body(request, method === "submit" ? 8 * 1024 * 1024 : 128 * 1024);
            if (method === "submit") {
              if (data.requestId !== undefined && typeof data.requestId !== "string")
                throw new RequestError(400, "Invalid requestId.");
              if (data.type === "input") {
                if (
                  data.whenBusy !== undefined &&
                  (typeof data.whenBusy !== "string" ||
                    !["steer", "followUp", "reject"].includes(data.whenBusy))
                )
                  throw new RequestError(400, "Invalid whenBusy.");
                if (typeof data.content !== "string") {
                  if (!Array.isArray(data.content))
                    throw new RequestError(400, "Invalid input content.");
                  for (const item of data.content) {
                    const part = object(item);
                    if (part.type === "text" && typeof part.text === "string") continue;
                    if (
                      part.type === "image" &&
                      typeof part.data === "string" &&
                      typeof part.mimeType === "string"
                    )
                      continue;
                    throw new RequestError(400, "Invalid input content.");
                  }
                }
              } else if (data.type === "write") {
                const entry = object(data.entry);
                if (typeof entry.kind !== "string")
                  throw new RequestError(400, "Invalid entry kind.");
                if (entry.model !== undefined && !Array.isArray(entry.model))
                  throw new RequestError(400, "Invalid entry messages.");
              }
              if (data.type !== "input" && data.type !== "write")
                throw new RequestError(400, "Invalid submission type.");
              // Admission, content validation, deduplication and defaults belong to Durable.
              const submission = await conversation.submit(data as SubmissionDraft, context);
              return { id: submission.id };
            }
            if (method === "configure") {
              if (
                data.thinkingLevel !== undefined &&
                data.thinkingLevel !== null &&
                !isThinkingLevel(data.thinkingLevel)
              )
                throw new RequestError(400, "Invalid thinkingLevel.");
              for (const key of ["cwd", "instructions"])
                if (data[key] !== undefined && data[key] !== null && typeof data[key] !== "string")
                  throw new RequestError(400, `Invalid ${key}.`);
              if (data.model !== undefined && data.model !== null) {
                const ref = object(data.model);
                if (typeof ref.provider !== "string" || typeof ref.modelId !== "string")
                  throw new RequestError(400, "Invalid model reference.");
              }
              for (const key of ["extensions", "tools", "modelTools"]) {
                const selection = data[key];
                if (selection === undefined || selection === null) continue;
                const lists = Array.isArray(selection)
                  ? [selection]
                  : Object.values(object(selection));
                for (const list of lists) {
                  if (
                    !Array.isArray(list) ||
                    list.some((item) => typeof object(item).name !== "string")
                  )
                    throw new RequestError(400, `Invalid ${key} references.`);
                }
              }
              // Upstream applyChange persists reference names, not executable definitions.
              // Selecting a tool here does not install it in the application registry.
              return conversation.configure(data as AgentChange, context);
            }
            if (method === "resume") return harness.resume();
            if (method === "abort") return conversation.abort(context, data);
            if (method === "compact")
              return await conversation.compact(data.instructions as string | undefined, context);
            if (method === "reset")
              return conversation.reset(data.handoff as string | undefined, context);
            if (method === "fork") {
              if (!Number.isSafeInteger(data.at) || Number(data.at) < 0)
                throw new RequestError(400, "Invalid entry ID.");
              const options = object(data.options);
              object(options.ownership);
              if (options.init !== undefined)
                throw new RequestError(
                  501,
                  "Conversation initialization callbacks are server-side capabilities.",
                );
              const fork = await conversation.fork(
                data.at as EntryId,
                data.options as ConversationCreateOptions,
                context,
              );
              return { id: fork.id };
            }
            if (method === "abortSubmission") {
              if (!Number.isSafeInteger(data.id))
                throw new RequestError(400, "Invalid submission ID.");
              return await harness.abortSubmission(
                data.id as SubmissionId,
                context,
                data.conversationId as
                  | import("@earendil-works/pi-durable").ConversationId
                  | undefined,
              );
            }
            if (method === "submission/wait" || method === "submission/abort") {
              const submission = await harness.submission(data.id as SubmissionId, context);
              if (!submission) throw new RequestError(404, "Submission not found.");
              return method === "submission/wait"
                ? await submission.wait(context)
                : await submission.abort(context);
            }
          }
          throw new RequestError(405, "Method not exposed for this resource.");
        }
        return json(response, 200, (await invoke()) ?? null);
      }
      const match =
        /^\/api\/sessions\/([^/]+)\/(info|context-status|inspection|rename|repository|completions|environment)$/.exec(
          url.pathname,
        );
      if (match) {
        const session = await awaitWithContext(sessions.get(match[1]), context);
        const conversation = await runtime.getConversation(
          session,
          url.searchParams.has("conversation")
            ? Number(url.searchParams.get("conversation"))
            : undefined,
          context,
        );
        if (request.method === "GET") {
          if (match[2] === "info")
            return json(
              response,
              200,
              await runtime.sessionInfo(session, conversation, undefined, context),
            );
          if (match[2] === "completions")
            return json(
              response,
              200,
              await runtime.completePaths(
                session,
                url.searchParams.get("query") ?? "",
                conversation,
                context,
              ),
            );
          if (match[2] === "repository")
            return json(response, 200, await runtime.repository(session, conversation, context));
          if (match[2] === "inspection" || match[2] === "context-status") {
            const watch = await conversation.watch(context);
            try {
              return json(
                response,
                200,
                match[2] === "inspection"
                  ? await runtime.inspectContext(session, watch.value, context)
                  : runtime.contextStatus(session, watch.value),
              );
            } finally {
              await watch.stop();
            }
          }
        }
        if (request.method === "POST") {
          const data = await body(request);
          if (match[2] === "rename") {
            if (typeof data.name !== "string") throw new RequestError(400, "Invalid session name.");
            await runtime.rename(session, data.name);
            return json(response, 200, await runtime.sessionInfo(session, conversation));
          }
          if (match[2] === "environment") {
            const selected = object(data.binding);
            await runtime.selectEnvironment(
              session,
              {
                provider: string(selected.provider),
                target: string(selected.target),
                cwd: string(selected.cwd),
              },
              conversation,
            );
            return json(response, 200, null);
          }
        }
        throw new RequestError(405, "Method not allowed.");
      }
      if (
        request.method === "GET" &&
        [
          "/",
          "/client.js",
          "/highlight.js",
          "/styles.css",
          "/design-system.html",
          "/manifest.webmanifest",
          "/icon.svg",
          "/icon-192.png",
          "/icon-512.png",
          "/sw.js",
        ].includes(url.pathname)
      ) {
        const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        const types: Record<string, string> = {
          "index.html": "text/html; charset=utf-8",
          "client.js": "text/javascript; charset=utf-8",
          "highlight.js": "text/javascript; charset=utf-8",
          "styles.css": "text/css; charset=utf-8",
          "design-system.html": "text/html; charset=utf-8",
          "manifest.webmanifest": "application/manifest+json",
          "icon.svg": "image/svg+xml",
          "icon-192.png": "image/png",
          "icon-512.png": "image/png",
          "sw.js": "text/javascript; charset=utf-8",
        };
        if (file === "manifest.webmanifest") {
          response.setHeader("Content-Type", types[file]);
          return response.end(
            JSON.stringify({
              id: "/",
              scope: "/",
              name: "Pi · durable workspace",
              short_name: "Pi",
              start_url: "/",
              display: "standalone",
              background_color: "#101217",
              theme_color: "#101217",
              icons: [192, 512].map((size) => ({
                src: `/icon-${size}.png`,
                sizes: `${size}x${size}`,
                type: "image/png",
                purpose: "any maskable",
              })),
            }),
          );
        }
        if (file === "icon.svg") {
          response.setHeader("Content-Type", types[file]);
          return response.end(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="128" height="128" rx="28" fill="#101217"/><text x="64" y="90" text-anchor="middle" font-size="92" fill="#9dd5ae">π</text></svg>',
          );
        }
        const data = await readFile(join(assets, file));
        response.setHeader("Content-Type", types[file]);
        return response.end(data);
      }
      throw new RequestError(404, "Not found.");
    })().catch((error: unknown) => {
      if (response.destroyed) return;
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error instanceof ConversationBusy)
        json(response, 409, {
          error: error.message,
          name: error.name,
          conversationId: error.conversationId,
        });
      else if (error instanceof TypeError || error instanceof StorageRequestError)
        json(response, 400, { name: error.name, error: error.message });
      else if (error instanceof RequestError)
        json(response, error.status, { error: error.message });
      else if (error instanceof SessionError) {
        const statuses = {
          invalid: 400,
          not_found: 404,
          unavailable: 409,
          conflict: 409,
          closing: 503,
        };
        json(response, statuses[error.code], { error: error.message });
      } else {
        console.error(error);
        json(response, 500, {
          name: error instanceof Error ? error.name : "Error",
          error: error instanceof Error ? error.message : "Internal server error.",
        });
      }
    });
  });
  server.requestTimeout = 30_000;
  return server;
}

function validateOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(
      "--origin must be an HTTPS origin, without credentials, path, query or fragment.",
    );
  return url.origin;
}

export function parseOptions(args: string[]) {
  let host = "0.0.0.0",
    port = 8080,
    directory = join(stateDirectory(), "pi-serve"),
    cwd = process.cwd(),
    local = true,
    drvRun = false;
  let publicOrigin: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    if (option === "--drv-run") {
      drvRun = true;
      continue;
    }
    if (option === "--no-local") {
      local = false;
      continue;
    }
    const value = args[++i];
    if (!value) throw new Error(`Missing value for ${option}`);
    if (option === "--host") host = value;
    else if (option === "--port") port = Number(value);
    else if (option === "--state") directory = resolve(value);
    else if (option === "--cwd") cwd = resolve(value);
    else if (option === "--origin") publicOrigin = validateOrigin(value);
    else throw new Error(`Unknown option: ${option}`);
  }
  if (!isIP(host) || host === "::")
    throw new Error("--host must be an IP address; IPv6 wildcard binding is not supported.");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port.");
  if (!local && !drvRun) throw new Error("--no-local requires --drv-run.");
  return { host, port, directory, cwd, local, drvRun, publicOrigin };
}

export async function main(args: string[]): Promise<void> {
  if (args.includes("--help")) {
    console.log(`Usage: pi-serve [--host IP] [--port PORT] [--state DIRECTORY]
                [--cwd DIRECTORY] [--drv-run] [--no-local] [--origin HTTPS_ORIGIN]

Runs pi-durable with a web frontend. Defaults to local tools in the launch directory.
The standard application installs coding extensions and selects available environments.
Uses ~/.pi/agent model settings and credentials (PI_CODING_AGENT_DIR supported).
Run pi /login to configure credentials.
History survives restart; opening does not resume interrupted work.
Default: unauthenticated HTTP on 0.0.0.0:8080. No TLS or browser authentication.
HTTP does not provide secure-context PWA features outside localhost.
For a trusted HTTPS reverse proxy, bind --host 127.0.0.1 and set --origin to its
exact HTTPS origin. The proxy must preserve Host. Forwarded headers are ignored.
This does not add authentication: restrict access at the proxy/network boundary.`);
    return;
  }
  const { host, port, directory, cwd, drvRun, local, publicOrigin } = parseOptions(args);
  process.umask(0o077);
  const models = await ModelRuntime.create();
  const settings = new GlobalSettingsStore(
    SettingsManager.create(homedir(), getAgentDir(), { projectTrusted: false }),
  );
  const sessions = await openApplication(
    settings.bind({
      directory,
      models,
      cwd,
      local,
      drvRun: drvRun ? ownerOptions() : undefined,
      onReport: (error) => console.error("pi-serve session", error),
    }),
  );
  const server = httpServer(sessions, host, undefined, publicOrigin, settings);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    await sessions.close();
    throw error;
  }
  console.error(
    `WARN pi-serve: http://${host.includes(":") ? `[${host}]` : host}:${port} is unauthenticated. Anyone who can reach it can control its agents and execution targets.`,
  );
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    server.close();
    server.closeAllConnections();
    const timeout = setTimeout(() => process.exit(1), 15_000);
    void sessions.close().then(
      () => {
        clearTimeout(timeout);
      },
      (error) => {
        console.error(error);
        process.exitCode = 1;
        clearTimeout(timeout);
      },
    );
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  process.once("SIGHUP", shutdown);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
