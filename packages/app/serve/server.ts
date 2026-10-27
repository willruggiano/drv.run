import { FormError } from "./forms.ts";
import { Notifications } from "./notifications.ts";
import { pages } from "./elm/pages.ts";
import { elmFrontend } from "./elm/frontend.ts";
import { hostModels, ProxyAuthorization } from "./auth.ts";
import { openApplication } from "./application.ts";
import { ownerOptions } from "./instances.ts";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { isIP } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  DEFAULT_COMPACTION_POLICY,
  DEFAULT_RETRY_POLICY,
  ConversationBusy,
  StorageRequestError,
} from "@earendil-works/pi-durable";
import {
  DEFAULT_THINKING_LEVEL,
  stateDirectory,
  Sessions,
  SessionError,
  type SessionOptions,
} from "./sessions.ts";
import { settingFields, thinkingLevels, type GlobalSettings } from "./settings.ts";

function parseSettings(value: unknown): GlobalSettings {
  const data = object(value);
  const values = object(data.values);
  for (const field of settingFields) {
    const value = values[field.key];
    const valid =
      "choices" in field
        ? field.choices.some((choice) => choice === value)
        : field.type === "boolean"
          ? typeof value === "boolean"
          : typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
    if (!valid) throw new RequestError(400, `Invalid setting: ${field.key}`);
  }
  const model = data.model === null ? null : object(data.model);
  const modelThinkingLevels = object(data.modelThinkingLevels);
  for (const level of Object.values(modelThinkingLevels))
    if (!isThinkingLevel(level)) throw new RequestError(400, "Invalid model thinking level.");
  return {
    values: values as GlobalSettings["values"],
    model: model
      ? { provider: string(model.provider, 200), modelId: string(model.modelId, 300) }
      : null,
    modelThinkingLevels: modelThinkingLevels as GlobalSettings["modelThinkingLevels"],
  };
}

export class GlobalSettingsStore {
  private value: GlobalSettings;
  private path?: string;
  private writes: Promise<void> = Promise.resolve();
  private readonly observers = new Set<() => void>();

  constructor(initial: Partial<GlobalSettings> = {}) {
    this.value = parseSettings({
      values: {
        defaultThinkingLevel: DEFAULT_THINKING_LEVEL,
        transport: "auto",
        steeringMode: "one-at-a-time",
        followUpMode: "one-at-a-time",
        "compaction.enabled": DEFAULT_COMPACTION_POLICY.enabled,
        "compaction.reserveTokens": DEFAULT_COMPACTION_POLICY.reserveTokens,
        "compaction.keepRecentTokens": DEFAULT_COMPACTION_POLICY.keepRecentTokens,
        "retry.enabled": DEFAULT_RETRY_POLICY.enabled,
        "retry.maxRetries": DEFAULT_RETRY_POLICY.maxRetries,
        "retry.baseDelayMs": DEFAULT_RETRY_POLICY.baseDelayMs,
        "retry.maxAgentDelayMs": DEFAULT_RETRY_POLICY.maxAgentDelayMs ?? 60000,
        hideThinkingBlock: false,
        "terminal.showImages": true,
      },
      model: null,
      modelThinkingLevels: {},
      ...structuredClone(initial),
    });
  }

