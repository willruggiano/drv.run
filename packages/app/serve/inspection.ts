import type { Message } from "@earendil-works/pi-ai";
import {
  estimateMessageTokens,
  estimateTextTokens,
  estimateTextAndImageContentTokens,
} from "@earendil-works/pi-ai/utils/estimate";
import type { CompactionPolicy, ContextView, ModelRef } from "@earendil-works/pi-durable";

export type ContextPart = {
  name: string;
  value?: string;
  tokens: number;
  children?: ContextPart[];
};
export type ContextMessage = {
  role: Message["role"];
  tokens: number;
  source?: { entry: number; kind: string };
  toolName?: string;
  parts: ContextPart[];
};
export type ContextInspection =
  | { state: "unavailable"; conversation: number }
  | {
      state: "available";
      conversation: number;
      head: number | null;
      tail: number | null;
      model: ModelRef | null;
      window: number | null;
      tokens: number;
      remaining: number | null;
      fraction: number | null;
      policy: CompactionPolicy;
      blockingAt: number | null;
      backgroundAt: number | null;
      roles: { role: Message["role"]; tokens: number }[];
      messages: ContextMessage[];
    };

/** No filesystem access: these are records delivered in a committed section. */
function files(text: string): ContextPart[] | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("files" in parsed) ||
      !Array.isArray(parsed.files)
    )
      return undefined;
    const records: ContextPart[] = [];
    for (const file of parsed.files as unknown[]) {
      if (
        !file ||
        typeof file !== "object" ||
        !("path" in file) ||
        typeof file.path !== "string" ||
        !("content" in file) ||
        typeof file.content !== "string" ||
        !("level" in file) ||
        !["system", "user", "repo"].includes(String(file.level))
      )
        return undefined;
      records.push({ name: file.path, tokens: estimateTextTokens(JSON.stringify(file)) });
    }
    return records;
  } catch {
    return undefined;
  }
}

function parts(message: Message): ContextPart[] {
  const result: ContextPart[] = [];
  if (Array.isArray(message.content)) {
    const blocks =
      message.role === "assistant"
        ? message.content.map((block) => ({
            block,
            tokens: estimateMessageTokens({ ...message, content: [block] }),
          }))
        : typeof message.content === "string"
          ? []
          : message.content.map((block) => ({
              block,
              tokens: estimateTextAndImageContentTokens([block]),
            }));
    for (const { block, tokens } of blocks) {
      result.push({
        name: block.type,
        tokens,
        ...(block.type === "toolCall"
          ? {
              value: [
                block.name,
                typeof block.arguments.path === "string" ? block.arguments.path : "",
              ]
                .filter(Boolean)
                .join("  "),
            }
          : block.type === "image"
            ? { value: block.mimeType }
            : {}),
      });
    }
  } else if (message.role === "system" && message.content) {
    result.push({ name: "content", tokens: estimateTextTokens(message.content) });
  }
  if (message.role !== "system") return result;
  for (const [name, text] of Object.entries(message.sections ?? {})) {
    result.push({
      name: `sections.${name}`,
      tokens: text === null ? 0 : estimateTextTokens(text),
      ...(text === null
        ? { value: "null" }
        : name === "cwd"
          ? { value: text.replace(/^<cwd>\n([\s\S]*)\n<\/cwd>$/, "$1") }
          : {}),
      ...(name === "context" && text !== null ? { children: files(text) } : {}),
    });
  }
  for (const field of ["toolsAdded", "toolsRemoved"] as const) {
    const tools = message[field];
    if (tools)
      result.push({
        name: field,
        value: tools.map((tool) => tool.name).join(" · "),
        tokens: estimateMessageTokens({
          role: "system",
          content: "",
          timestamp: 0,
          [field]: tools,
        }),
      });
  }
  return result;
}

/** Derive only from durable's projection, never from the display transcript. */
export function describeContext(
  projection: ContextView,
  conversation: number,
  model: ModelRef | null,
  capacity: number | null,
  policy: CompactionPolicy,
): ContextInspection & { state: "available" } {
  const window = capacity !== null && Number.isFinite(capacity) && capacity > 0 ? capacity : null;
  // Durable preserves message identity through ordering; synthesized results have
  // no matching contribution and intentionally receive no source entry.
  const sources = new Map<Message, ContextMessage["source"]>();
  projection.contributions.forEach((messages, index) => {
    const entry = projection.entries[index]!;
    for (const message of messages) sources.set(message, { entry: entry.id, kind: entry.kind });
  });
  const roles = new Map<Message["role"], number>();
  const messages = projection.messages.map((message): ContextMessage => {
    const tokens = estimateMessageTokens(message);
    roles.set(message.role, (roles.get(message.role) ?? 0) + tokens);
    return {
      role: message.role,
      tokens,
      source: sources.get(message),
      ...(message.role === "toolResult" ? { toolName: message.toolName } : {}),
      parts: parts(message),
    };
  });
  const tokens = messages.reduce((sum, message) => sum + message.tokens, 0);
  return {
    state: "available",
    conversation,
    head: projection.head?.id ?? null,
    tail: projection.entries.reduce<number | null>(
      (tail, entry) => Math.max(tail ?? 0, entry.id),
      null,
    ),
    model,
    window,
    tokens,
    remaining: window === null ? null : Math.max(0, window - tokens),
    fraction: window === null ? null : tokens / window,
    policy,
    blockingAt: window === null ? null : window - policy.reserveTokens,
    backgroundAt: window === null ? null : window - policy.reserveTokens - policy.backgroundTokens,
    roles: Array.from(roles, ([role, tokens]) => ({ role, tokens })),
    messages,
  };
}
