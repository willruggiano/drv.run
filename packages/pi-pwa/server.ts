import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getAgentDir, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  createRegistry,
  defineDoc,
  defineExtension,
  Harness,
  section,
  type Conversation,
  type ConversationView,
  type EntryRecord,
  type ModelRef,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { RemoteExecutionEnv, sshConnection } from "@earendil-works/pi-env";
import lockfile from "proper-lockfile";

const context = BACKGROUND_CONTEXT;
const exec = promisify(execFile);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const instanceId = /^[a-zA-Z0-9]+$/;

export class RequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type Instance = { id: string; reference: string; running: boolean };
export type SessionInfo = {
  id: string;
  instance: string;
  created: number;
  model: ModelRef;
  needsResume: boolean;
};
export type Snapshot = {
  session: SessionInfo;
  view: ConversationView;
  history?: readonly EntryRecord[];
};
export type Catalog = {
  instances: Instance[];
  sessions: SessionInfo[];
  models: { provider: string; modelId: string; name: string }[];
  defaultModel?: ModelRef;
};
type Remote = { env: ExecutionEnv; close(): void };
type Options = {
  directory: string;
  models: Models;
  instances(): Promise<Instance[]>;
  connect(instance: string): Remote;
  defaultModel?: ModelRef;
  thinkingLevel?: ModelThinkingLevel;
};

const Metadata = defineDoc<{ instance: string; created: number }>({
  kind: "drv.run.instance",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ instance: "", created: 0 }),
});