  static async open(path: string): Promise<GlobalSettingsStore> {
    const store = new GlobalSettingsStore();
    try {
      store.value = parseSettings(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    store.path = path;
    return store;
  }

  watch(observer: () => void): () => void {
    this.observers.add(observer);
    return () => {
      this.observers.delete(observer);
    };
  }

  read(): GlobalSettings {
    return structuredClone(this.value);
  }

  // Durable resolves host policy on every run; conversation settings remain persisted separately.
  bind<T extends SessionOptions>(options: T): T & Pick<SessionOptions, "settings" | "defaults"> {
    const current = () => this.value;
    return {
      ...options,
      defaults: {
        get model() {
          return current().model ?? undefined;
        },
        get thinkingLevel() {
          return current().values.defaultThinkingLevel;
        },
        get modelThinkingLevels() {
          return { ...current().modelThinkingLevels };
        },
      },
      settings: {
        get stream() {
          return { transport: current().values.transport };
        },
        get retry() {
          const v = current().values;
          return {
            enabled: v["retry.enabled"],
            maxRetries: v["retry.maxRetries"],
            baseDelayMs: v["retry.baseDelayMs"],
            maxAgentDelayMs: v["retry.maxAgentDelayMs"],
          };
        },
        get compaction() {
          const v = current().values;
          return {
            enabled: v["compaction.enabled"],
            reserveTokens: v["compaction.reserveTokens"],
            keepRecentTokens: v["compaction.keepRecentTokens"],
          };
        },
        get steeringMode() {
          return current().values.steeringMode;
        },
        get followUpMode() {
          return current().values.followUpMode;
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
    for (const key of Object.keys(values)) {
      const field = settingFields.find((field) => field.key === key);
      if (!field || ("readonly" in field && field.readonly))
        throw new RequestError(400, `Unsupported setting: ${key}`);
    }
    let model = this.value.model;
    if (data.model !== undefined) {
      const ref = object(data.model);
      model = { provider: string(ref.provider, 200), modelId: string(ref.modelId, 300) };
      const available = await sessions.options.models.getAvailable();
      if (!available.some((item) => item.provider === model?.provider && item.id === model.modelId))
        throw new RequestError(400, "Model is unavailable.");
    }
    const level = data.modelThinkingLevel;
    if (
      level !== undefined &&
      (data.model === undefined || (level !== null && !isThinkingLevel(level)))
    )
      throw new RequestError(400, "Invalid per-model thinking preference.");
    const modelThinkingLevels = { ...this.value.modelThinkingLevels };
    if (model && level !== undefined) {
      const key = `${model.provider}/${model.modelId}`;
      if (level === null) delete modelThinkingLevels[key];
      else if (isThinkingLevel(level)) modelThinkingLevels[key] = level;
    }
    const next = parseSettings({
      values: { ...this.value.values, ...values },
      model,
      modelThinkingLevels,
    });
    // One server owns this file. Publish state and notify observers only after atomic replacement.
    if (this.path) {
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = await mkdtemp(join(dirname(this.path), ".settings-"));
      try {
        const file = join(temporary, "settings.json");
        await writeFile(file, JSON.stringify(next), { mode: 0o600 });
        await rename(file, this.path);
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    }
    this.value = next;
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
export function httpServer(
  sessions: Sessions,
  host: string,
  assets = dirname(fileURLToPath(import.meta.url)),
  settings?: GlobalSettingsStore,
  externalOrigin?: string,
  authorization = new ProxyAuthorization(),
  notifications?: Notifications,
) {
  const configuredOrigin = externalOrigin === undefined ? undefined : new URL(externalOrigin);
  if (configuredOrigin) {
    if (configuredOrigin.protocol !== "https:" || configuredOrigin.origin !== externalOrigin)
      throw new Error(
        "ORIGIN must be a canonical HTTPS origin without credentials, path or query.",
      );
    if (host !== "127.0.0.1" && host !== "::1")
      throw new Error("ORIGIN requires HOST to be 127.0.0.1 or ::1.");
  }
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
      // The proxy preserves Host. Trust only the configured origin, never forwarded headers.
      const origin = configuredOrigin ?? new URL(`http://${authority}`);
      if (configuredOrigin) {
        if (authority !== configuredOrigin.host) throw new RequestError(403, "Unexpected Host.");
      } else {
        const hostname = origin.hostname.replace(/^\[|\]$/g, "");
        const address = server.address();
        const port = address && typeof address === "object" ? address.port : 80;
        const destination = host === "0.0.0.0" ? request.socket.localAddress : host;
        if (
          ![destination, ...(destination === "127.0.0.1" ? ["localhost"] : [])].includes(
            hostname,
          ) ||
          Number(origin.port || 80) !== port
        )
          throw new RequestError(403, "Unexpected Host.");
      }
      if (
        (request.headers.origin && request.headers.origin !== origin.origin) ||
        request.headers["sec-fetch-site"] === "cross-site"
      )
        throw new RequestError(403, "Cross-origin requests are not allowed.");
      const url = new URL(request.url ?? "/", origin);
      const controller = new AbortController();
      response.once("close", () => controller.abort());
      const context = withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
      const types: Record<string, string> = {
        "client.js": "text/javascript; charset=utf-8",
        "main.js": "text/javascript; charset=utf-8",
        "site.js": "text/javascript; charset=utf-8",
        "sw.js": "text/javascript; charset=utf-8",
        "highlight.js": "text/javascript; charset=utf-8",
        "styles.css": "text/css; charset=utf-8",
        "design-system.html": "text/html; charset=utf-8",
        "icon.svg": "image/svg+xml",
        "icon-192.png": "image/png",
        "icon-512.png": "image/png",
      };
      const file = url.pathname.slice(1);
      if (request.method === "GET" && Object.hasOwn(types, file)) {
        response.setHeader("Content-Type", types[file]);
        if (file === "icon.svg")
          return response.end(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="128" height="128" rx="28" fill="#101217"/><text x="64" y="90" text-anchor="middle" font-size="92" fill="#9dd5ae">π</text></svg>',
          );
        return response.end(await readFile(join(assets, file)));
      }
      if (url.pathname === "/manifest.webmanifest" && request.method === "GET") {
        response.writeHead(200, { "Content-Type": "application/manifest+json" });
        response.end(
          JSON.stringify({
            id: "/",
            scope: "/",
            name: "Pi",
            short_name: "Pi",
            start_url: "/",
            display: "standalone",
            background_color: "#151719",
            theme_color: "#151719",
            icons: [192, 512].map((size) => ({
              src: `/icon-${size}.png`,
              sizes: `${size}x${size}`,
              type: "image/png",
            })),
          }),
        );
        return;
      }
      if (url.pathname.startsWith("/settings/push/") && notifications)
        return await notifications.route(request, response, url);
      if (
        await pages(
          request,
          response,
          url,
          sessions,
          context,
          authorization,
          controller.signal,
          settings,
          notifications,
        )
      )
        return;
      return await elmFrontend(request, response, url, sessions, context, settings);
    })().catch((error: unknown) => {
      if (response.destroyed) return;
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const status =
        error instanceof FormError || error instanceof RequestError
          ? error.status
          : error instanceof ConversationBusy
            ? 409
            : error instanceof TypeError || error instanceof StorageRequestError
              ? 400
              : error instanceof SessionError
                ? { invalid: 400, not_found: 404, unavailable: 409, conflict: 409, closing: 503 }[
                    error.code
                  ]
                : 500;
      if (status === 500) console.error(error);
      const message =
        status === 500
          ? "Internal server error."
          : error instanceof Error
            ? error.message
            : "Request failed.";
      if (
        request.method !== "GET" ||
        new URL(request.url ?? "/", "http://localhost").searchParams.has("data") ||
        /\/(events|command|panel|receipt|completions|directories)(?:[?]|$)/.test(request.url ?? "")
      ) {
        response.writeHead(status, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: message }));
        return;
      }
      response.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
      const escaped = message.replace(
        /[&<>"']/g,
        (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
      );
      response.end(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Request failed</title><link rel="stylesheet" href="/styles.css"></head><body><main><h1>Request failed</h1><p>${escaped}</p><a href="/">Back</a></main></body></html>`,
      );
    });
  });
  server.requestTimeout = 30_000;
  return server;
}

export async function main(): Promise<void> {
  const host = process.env.HOST ?? "127.0.0.1";
  const port = Number(process.env.PORT ?? "8080");
  if (!isIP(host) || host === "::")
    throw new Error("HOST must be an IP address; IPv6 wildcard binding is not supported.");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT.");
  process.umask(0o077);
  const authorization = new ProxyAuthorization();
  const models = hostModels(authorization);
  const settings = await GlobalSettingsStore.open(
    join(stateDirectory(), "drv-run", "settings.json"),
  );
  const drvRun = ownerOptions();
  const notifications = process.env.NOTIFICATIONS_CONFIG
    ? await Notifications.open(
        join(stateDirectory(), "drv-run-notifications"),
        process.env.NOTIFICATIONS_CONFIG,
      )
    : undefined;
  const sessions = await openApplication(
    settings.bind({
      directory: join(stateDirectory(), "pi-durable"),
      models,
      drvRun,
      onReport: (error) => console.error("serve session", error),
      onSession: (session) => notifications?.attach(session),
    }),
  ).catch(async (error: unknown) => {
    await notifications?.close();
    throw error;
  });
  const origin = process.env.ORIGIN;
  let server: ReturnType<typeof httpServer>;
  try {
    if (notifications) await sessions.catalog();
    server = httpServer(sessions, host, undefined, settings, origin, authorization, notifications);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    try {
      await sessions.close();
    } finally {
      await notifications?.close();
    }
    throw error;
  }
  console.error(
    `WARN serve: ${origin ?? `http://${host.includes(":") ? `[${host}]` : host}:${port}`} is unauthenticated. Anyone who can reach it can control its agents, execution targets, and proxied credentials.`,
  );
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    server.close();
    server.closeAllConnections();
    const timeout = setTimeout(() => process.exit(1), 15_000);
    void sessions
      .close()
      .finally(() => notifications?.close())
      .then(
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
  await main();
}
