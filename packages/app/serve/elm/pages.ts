import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "@earendil-works/chord/context";
import { authorizationProviders, type ProxyAuthorization } from "../auth.ts";
import type { GlobalSettingsStore } from "../server.ts";
import type { Notifications } from "../notifications.ts";
import type { Sessions } from "../sessions.ts";
import { form, FormError, createSession, saveGlobalSettings } from "../forms.ts";
import { conversationURL, compactTokens } from "../presentation.ts";
import { settingFields, thinkingLevels } from "../settings.ts";
import { elmDocument } from "./frontend.ts";

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
  const landing = path === "/";
  const archive = /^\/sessions\/([^/]+)\/archive$/.exec(path);
  if (archive) {
    if (request.method !== "POST") throw new FormError(405, "Method not allowed.");
    await form(request);
    await sessions.archive(archive[1]);
    json(response, { saved: true });
    return true;
  }
  if (path === "/directories") {
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
  const authAction = /^\/settings\/auth\/(github|openai)\/(login|logout)$/.exec(path);
  if (authAction) {
    if (request.method !== "POST") throw new FormError(405, "Method not allowed.");
    await form(request);
    if (!request.headers.origin) throw new FormError(403, "Origin header required.");
    await authorization.change(
      authAction[2] === "login" ? "login" : "logout",
      signal,
      authAction[1] === "openai" ? "openai" : "github",
    );
    json(response, { saved: true });
    return true;
  }
  if (!landing && path !== "/settings") return false;
  if (request.method === "POST") {
    const data = await form(request, 8 * 1024 * 1024);
    if (landing) {
      const session = await createSession(data, sessions, context);
      json(response, { path: conversationURL(session) });
    } else {
      if (!settings) throw new FormError(503, "Shared settings are not configured.");
      await saveGlobalSettings(data, sessions, settings, context);
      json(response, { saved: true });
    }
    return true;
  }
  if (request.method !== "GET") throw new FormError(405, "Method not allowed.");
  if (!url.searchParams.has("data")) {
    elmDocument(response, true);
    return true;
  }
  const providers =
    path === "/settings"
      ? await Promise.all(
          authorizationProviders.map(async ({ id, label }) => {
            const auth = await authorization.status(signal, id);
            return {
              id,
              label,
              state: auth.state,
              identity:
                auth.state === "usable"
                  ? (auth.accountId ?? (auth.userId === null ? null : String(auth.userId)))
                  : null,
              failed: !!auth.error,
              device: auth.device
                ? {
                    code: auth.device.userCode,
                    uri: auth.device.verificationUri,
                  }
                : null,
            };
          }),
        )
      : [];
  if (!landing && url.searchParams.has("auth")) {
    json(response, providers);
    return true;
  }
  const catalog = await sessions.catalog(context);
  const key = (item: { provider: string; modelId: string }) =>
    JSON.stringify([item.provider, item.modelId]);
  const preferences = settings?.read();
  json(response, {
    kind: landing ? "landing" : "settings",
    providers,
    publicKey: notifications?.publicKey ?? "",
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
      path: `/sessions/${item.id}`,
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

  return true;
}
