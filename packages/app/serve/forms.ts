import type { Context } from "@earendil-works/chord/context";
import type { Conversation } from "@earendil-works/pi-durable";
import { sessionInfo, rename, selectEnvironment, type Sessions, type Session } from "./sessions.ts";
import { thinkingLevels } from "./settings.ts";
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
  const modelKey = (model: { provider: string; modelId: string }) =>
    JSON.stringify([model.provider, model.modelId]);
  const targetKey = (target: { provider: string; target: string }) =>
    JSON.stringify([target.provider, target.target]);
  const thinking = (value: string) => thinkingLevels.find((level) => level === value);
  const optional = (data: FormData, key: string) => (data.has(key) ? field(data, key) : "");
  const catalog = await sessions.catalog(context);
  const current = await sessionInfo(session, conversation, catalog.targets, context);
  const name = field(data, "name", 120);
  const targetValue = field(data, "target", 8192),
    modelValue = field(data, "model", 1024);
  const target = catalog.targets.find((item) => targetKey(item) === targetValue && item.available);
  const model = catalog.models.find((item) => modelKey(item) === modelValue);
  const level = optional(data, "thinkingLevel");
  if (level && !thinking(level)) throw new FormError(400, "Invalid thinking level.");
  if (!model && (!current.model || modelKey(current.model) !== modelValue))
    throw new FormError(409, "Model is unavailable.");
  if (!target && (!current.binding || targetKey(current.binding) !== targetValue))
    throw new FormError(409, "Target is unavailable.");
  const baseDirectory = optional(data, "baseDirectory");
  const currentBase =
    current.directoryRoot && current.cwd.startsWith(current.directoryRoot + "/")
      ? current.cwd.slice(current.directoryRoot.length + 1)
      : "";
  if (!target && baseDirectory !== currentBase) throw new FormError(409, "Target is unavailable.");
  const cwd = target?.directoryRoot
    ? await sessions.baseDirectory(target, baseDirectory)
    : (target?.cwd ?? current.cwd);
  // Validate every field before persisting any part of the form.
  if (Array.from(name).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))
    throw new FormError(400, "Invalid session name.");
  if (
    target &&
    (!current.binding || targetKey(current.binding) !== targetValue || current.cwd !== cwd)
  )
    await selectEnvironment(session, { ...target, cwd }, conversation);
  await conversation.configure(
    {
      ...(model ? { model: { provider: model.provider, modelId: model.modelId } } : {}),
      ...(model
        ? { thinkingLevel: sessions.resolveThinking(model, thinking(level)) }
        : level
          ? { thinkingLevel: thinking(level) }
          : {}),
      cwd,
    },
    context,
  );
  if (name !== current.name) await rename(session, name);
}
