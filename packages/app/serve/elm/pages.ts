import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "@earendil-works/chord/context";
import type { Cursor } from "@earendil-works/pi-durable";
import type { ProxyAuthorization } from "../auth.ts";
import type { GlobalSettingsStore } from "../server.ts";
import type { Notifications } from "../notifications.ts";
import {
  type Sessions,
  getConversation,
  repository as repositoryInfo,
  sessionInfo,
} from "../sessions.ts";
import { form, field, FormError, createSession, saveGlobalSettings } from "../forms.ts";
import { conversationURL, compactTokens } from "../presentation.ts";
import { settingFields, thinkingLevels } from "../settings.ts";
import { ElmProjection, metadata, elmDocument } from "./frontend.ts";

function json(response: ServerResponse, value: unknown) {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}
export async function pages(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  sessions: Sessions,
  context: Context,
  authorization: ProxyAuthorization,
  signal: AbortSignal,
  settings?: GlobalSettingsStore,
  notifications?: Notifications,
): Promise<boolean> {
  const path = url.pathname;
  const landing = path === "/elm" || path === "/elm/";
  const archive = /^\/elm\/sessions\/([^/]+)\/archive$/.exec(path);
  if (archive) {
    if (request.method !== "POST") throw new FormError(405, "Method not allowed.");
    await form(request);
    await sessions.archive(archive[1]);
    json(response, { saved: true });
    return true;
  }
  if (path === "/elm/directories") {
    if (request.method !== "GET") throw new FormError(405, "Method not allowed.");
    const target = (await sessions.catalog(context)).targets.find(
      (item) =>
        JSON.stringify([item.provider, item.target]) === url.searchParams.get("target") &&
        item.available,
    );
    if (!target) throw new FormError(409, "Execution target is unavailable.");
    json(
      response,
      await sessions.completeDirectories(target, url.searchParams.get("directory") ?? "", context),
    );
    return true;
  }
  if (path === "/elm/auth/login" || path === "/elm/auth/logout") {
    if (request.method !== "POST") throw new FormError(405, "Method not allowed.");
    await form(request);
    await authorization.change(path.endsWith("/login") ? "login" : "logout", signal);
    json(response, { saved: true });
    return true;
  }
  const extra =
    /^\/elm\/sessions\/([^/]+)\/conversations\/(\d+)\/(history|repository|compact)$/.exec(path);
  if (
    !landing &&
    !["/elm/settings", "/elm/auth", "/elm/activity", "/elm/offline"].includes(path) &&
    !extra
  )
    return false;
  if (path === "/elm/activity" && !notifications) throw new FormError(404, "Not found.");
  if (request.method === "POST") {
    const data = await form(request, 8 * 1024 * 1024);
    if (landing) {
      const session = await createSession(data, sessions, context);
      json(response, { path: conversationURL(session, undefined, "elm") });
    } else if (path === "/elm/settings") {
      if (!settings) throw new FormError(503, "Shared settings are not configured.");
      await saveGlobalSettings(data, sessions, settings, context);
      json(response, { saved: true });
    } else if (extra?.[3] === "compact") {
      const session = await sessions.get(extra[1]);
      const conversation = await getConversation(session, Number(extra[2]), context);
      await conversation.compact(field(data, "argument") || undefined, context);
      json(response, { path: conversationURL(session, conversation.id, "elm") });
    } else throw new FormError(405, "Method not allowed.");
    return true;
  }
  if (request.method !== "GET") throw new FormError(405, "Method not allowed.");
  if (!url.searchParams.has("data")) {
    elmDocument(response, true, path === "/elm/offline");
    return true;
  }
  if (landing || path === "/elm/settings") {
    const catalog = await sessions.catalog(context);
    const key = (item: { provider: string; modelId: string }) =>
      JSON.stringify([item.provider, item.modelId]);
    const preferences = settings?.read();
    json(response, {
      kind: landing ? "landing" : "settings",
      activity: !!notifications,
      models: catalog.models.map((item) => ({
        key: key(item),
        label: `${item.provider} / ${item.name}`,
        levels: item.thinkingLevels,
        default: item.defaultThinkingLevel,
      })),
      targets: catalog.targets.map((item) => ({
        key: JSON.stringify([item.provider, item.target]),
        label: item.label,
        disabled: !item.available,
        root: item.directoryRoot ?? "",
      })),
      model: catalog.defaultModel
        ? key(catalog.defaultModel)
        : catalog.models[0]
          ? key(catalog.models[0])
          : "",
      target: (() => {
        const item = catalog.targets.find((item) => item.available);
        return item ? JSON.stringify([item.provider, item.target]) : "";
      })(),
      sessions: catalog.sessions.slice(0, 5).map((item) => ({
        path: `/elm/sessions/${item.id}`,
        title: item.name || "Untitled session",
        date: new Date(item.created).toISOString().slice(0, 10),
        environment: item.binding
          ? `${item.binding.provider === "local" ? "local" : item.binding.target} · ${item.cwd}`
          : "No execution environment",
        model: item.model?.modelId ?? "No model",
        thinking: item.thinkingLevel,
        usage: `${item.context.window && item.context.lastResponse ? ((item.context.lastResponse.tokens / item.context.window) * 100).toFixed(1) + "%" : "—"}/${item.context.window ? compactTokens(item.context.window) : "?"}${item.context.autoCompact ? " (auto)" : ""}`,
      })),
      configured: !!settings,
      fields: settingFields.map((item) => ({
        key: item.key,
        label: item.label,
        group: item.group,
        readonly: "readonly" in item,
        value: String(preferences?.values[item.key] ?? ""),
        choices: "choices" in item ? item.choices : ["true", "false"],
      })),
      overrides: preferences?.modelThinkingLevels ?? {},
      levels: thinkingLevels,
      defaultModel: preferences?.model ? key(preferences.model) : "",
    });
  } else if (path === "/elm/auth") {
    const auth = await authorization.status(signal);
    json(response, {
      kind: "auth",
      state: auth.state,
      userId: auth.userId,
      expires: auth.expiresAt === null ? null : new Date(auth.expiresAt * 1000).toISOString(),
      failed: !!auth.error,
      device: auth.device
        ? {
            code: auth.device.userCode,
            uri: auth.device.verificationUri,
            expires: new Date(auth.device.expiresAt * 1000).toISOString(),
          }
        : null,
    });
  } else if (extra) {
    const session = await sessions.get(extra[1]);
    const conversation = await getConversation(session, Number(extra[2]), context);
    const back = conversationURL(session, conversation.id, "elm");
    if (extra[3] === "repository") {
      const [info, repo] = await Promise.all([
        sessionInfo(session, conversation, undefined, context),
        repositoryInfo(session, conversation, context),
      ]);
      json(response, {
        kind: "repository",
        back,
        environment: info.binding
          ? `${info.binding.provider === "local" ? "local" : info.binding.target} · ${info.cwd}`
          : "No execution environment",
        title:
          repo.state === "repository"
            ? (repo.branch ?? repo.revision ?? "unborn")
            : repo.state === "none"
              ? "no repository"
              : "repository unavailable",
      });
    } else if (extra[3] === "history") {
      let cursor: Cursor | undefined;
      try {
        cursor = url.searchParams.has("cursor")
          ? (JSON.parse(url.searchParams.get("cursor")!) as Cursor)
          : undefined;
      } catch {
        throw new FormError(400, "Invalid history cursor.");
      }
      const entries = await conversation.entries({ order: "descending" }, 100, cursor, context);
      const projector = new ElmProjection(entries.items.toReversed());
      const watch = await conversation.watch(context);
      try {
        json(response, {
          kind: "history",
          back,
          frame: {
            ...projector.project(
              { ...watch.value, entries: entries.items.toReversed() },
              await metadata(session, conversation, watch.value, context, settings),
            ),
            subscription: "history",
          },
          next: entries.next
            ? `${path}?cursor=${encodeURIComponent(JSON.stringify(entries.next))}`
            : "",
        });
      } finally {
        await watch.stop();
      }
    } else
      json(response, { kind: "compact", back, argument: url.searchParams.get("argument") ?? "" });
  } else json(response, { kind: path.split("/").at(-1) });
  return true;
}
