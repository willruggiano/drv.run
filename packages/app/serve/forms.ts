import assert from "node:assert/strict";
import type { Context } from "@earendil-works/chord/context";
import type { Conversation } from "@earendil-works/pi-durable";
import type { Sessions, Session } from "./sessions.ts";
import type { GlobalSettingsStore } from "./server.ts";
import {
  settingFields,
  modelKey,
  saveSessionSettings as saveSettings,
  resolveSelection,
  type Selection,
} from "./settings.ts";
import type { IncomingMessage } from "node:http";
import type { UserInput } from "@earendil-works/pi-durable";

export class FormError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function form(request: IncomingMessage, maximum = 128 * 1024): Promise<FormData> {
  // Unlike JSON, ordinary forms are cross-site writable without a preflight.
  if (!request.headers.origin) throw new FormError(403, "Origin header required for forms.");
  const type = request.headers["content-type"] ?? "";
  if (
    !["application/x-www-form-urlencoded", "multipart/form-data"].includes(
      type.split(";")[0].trim(),
    )
  )
    throw new FormError(415, "Expected a form.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > maximum) throw new FormError(413, "Request too large.");
    chunks.push(buffer);
  }
  try {
    return await new Response(Buffer.concat(chunks), {
      headers: { "Content-Type": type },
    }).formData();
  } catch {
    throw new FormError(400, "Invalid form.");
  }
}
export function field(data: FormData, key: string, max = 100_000): string {
  const values = data.getAll(key);
  const value = values[0];
  if (values.length !== 1 || typeof value !== "string" || value.length > max)
    throw new FormError(400, `Invalid ${key}.`);
  // Native form encoders canonicalize textarea newlines to CRLF.
  return value.replace(/\r\n?/g, "\n");
}

export async function inputContent(data: FormData): Promise<UserInput | undefined> {
  const text = data.has("content") ? field(data, "content") : "";
  const images: Exclude<UserInput, string> = [];
  let size = 0;
  for (const file of data.getAll("images")) {
    if (typeof file === "string") throw new FormError(400, "Invalid image.");
    if (!file.size) continue;
    if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type))
      throw new FormError(400, "Unsupported image type.");
    size += file.size;
    images.push({
      type: "image",
      mimeType: file.type,
      data: Buffer.from(await file.arrayBuffer()).toString("base64"),
    });
  }
  if (images.length > 4 || size > 5 * 1024 * 1024)
    throw new FormError(400, "Attach up to four images, totaling at most 5 MiB.");
  return images.length ? [{ type: "text", text }, ...images] : text.trim() ? text : undefined;
}

export async function saveSessionSettings(
  data: FormData,
  sessions: Sessions,
  session: Session,
  conversation: Conversation,
  context: Context,
): Promise<void> {
  await saveSettings(
    sessions,
    session,
    conversation,
    {
      ...selection(data),
      name: field(data, "name", 120),
    },
    context,
  );
}

const optional = (data: FormData, key: string) => (data.has(key) ? field(data, key) : "");
function selection(data: FormData): Selection {
  return {
    model: field(data, "model", 1024),
    target: field(data, "target", 8192),
    thinkingLevel: optional(data, "thinkingLevel"),
    baseDirectory: optional(data, "baseDirectory"),
  };
}
export async function createSession(
  data: FormData,
  sessions: Sessions,
  context: Context,
): Promise<Session> {
  const choices = await sessions.choices(context);
  const selected = selection(data);
  const { target, model, thinkingLevel } = resolveSelection(sessions, choices, selected);
  assert(target && model, "Creation requires available selections.");
  let content = await inputContent(data);
  if (data.has("command")) {
    if (
      field(data, "command", 20) !== "new" ||
      typeof content !== "string" ||
      content.trim() !== "/new"
    )
      throw new FormError(400, "Invalid creation command.");
    content = undefined;
  }
  const requestId = content === undefined ? undefined : field(data, "requestId", 200);
  if (requestId !== undefined && !requestId.trim()) throw new FormError(400, "Missing request ID.");
  const baseDirectory = selected.baseDirectory;
  const session = await sessions.create(
    field(data, "id", 36),
    target,
    { provider: model.provider, modelId: model.modelId },
    thinkingLevel,
    target.directoryRoot ? baseDirectory : baseDirectory || undefined,
  );
  if (content !== undefined)
    await session.root.submit({ type: "input", content, requestId }, context);
  return session;
}
export async function saveGlobalSettings(
  data: FormData,
  sessions: Sessions,
  settings: GlobalSettingsStore,
  context: Context,
): Promise<void> {
  const values: Record<string, unknown> = {};
  for (const item of settingFields) {
    if ("readonly" in item) continue;
    const value = field(data, item.key, 100);
    if ("type" in item && item.type === "boolean" && value !== "true" && value !== "false")
      throw new FormError(400, "Invalid boolean setting.");
    values[item.key] = "choices" in item ? value : value === "true";
  }
  const model = (await sessions.choices(context)).models.find(
    (model) => modelKey(model) === optional(data, "model"),
  );
  if (optional(data, "model") && !model) throw new FormError(400, "Model is unavailable.");
  await settings.update(
    {
      values,
      ...(model ? { model, modelThinkingLevel: optional(data, "modelThinkingLevel") || null } : {}),
    },
    sessions,
  );
}
