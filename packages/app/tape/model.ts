import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { defineDocFamily, type EntryDraft, type LiveState } from "@earendil-works/pi-durable";
import type { AssistantMessage } from "@earendil-works/pi-ai";

// The first tape version deliberately admits no tasks, submissions, tools,
// arbitrary document kinds, executable instructions, or external resources.
export type Presentation = {
  panel: "conversation" | "settings" | "context" | "defaults";
  draft: string;
};
export const PresentationDoc = defineDocFamily<Presentation, null>({
  kind: "app.presentation",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ panel: "conversation", draft: "" }),
  checkpointWhen: () => true,
});
export const viewer = "showcase";
export type Change =
  | { kind: "app.presentation"; version: 1; key: typeof viewer; value: Presentation }
  | { kind: "pi.live"; version: 1; value: LiveState };
export type Frame =
  | { type: "commit"; seq: number; changes: Change[] }
  | { type: "capture"; name: string };
export type Tape = {
  kind: "app.tape";
  version: 1;
  complete: true;
  scene: string;
  initial: { name: string; created: number; entries: EntryDraft[]; presentation: Presentation };
  frames: Frame[];
};
export const maxBytes = 2 * 1024 * 1024;
export const maxFrames = 256;
export const digest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  assert(isObject(value), "Expected object");
  const record = value;
  assert(
    Object.keys(record).every((key) => keys.includes(key)),
    "Unsupported field",
  );
  return record;
}
function string(value: unknown): string {
  assert(typeof value === "string" && value.length <= 100_000, "Expected bounded string");
  return value;
}
function number(value: unknown): number {
  assert(
    typeof value === "number" && Number.isFinite(value) && value >= 0,
    "Expected finite nonnegative number",
  );
  return value;
}
function list(value: unknown, maximum = maxFrames): unknown[] {
  assert(Array.isArray(value) && value.length <= maximum, "Expected bounded array");
  return value;
}
export function name(value: unknown): string {
  const result = string(value);
  assert(/^[a-z][a-z0-9-]{0,63}$/.test(result), "Expected a safe artifact name");
  return result;
}
export function presentation(value: unknown): Presentation {
  const state = object(value, ["panel", "draft"]);
  const panel = state.panel;
  assert(
    panel === "conversation" || panel === "settings" || panel === "context" || panel === "defaults",
    "Unsupported panel",
  );
  return { panel, draft: string(state.draft) };
}
function assistant(
  value: unknown,
): Pick<
  AssistantMessage,
  "role" | "api" | "provider" | "model" | "usage" | "stopReason" | "timestamp"
> & { content: { type: "text"; text: string }[] } {
  const message = object(value, [
    "role",
    "content",
    "api",
    "provider",
    "model",
    "usage",
    "stopReason",
    "timestamp",
  ]);
  assert(
    message.role === "assistant" && message.stopReason === "stop",
    "Only text assistant observations are supported",
  );
  const usage = object(message.usage, [
    "input",
    "output",
    "cacheRead",
    "cacheWrite",
    "totalTokens",
    "cost",
  ]);
  const cost = object(usage.cost, ["input", "output", "cacheRead", "cacheWrite", "total"]);
  return {
    role: "assistant",
    content: list(message.content, 32).map((item) => {
      const block = object(item, ["type", "text"]);
      assert(block.type === "text", "Only text blocks are supported");
      return { type: "text", text: string(block.text) };
    }),
    api: string(message.api),
    provider: string(message.provider),
    model: string(message.model),
    stopReason: "stop",
    timestamp: number(message.timestamp),
    usage: {
      input: number(usage.input),
      output: number(usage.output),
      cacheRead: number(usage.cacheRead),
      cacheWrite: number(usage.cacheWrite),
      totalTokens: number(usage.totalTokens),
      cost: {
        input: number(cost.input),
        output: number(cost.output),
        cacheRead: number(cost.cacheRead),
        cacheWrite: number(cost.cacheWrite),
        total: number(cost.total),
      },
    },
  };
}
export function live(value: unknown): LiveState {
  const state = object(value, ["generation"]);
  if (state.generation === undefined) return {};
  const generation = object(state.generation, ["attempt", "message"]);
  assert(generation.attempt === 1, "Only the first observed generation attempt is supported");
  return { generation: { attempt: 1, message: assistant(generation.message) } };
}
export function decode(text: string): Tape {
  assert(Buffer.byteLength(text) <= maxBytes, "Tape exceeds size limit");
  const root = object(JSON.parse(text), [
    "kind",
    "version",
    "complete",
    "scene",
    "initial",
    "frames",
  ]);
  assert(root.kind === "app.tape" && root.version === 1, "Unsupported tape kind/version");
  assert(root.complete === true, "Incomplete recording");
  const initial = object(root.initial, ["name", "created", "entries", "presentation"]);
  const entries = list(initial.entries, 64).map((item): EntryDraft => {
    const entry = object(item, ["kind", "model"]);
    const model = list(entry.model, 1);
    assert(model.length === 1, "Expected exactly one message");
    if (entry.kind === "pi.assistant") return { kind: entry.kind, model: [assistant(model[0])] };
    assert(entry.kind === "pi.user", "Unsupported entry kind");
    const message = object(model[0], ["role", "content", "timestamp"]);
    assert(message.role === "user");
    return {
      kind: entry.kind,
      model: [
        { role: "user", content: string(message.content), timestamp: number(message.timestamp) },
      ],
    };
  });
  let seq = 0;
  const captures = new Set<string>();
  const frames = list(root.frames).map((item): Frame => {
    const frame = object(item, ["type", "seq", "changes", "name"]);
    if (frame.type === "capture") {
      assert(frame.seq === undefined && frame.changes === undefined);
      const id = name(frame.name);
      assert(!captures.has(id), "Duplicate checkpoint");
      captures.add(id);
      return { type: "capture", name: id };
    }
    assert(frame.type === "commit" && frame.name === undefined, "Unsupported frame");
    const next = number(frame.seq);
    assert(
      Number.isSafeInteger(next) && next > seq,
      "Commit sequences must increase; gaps are allowed",
    );
    seq = next;
    const kinds = new Set<string>();
    const changes = list(frame.changes, 2).map((item): Change => {
      const change = object(item, ["kind", "version", "key", "value"]);
      assert(change.version === 1, "Unsupported document version");
      const kind = string(change.kind);
      assert(!kinds.has(kind), "Duplicate document in commit");
      kinds.add(kind);
      if (kind === "app.presentation") {
        assert(change.key === viewer, "Unsupported viewer");
        return { kind, version: 1, key: viewer, value: presentation(change.value) };
      }
      assert(kind === "pi.live" && change.key === undefined, "Unsupported document kind");
      return { kind, version: 1, value: live(change.value) };
    });
    assert(changes.length > 0, "Empty commit frame");
    return { type: "commit", seq: next, changes };
  });
  assert(captures.size > 0, "Tape has no checkpoints");
  return {
    kind: "app.tape",
    version: 1,
    complete: true,
    scene: name(root.scene),
    initial: {
      name: string(initial.name),
      created: number(initial.created),
      entries,
      presentation: presentation(initial.presentation),
    },
    frames,
  };
}
