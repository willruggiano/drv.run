import { WorkflowError } from "../pi-runtime/workflows.ts";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getAgentDir, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  ConversationBusy,
  type Conversation,
  type ConversationView,
  type EntryRecord,
  type Cursor,
  type SubmissionId,
} from "@earendil-works/pi-durable";
import {
  DEFAULT_THINKING_LEVEL,
  loadIntegrations,
  localIntegration,
  stateDirectory,
  Sessions,
  SessionError,
  type ManagedSession,
  type Snapshot,
  type SessionOptions,
} from "../pi-runtime/index.ts";
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
  bind(options: SessionOptions): SessionOptions {
    const manager = this.manager;
    return {
      ...options,
      get defaultModel() {
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

const context = BACKGROUND_CONTEXT;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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

async function stream(
  session: ManagedSession,
  response: ServerResponse,
  conversation: Conversation,
  settings?: GlobalSettingsStore,
): Promise<void> {
  const features = await session.watchWorkflows(conversation);
  const watch = await conversation.watch(context).catch(async (error: unknown) => {
    await features.stop();
    throw error;
  });
  let unwatchSettings: (() => void) | undefined;
  const cleanup = () => {
    unwatchSettings?.();
    void watch.stop();
    void features.stop();
  };
  response.once("close", cleanup);
  try {
    const history = await session.history(conversation);
    if (response.destroyed) {
      await watch.stop();
      await features.stop();
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream", "X-Accel-Buffering": "no" });
    const contextDurations: Record<number, number> = {};
    const timed = new Set<number>();
    const send = async (view: ConversationView, initial?: EntryRecord[]) => {
      for (const entry of [...(initial ?? []), ...view.entries]) {
        if (entry.kind !== "pi.compaction" || timed.has(entry.id)) continue;
        // Queued summaries may be appended by a run rather than the compaction
        // task. Resolve that task through its durable write submission.
        const task = entry.byTaskId
          ? await session.harness.getTask(entry.byTaskId, context)
          : undefined;
        let duration: number | undefined;
        if (
          task?.kind === "pi.compaction" &&
          task.startedAt !== undefined &&
          task.endedAt !== undefined
        )
          duration = task.endedAt - task.startedAt;
        else
          duration = await session.harness.commit(async (tx) => {
            let cursor: Cursor | undefined;
            do {
              const page = await tx.scanTasks(
                { conversationId: entry.conversationId, kind: "pi.compaction" },
                100,
                cursor,
              );
              for (const candidate of page.items) {
                const submission = await tx.submissionByRequest(
                  entry.conversationId,
                  `compaction:${candidate.id}`,
                );
                if (
                  submission?.entry === entry.id &&
                  candidate.startedAt !== undefined &&
                  candidate.endedAt !== undefined
                )
                  return candidate.endedAt - candidate.startedAt;
              }
              cursor = page.next;
            } while (cursor);
            return undefined;
          }, context);
        if (duration !== undefined) contextDurations[entry.id] = duration;
        timed.add(entry.id);
      }
      const snapshot: Snapshot = {
        session: await session.info(),
        view,
        context: session.contextStatus(view),
        inspection: await session.inspectContext(view),
        contextDurations,
        workflows: await session.workflows(conversation),
        ...(initial ? { history: initial } : {}),
      };
      if (response.destroyed) return;
      // Disconnect slow clients rather than accumulating an unbounded stream.
      if (response.writableLength > 1024 * 1024) {
        response.destroy();
        return;
      }
      response.write(`data: ${JSON.stringify(snapshot)}\n\n`);
    };
    await send(watch.value, history);
    if (response.destroyed) return;
    let sending = Promise.resolve();
    const update = () => {
      sending = sending
        .then(() => send(watch.value))
        .catch(() => {
          response.destroy();
        });
      return sending;
    };
    watch.start(update);
    features.start(update);
    unwatchSettings = settings?.watch(() => {
      void update();
    });
    const heartbeat = setInterval(() => {
      if (response.writableLength > 1024 * 1024) response.destroy();
      else response.write(": heartbeat\n\n");
    }, 15_000);
    response.once("close", () => clearInterval(heartbeat));
  } catch (error) {
    await watch.stop();
    await features.stop();
    throw error;
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
        return json(response, 200, await sessions.catalog());
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
          ),
        );
      }
      if (request.method === "POST" && url.pathname === "/api/sessions") {
        const data = await body(request);
        const model = object(data.model);
        const binding = object(data.binding);
        if (data.thinkingLevel !== undefined && !isThinkingLevel(data.thinkingLevel))
          throw new RequestError(400, "Invalid thinking level.");
        const session = await sessions.create(
          string(data.id, 36),
          {
            provider: string(binding.provider, 200),
            target: string(binding.target, 4096),
            cwd: string(binding.cwd, 4096),
          },
          {
            provider: string(model.provider, 200),
            modelId: string(model.modelId, 300),
          },
          data.thinkingLevel,
          data.baseDirectory === undefined ? undefined : directoryInput(data.baseDirectory),
        );
        return json(response, 201, await session.info());
      }
      const match =
        /^\/api\/sessions\/([^/]+)\/(events|answer|review|end-review|prompt|resume|stop|configure|compact|reset|cancel|fork|conversations|export|rename|repository|completions)$/.exec(
          url.pathname,
        );
      if (match) {
        const session = await sessions.get(match[1]);
        const conversation = await session.conversation(
          url.searchParams.has("conversation")
            ? Number(url.searchParams.get("conversation"))
            : undefined,
        );
        if (request.method === "GET" && match[2] === "completions")
          return json(
            response,
            200,
            await session.completePaths(url.searchParams.get("query") ?? "", conversation),
          );
        if (request.method === "GET" && match[2] === "repository")
          return json(response, 200, await session.repository(conversation));
        if (request.method === "GET" && match[2] === "conversations")
          return json(response, 200, await session.conversations());
        if (request.method === "GET" && match[2] === "export")
          return json(response, 200, await session.history(conversation));
        if (request.method === "GET" && match[2] === "events")
          return await stream(session, response, conversation, settings);
        if (request.method === "POST" && match[2] !== "events") {
          const data = await body(request, match[2] === "prompt" ? 8 * 1024 * 1024 : 128 * 1024);
          if (match[2] === "answer") {
            if (!Number.isSafeInteger(data.id)) throw new RequestError(400, "Invalid question ID.");
            await session.answer(data.id as number, data.response, conversation);
          } else if (match[2] === "review") {
            const reviewer = await session.startReview(data, conversation);
            return json(response, 201, { id: reviewer.id });
          } else if (match[2] === "end-review") {
            const origin = await session.finishReview(data, conversation);
            return json(response, 200, { id: origin.id });
          } else if (match[2] === "prompt") {
            const requestId = string(data.requestId, 36);
            if (!uuid.test(requestId)) throw new RequestError(400, "Invalid request ID.");
            const mode = data.mode ?? "reject";
            if (mode !== "reject" && mode !== "steer" && mode !== "followUp")
              throw new RequestError(400, "Invalid queue mode.");
            const images = data.images ?? [];
            if (!Array.isArray(images) || images.length > 4)
              throw new RequestError(400, "At most four images are allowed.");
            const validated = images.map((value: unknown) => {
              const image = object(value);
              if (
                typeof image.mimeType !== "string" ||
                !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(image.mimeType) ||
                typeof image.data !== "string" ||
                !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)
              )
                throw new RequestError(400, "Invalid image.");
              return { type: "image" as const, mimeType: image.mimeType, data: image.data };
            });
            if (validated.length) {
              const agent = await conversation.agent(context);
              const available = await sessions.options.models.getAvailable();
              if (
                !available
                  .find(
                    (model) =>
                      model.provider === agent.model?.provider && model.id === agent.model.modelId,
                  )
                  ?.input.includes("image")
              )
                throw new RequestError(400, "This model does not support images.");
            }
            await session.prompt(string(data.text), requestId, mode, conversation, validated);
          } else if (match[2] === "rename") {
            if (typeof data.name !== "string") throw new RequestError(400, "Invalid session name.");
            await session.rename(data.name);
            return json(response, 200, await session.info());
          } else if (match[2] === "resume") await session.resume();
          else if (match[2] === "stop") await session.stop(conversation);
          else {
            if (session.needsResume) throw new RequestError(409, "Resume interrupted work first.");
            await sessions.requireTarget(session.binding);
            if (match[2] === "configure") {
              const model = object(data.model);
              const available = (await sessions.catalog()).models;
              const selected = available.find(
                (item) => item.provider === model.provider && item.modelId === model.modelId,
              );
              if (!selected) throw new RequestError(400, "Model is unavailable.");
              const thinking = data.thinkingLevel;
              if (!isThinkingLevel(thinking))
                throw new RequestError(400, "Invalid thinking level.");
              if (typeof data.instructions !== "string" || data.instructions.length > 100_000)
                throw new RequestError(400, "Invalid instructions.");
              await conversation.configure(
                {
                  model: { provider: selected.provider, modelId: selected.modelId },
                  thinkingLevel: sessions.resolveThinking(selected, thinking),
                  instructions: data.instructions,
                  ...(data.baseDirectory === undefined
                    ? {}
                    : {
                        cwd: sessions.baseDirectory(
                          session.binding,
                          directoryInput(data.baseDirectory),
                        ),
                      }),
                },
                context,
              );
            } else if (match[2] === "compact") {
              await conversation.compact(
                data.instructions === undefined ? undefined : string(data.instructions),
                context,
              );
            } else if (match[2] === "reset") {
              await conversation.reset(
                data.handoff === undefined ? undefined : string(data.handoff),
                context,
              );
            } else if (match[2] === "cancel") {
              if (!Number.isSafeInteger(data.id))
                throw new RequestError(400, "Invalid submission ID.");
              const result = await session.harness.abortSubmission(
                data.id as SubmissionId,
                context,
                conversation.id,
              );
              if (result === "not_found") throw new RequestError(404, "Submission not found.");
              return json(response, 200, { result });
            } else if (match[2] === "fork") {
              const entry = (await session.history(conversation)).find(
                (entry) => entry.id === data.entry,
              );
              if (!entry) throw new RequestError(400, "Entry not found in this conversation.");
              const fork = await conversation.fork(
                entry.id,
                { ownership: { kind: "ownerless" } },
                context,
              );
              return json(response, 201, { id: fork.id });
            } else throw new RequestError(405, "Method not allowed.");
          }
          return json(response, 200, { accepted: true });
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
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error instanceof ConversationBusy)
        json(response, 409, { error: "Conversation is busy. Choose Steer or Follow up." });
      else if (error instanceof RequestError)
        json(response, error.status, { error: error.message });
      else if (error instanceof SessionError || error instanceof WorkflowError) {
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
    local = true;
  let publicOrigin: string | undefined;
  const extensions: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
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
    else if (option === "--extension") extensions.push(resolve(value));
    else throw new Error(`Unknown option: ${option}`);
  }
  if (!isIP(host) || host === "::")
    throw new Error("--host must be an IP address; IPv6 wildcard binding is not supported.");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port.");
  if (!local && extensions.length === 0) throw new Error("--no-local requires an extension.");
  return { host, port, directory, cwd, local, extensions, publicOrigin };
}

export async function main(args: string[]): Promise<void> {
  if (args.includes("--help")) {
    console.log(`Usage: pi-serve [--host IP] [--port PORT] [--state DIRECTORY]
                [--cwd DIRECTORY] [--extension MODULE]... [--no-local] [--origin HTTPS_ORIGIN]

Runs pi-durable with a web frontend. Defaults to local tools in the launch directory.
Extensions are explicitly loaded application integrations, not coding-agent extensions.
Uses ~/.pi/agent model settings and credentials (PI_CODING_AGENT_DIR supported).
Run pi /login to configure credentials.
History survives restart; interrupted work requires explicit Resume.
Default: unauthenticated HTTP on 0.0.0.0:8080. No TLS or browser authentication.
HTTP does not provide secure-context PWA features outside localhost.
For a trusted HTTPS reverse proxy, bind --host 127.0.0.1 and set --origin to its
exact HTTPS origin. The proxy must preserve Host. Forwarded headers are ignored.
This does not add authentication: restrict access at the proxy/network boundary.`);
    return;
  }
  const { host, port, directory, cwd, extensions, local, publicOrigin } = parseOptions(args);
  process.umask(0o077);
  const models = await ModelRuntime.create();
  const settings = new GlobalSettingsStore(
    SettingsManager.create(homedir(), getAgentDir(), { projectTrusted: false }),
  );
  const sessions = await Sessions.open(
    settings.bind({
      directory,
      models,
      integrations: [
        ...(local ? [localIntegration(cwd)] : []),
        ...(await loadIntegrations(extensions)),
      ],
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