export async function listInstances(
  stateDirectory: string,
  runtimeDirectory: string,
): Promise<Instance[]> {
  let names: string[];
  try {
    names = await readdir(join(stateDirectory, "drv.run"));
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  return (
    await Promise.all(
      names
        .filter((name) => instanceId.test(name))
        .map(async (id) => {
          let reference: string;
          try {
            reference = (
              await readFile(join(stateDirectory, "drv.run", id, "reference"), "utf8")
            ).trim();
          } catch (error) {
            // Match the SSH inventory: incomplete instances have no reference.
            if (isMissing(error)) return undefined;
            throw error;
          }
          const { stdout } = await exec(
            "systemctl",
            ["--user", "show", `drv.run@${id}.service`, "--property=ActiveState", "--value"],
            { timeout: 10_000 },
          );
          let ready = false;
          try {
            ready = (await stat(join(runtimeDirectory, `drv.run.${id}`, "client.conf"))).isFile();
          } catch (error) {
            if (!isMissing(error)) throw error;
          }
          return { id, reference, running: stdout.trim() === "active" && ready };
        }),
    )
  )
    .filter((item): item is Instance => item !== undefined)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function remoteInstance(id: string, runtimeDirectory: string): Remote {
  assert(instanceId.test(id));
  const host = `drv.run.${id}`;
  const runtime = join(runtimeDirectory, host);
  // Use drv.run's owner-scoped route and pinned host key. Never scan/accept a key
  // from the network, inherit the user's SSH overrides, or fall back to local tools.
  const { connection } = sshConnection({
    host,
    user: "root",
    configFile: "/etc/ssh/ssh_config",
    identityFile: join(runtime, "client-key"),
    knownHostsFile: join(runtime, "known_hosts"),
    hostKeyAlias: host,
  });
  return {
    env: new RemoteExecutionEnv({ connection, id: host, cwd: "/workspace" }),
    close: () => connection.close(),
  };
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export class Sessions {
  readonly options: Options;
  readonly opened = new Map<string, Promise<ManagedSession>>();
  private release: (() => Promise<void>) | undefined;
  private closing = false;

  private constructor(options: Options) {
    this.options = options;
  }

  static async open(options: Options): Promise<Sessions> {
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    const sessions = new Sessions(options);
    sessions.release = await lockfile.lock(options.directory, { retries: 0 });
    return sessions;
  }

  async requireInstance(id: string): Promise<void> {
    if (!(await this.options.instances()).some((item) => item.id === id && item.running)) {
      throw new RequestError(409, "Instance is not running or no longer exists.");
    }
  }

  async catalog(): Promise<Catalog> {
    const names = await readdir(this.options.directory);
    const sessions = await Promise.all(
      names
        .filter((name) => name.endsWith(".sqlite") && uuid.test(name.slice(0, -7)))
        .map(async (name) => (await this.get(name.slice(0, -7))).info()),
    );
    return {
      instances: await this.options.instances(),
      sessions: sessions.sort((a, b) => b.created - a.created),
      models: (await this.options.models.getAvailable()).map((model) => ({
        provider: model.provider,
        modelId: model.id,
        name: model.name,
      })),
      defaultModel: this.options.defaultModel,
    };
  }

  async get(id: string): Promise<ManagedSession> {
    if (!uuid.test(id)) throw new RequestError(404, "Session not found.");
    if (this.closing) throw new RequestError(503, "Server is stopping.");
    const existing = this.opened.get(id);
    if (existing) return existing;
    try {
      await stat(join(this.options.directory, `${id}.sqlite`));
    } catch (error) {
      if (isMissing(error)) throw new RequestError(404, "Session not found.");
      throw error;
    }
    // stat yields; another request may have opened the session in the meantime.
    return this.opened.get(id) ?? this.open(id);
  }

  private open(
    id: string,
    create?: { instance: string; model: ModelRef },
  ): Promise<ManagedSession> {
    if (this.closing) return Promise.reject(new RequestError(503, "Server is stopping."));
    const opened = ManagedSession.open(this, id, create);
    this.opened.set(id, opened);
    void opened.catch(() => {
      this.opened.delete(id);
    });
    return opened;
  }

  async create(id: string, instance: string, model: ModelRef): Promise<ManagedSession> {
    if (!uuid.test(id) || !instanceId.test(instance))
      throw new RequestError(400, "Invalid session or instance ID.");
    if (this.closing) throw new RequestError(503, "Server is stopping.");
    await this.requireInstance(instance);
    const available = await this.options.models.getAvailable();
    if (!available.some((item) => item.provider === model.provider && item.id === model.modelId)) {
      throw new RequestError(
        400,
        "Select an available model. Configure credentials with pi /login on the host.",
      );
    }
    let found: ManagedSession | undefined;
    try {
      found = await this.get(id);
    } catch (error) {
      if (!(error instanceof RequestError && error.status === 404)) throw error;
    }
    const session = found ?? (await (this.opened.get(id) ?? this.open(id, { instance, model })));
    const info = await session.info();
    if (
      info.instance !== instance ||
      info.model.provider !== model.provider ||
      info.model.modelId !== model.modelId
    ) {
      throw new RequestError(409, "Session ID already belongs to a different session.");
    }
    return session;
  }

  async close(): Promise<void> {
    this.closing = true;
    const results = await Promise.allSettled(
      [...this.opened.values()].map(async (session) => (await session).close()),
    );
    await this.release?.();
    this.release = undefined;
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
}

export class ManagedSession {
  needsResume = false;
  private remote: Remote | undefined;

  readonly owner: Sessions;
  readonly id: string;
  readonly harness: Harness;
  readonly root: Conversation;
  readonly instance: string;
  readonly created: number;

  private constructor(
    owner: Sessions,
    id: string,
    harness: Harness,
    root: Conversation,
    instance: string,
    created: number,
  ) {
    this.owner = owner;
    this.id = id;
    this.harness = harness;
    this.root = root;
    this.instance = instance;
    this.created = created;
  }

  static async open(
    owner: Sessions,
    id: string,
    create?: { instance: string; model: ModelRef },
  ): Promise<ManagedSession> {
    const registry = createRegistry();
    registry.install(CodingTools);
    registry.install(
      defineExtension({
        name: "drv.run",
        sections: [
          section(
            "preamble",
            () =>
              "You are Pi, a coding agent. All file and command tools run in a drv.run guest, in /workspace. " +
              "Inspect the project and its AGENTS.md instructions before changing files. Never claim an operation succeeded without checking its result.",
            { tag: false },
          ),
        ],
      }),
    );
    let managed: ManagedSession | undefined;
    const harness = await Harness.open(
      await openNodeSqliteStorage(join(owner.options.directory, `${id}.sqlite`)),
      {
        models: owner.options.models,
        registry,
        env: async () => {
          assert(managed, "Session initialization must finish before tools run.");
          await owner.requireInstance(managed.instance);
          managed.remote ??= owner.options.connect(managed.instance);
          return managed.remote.env;
        },
        onReport: (error) => console.error("pi-pwa session", id, error),
      },
      context,
    );
    try {
      const root = await harness.root(
        context,
        create
          ? {
              agent: {
                model: create.model,
                cwd: "/workspace",
                thinkingLevel: owner.options.thinkingLevel ?? "off",
              },
              init: async (tx, conversationId) => {
                const metadata = await tx.doc(Metadata, conversationId);
                metadata.instance = create.instance;
                metadata.created = Date.now();
              },
            }
          : undefined,
      );
      const metadata = await harness.snapshot(Metadata, root.id, context);
      assert(metadata && instanceId.test(metadata.instance), "Session has no instance binding.");
      managed = new ManagedSession(owner, id, harness, root, metadata.instance, metadata.created);
      const inspection = await harness.inspect(context);
      managed.needsResume = inspection.tasks.length > 0 || inspection.submissions.length > 0;
      return managed;
    } catch (error) {
      await harness.close(context);
      throw error;
    }
  }

  async info(): Promise<SessionInfo> {
    const agent = await this.root.agent(context);
    assert(agent.model, "Session has no model.");
    return {
      id: this.id,
      instance: this.instance,
      created: this.created,
      model: agent.model,
      needsResume: this.needsResume,
    };
  }

  async history(): Promise<EntryRecord[]> {
    const entries: EntryRecord[] = [];
    let cursor;
    do {
      const page = await this.root.entries({ order: "ascending" }, 256, cursor, context);
      entries.push(...page.items);
      cursor = page.next;
    } while (cursor !== undefined);
    return entries;
  }

  async prompt(text: string, requestId: string): Promise<void> {
    if (this.needsResume)
      throw new RequestError(409, "Resume interrupted work before sending a new prompt.");
    await this.owner.requireInstance(this.instance);
    await this.root.submit(
      { type: "input", content: text, requestId, whenBusy: "reject" },
      context,
    );
  }

  async resume(): Promise<void> {
    await this.owner.requireInstance(this.instance);
    this.harness.resume();
    this.needsResume = false;
  }

  async stop(): Promise<void> {
    // abort() starts Durable's scheduler. Do not let a read-only recovery session
    // accidentally execute pending work through that path.
    if (this.needsResume)
      throw new RequestError(409, "Resume interrupted work before stopping it.");
    await this.root.abort(context);
  }

  async close(): Promise<void> {
    try {
      await this.harness.close(context);
    } finally {
      this.remote?.close();
    }
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
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers["content-type"]?.split(";")[0] !== "application/json")
    throw new RequestError(415, "Expected application/json.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 128 * 1024) throw new RequestError(413, "Request too large.");
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

async function stream(session: ManagedSession, response: ServerResponse): Promise<void> {
  const watch = await session.root.watch(context);
  const cleanup = () => {
    void watch.stop();
  };
  response.once("close", cleanup);
  try {
    const history = await session.history();
    if (response.destroyed) {
      await watch.stop();
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream", "X-Accel-Buffering": "no" });
    const send = async (view: ConversationView, initial?: EntryRecord[]) => {
      const snapshot: Snapshot = {
        session: await session.info(),
        view,
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
    watch.start(async (value) => {
      await send(value);
    });
    const heartbeat = setInterval(() => {
      if (response.writableLength > 1024 * 1024) response.destroy();
      else response.write(": heartbeat\n\n");
    }, 15_000);
    response.once("close", () => clearInterval(heartbeat));
  } catch (error) {
    await watch.stop();
    throw error;
  }
}

export function httpServer(
  sessions: Sessions,
  host: string,
  assets = dirname(fileURLToPath(import.meta.url)),
) {
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
      const origin = new URL(`http://${authority}`);
      const hostname = origin.hostname.replace(/^\[|\]$/g, "");
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 80;
      if (
        ![host, ...(host === "127.0.0.1" ? ["localhost"] : [])].includes(hostname) ||
        Number(origin.port || 80) !== port
      )
        throw new RequestError(403, "Unexpected Host.");
      if (
        (request.headers.origin && request.headers.origin !== origin.origin) ||
        request.headers["sec-fetch-site"] === "cross-site"
      )
        throw new RequestError(403, "Cross-origin requests are not allowed.");
      const url = new URL(request.url ?? "/", origin);
      if (request.method === "GET" && url.pathname === "/api/catalog")
        return json(response, 200, await sessions.catalog());
      if (request.method === "POST" && url.pathname === "/api/sessions") {
        const data = await body(request);
        const model = object(data.model);
        const session = await sessions.create(string(data.id, 36), string(data.instance, 64), {
          provider: string(model.provider, 200),
          modelId: string(model.modelId, 300),
        });
        return json(response, 201, await session.info());
      }
      const match = /^\/api\/sessions\/([^/]+)\/(events|prompt|resume|stop)$/.exec(url.pathname);
      if (match) {
        const session = await sessions.get(match[1]);
        if (request.method === "GET" && match[2] === "events")
          return await stream(session, response);
        if (request.method === "POST" && match[2] !== "events") {
          const data = await body(request);
          if (match[2] === "prompt") {
            const requestId = string(data.requestId, 36);
            if (!uuid.test(requestId)) throw new RequestError(400, "Invalid request ID.");
            await session.prompt(string(data.text), requestId);
          } else if (match[2] === "resume") await session.resume();
          else await session.stop();
          return json(response, 200, { accepted: true });
        }
        throw new RequestError(405, "Method not allowed.");
      }
      if (
        request.method === "GET" &&
        ["/", "/client.js", "/manifest.webmanifest", "/icon.svg"].includes(url.pathname)
      ) {
        const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        const types: Record<string, string> = {
          "index.html": "text/html; charset=utf-8",
          "client.js": "text/javascript; charset=utf-8",
          "manifest.webmanifest": "application/manifest+json",
          "icon.svg": "image/svg+xml",
        };
        if (file === "manifest.webmanifest") {
          response.setHeader("Content-Type", types[file]);
          return response.end(
            JSON.stringify({
              name: "Pi · drv.run",
              short_name: "Pi",
              start_url: "/",
              display: "standalone",
              background_color: "#101217",
              theme_color: "#101217",
              icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
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
      if (error instanceof RequestError) json(response, error.status, { error: error.message });
      else {
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

export async function main(args: string[]): Promise<void> {
  if (args.includes("--help")) {
    console.log(`Usage: pi serve [--host IP] [--port PORT] [--state DIRECTORY]
       pi-pwa [--host IP] [--port PORT] [--state DIRECTORY]

Single-owner, unauthenticated HTTP experiment. Bind to a LAN address explicitly.
Default: 127.0.0.1:8080. Anyone who can reach it can control its agents.
Sessions require a running drv.run instance. Tools run in guest /workspace.
Uses the owner's ~/.pi/agent model settings and credentials (PI_CODING_AGENT_DIR supported).
Run pi /login on the host to configure credentials. No extension compatibility.
History survives restart; interrupted work requires the browser's Resume action.
HTTP does not provide secure-context PWA features. No TLS or browser authentication.`);
    return;
  }
  let host = "127.0.0.1",
    port = 8080,
    directory: string | undefined;
  for (let i = 0; i < args.length; i += 2) {
    const value = args[i + 1];
    if (!value) throw new Error(`Missing value for ${args[i]}`);
    if (args[i] === "--host") host = value;
    else if (args[i] === "--port") port = Number(value);
    else if (args[i] === "--state") directory = resolve(value);
    else throw new Error(`Unknown option: ${args[i]}`);
  }
  if (!isIP(host) || ["0.0.0.0", "::"].includes(host))
    throw new Error("--host must be a specific local IP address, not a wildcard.");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port.");
  const uid = process.getuid?.();
  assert(uid !== undefined && uid !== 0, "Run pi-pwa as the drv.run instance owner, not root.");
  process.umask(0o077);
  const state = (await exec("systemd-path", ["user-state-private"])).stdout.trim();
  assert(state.startsWith("/"));
  const models = await ModelRuntime.create();
  const settings = SettingsManager.create(homedir(), getAgentDir(), { projectTrusted: false });
  const provider = settings.getDefaultProvider(),
    modelId = settings.getDefaultModel();
  const sessions = await Sessions.open({
    directory: directory ?? join(state, "pi-pwa"),
    models,
    instances: () => listInstances(state, `/run/user/${uid}`),
    connect: (id) => remoteInstance(id, `/run/user/${uid}`),
    defaultModel: provider && modelId ? { provider, modelId } : undefined,
    thinkingLevel: settings.getDefaultThinkingLevel(),
  });
  const server = httpServer(sessions, host);
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
    `pi-pwa: http://${host.includes(":") ? `[${host}]` : host}:${port} — unauthenticated; LAN only`,
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
