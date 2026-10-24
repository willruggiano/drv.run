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
