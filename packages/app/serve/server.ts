import { FormError } from "./forms.ts";
import { Notifications } from "./notifications.ts";
import { pages } from "./elm/pages.ts";
import { elmFrontend } from "./elm/frontend.ts";
import { html as h, renderHTML } from "./html.ts";
import { ProxyAuthorization } from "./auth.ts";
import { authPage } from "./htmx/auth.ts";
import { hypermedia, errorPage, activityPage } from "./htmx/frontend.ts";
import { openApplication } from "./application.ts";
import { ownerOptions } from "./instances.ts";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getAgentDir, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { ConversationBusy, StorageRequestError } from "@earendil-works/pi-durable";
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
      if (
        request.method === "GET" &&
        [
          "/elm/client.js",
          "/elm/main.js",
          "/elm/site.js",
          "/elm/sw.js",
          "/htmx/client.js",
          "/htmx/vendor.js",
          "/htmx/sse.js",
          "/htmx/morph.js",
          "/highlight.js",
          "/htmx/activity.js",
          "/styles.css",
          "/design-system.html",
          "/icon.svg",
          "/icon-192.png",
          "/icon-512.png",
          "/htmx/sw.js",
        ].includes(url.pathname)
      ) {
        const file = url.pathname.slice(1);
        const types: Record<string, string> = {
          "elm/client.js": "text/javascript; charset=utf-8",
          "elm/main.js": "text/javascript; charset=utf-8",
          "elm/site.js": "text/javascript; charset=utf-8",
          "elm/sw.js": "text/javascript; charset=utf-8",
          "htmx/client.js": "text/javascript; charset=utf-8",
          "htmx/vendor.js": "text/javascript; charset=utf-8",
          "htmx/sse.js": "text/javascript; charset=utf-8",
          "htmx/morph.js": "text/javascript; charset=utf-8",
          "highlight.js": "text/javascript; charset=utf-8",
          "htmx/activity.js": "text/javascript; charset=utf-8",
          "styles.css": "text/css; charset=utf-8",
          "design-system.html": "text/html; charset=utf-8",
          "icon.svg": "image/svg+xml",
          "icon-192.png": "image/png",
          "icon-512.png": "image/png",
          "htmx/sw.js": "text/javascript; charset=utf-8",
        };
        if (file === "icon.svg") {
          response.setHeader("Content-Type", types[file]);
          return response.end(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="128" height="128" rx="28" fill="#101217"/><text x="64" y="90" text-anchor="middle" font-size="92" fill="#9dd5ae">π</text></svg>',
          );
        }
        if (file.endsWith("/sw.js"))
          response.setHeader("Service-Worker-Allowed", "/" + file.split("/")[0]);
        const data = await readFile(join(assets, file));
        response.setHeader("Content-Type", types[file]);
        return response.end(data);
      }
      const frontend = /^\/(elm|htmx)(?:\/|$)/.exec(url.pathname)?.[1];
      if (
        frontend &&
        url.pathname === `/${frontend}/manifest.webmanifest` &&
        request.method === "GET"
      ) {
        response.writeHead(200, { "Content-Type": "application/manifest+json" });
        response.end(
          JSON.stringify({
            id: `/${frontend}`,
            scope: `/${frontend}`,
            name: "Pi",
            short_name: "Pi",
            start_url: frontend === "elm" ? "/elm" : "/htmx/",
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
      if (frontend && url.pathname.startsWith(`/${frontend}/activity/`) && notifications) {
        const api = new URL(url);
        api.pathname = url.pathname.slice(frontend.length + 1);
        return await notifications.route(request, response, api);
      }
      if (url.pathname === "/htmx/activity" && notifications && request.method === "GET") {
        return activityPage(response);
      }
      if (url.pathname === "/htmx/auth" || url.pathname.startsWith("/htmx/auth/"))
        return await authPage(request, response, url, authorization, controller.signal);
      if (url.pathname === "/elm" || url.pathname.startsWith("/elm/")) {
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
      }
      if (url.pathname === "/htmx" || url.pathname.startsWith("/htmx/"))
        return await hypermedia(
          request,
          response,
          url,
          sessions,
          context,
          settings,
          notifications !== undefined,
        );
      if (url.pathname === "/") {
        if (request.method !== "GET") throw new RequestError(405, "Method not allowed.");
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(
          renderHTML(
            h`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>drv.run</title><link rel="stylesheet" href="/styles.css"></head><body><main class="frontend-chooser"><a href="/elm">elm &gt;</a><a href="/htmx/">htmx &gt;</a></main></body></html>`,
          ),
        );
        return;
      }
      throw new RequestError(404, "Not found.");
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
      if (
        request.url?.startsWith("/elm") &&
        (request.method !== "GET" ||
          new URL(request.url, "http://localhost").searchParams.has("data") ||
          /\/(events|command|panel|receipt|completions|directories)(?:[?]|$)/.test(request.url))
      ) {
        response.writeHead(status, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            error:
              status === 500
                ? "Internal server error."
                : error instanceof Error
                  ? error.message
                  : "Request failed.",
          }),
        );
        return;
      }
      if (!request.url?.startsWith("/htmx")) {
        response.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
        response.end(
          renderHTML(
            h`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Request failed</title><link rel="stylesheet" href="/styles.css"></head><body><main><h1>Request failed</h1><p>${status === 500 ? "Internal server error." : error instanceof Error ? error.message : "Request failed."}</p><a href="${request.url?.startsWith("/elm") ? "/elm" : "/"}">Back</a></main></body></html>`,
          ),
        );
        return;
      }
      return errorPage(
        request,
        response,
        status,
        error instanceof Error ? error.message : "Internal server error.",
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
  const models = await ModelRuntime.create();
  const settings = new GlobalSettingsStore(
    SettingsManager.create(homedir(), getAgentDir(), { projectTrusted: false }),
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
    server = httpServer(sessions, host, undefined, settings, origin, undefined, notifications);
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
