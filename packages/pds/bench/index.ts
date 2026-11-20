import assert from "node:assert/strict";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { copyJson } from "@earendil-works/chord/json";
import type { Op } from "@earendil-works/chord/delta";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import type { ConversationRecord, EntryRecord } from "@earendil-works/pi-durable";
import hljs from "highlight.js";
import { regions } from "../src/render.ts";
import { patch } from "../src/server.ts";
import { Projection, type Patch } from "../src/watch.ts";

type State = Parameters<Projection["update"]>[0];
type Frame = { state: State; ops: readonly Op[] };
const samples = 10;
const chunks = 16;

/** Read stored records in one SQLite snapshot. SQLite alone handles any journal/WAL. */
function load(path: string, conversation?: number) {
  if (conversation !== undefined)
    assert(Number.isSafeInteger(conversation) && conversation >= 0, "Invalid conversation ID");
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    database.exec("BEGIN");
    const selected =
      conversation ??
      database
        .prepare(`
      SELECT c.id FROM conversations c LEFT JOIN entries e ON e.conversation_id = c.id
      GROUP BY c.id ORDER BY count(e.id) DESC, c.id ASC LIMIT 1
    `)
        .get()?.id;
    assert(typeof selected === "number", "Database has no conversations");
    const row = database.prepare("SELECT record FROM conversations WHERE id = ?").get(selected);
    assert(row && typeof row.record === "string", `Conversation ${selected} not found`);
    // The database stores Durable's JSON records; no app-specific metadata is required.
    const record = JSON.parse(row.record) as ConversationRecord;
    assert.equal(record.id, selected);
    const entries = database
      .prepare("SELECT record FROM entries WHERE conversation_id = ? ORDER BY id")
      .all(selected)
      .map((row) => {
        assert(typeof row.record === "string");
        const entry = JSON.parse(row.record) as EntryRecord;
        assert.equal(entry.conversationId, selected);
        return entry;
      });
    return { record, entries };
  } finally {
    database.close();
  }
}

function prepare(record: ConversationRecord, entries: readonly EntryRecord[]) {
  const empty: State = {
    view: { conversation: record, entries: [], docs: {} },
    head: null,
    environment: "local",
  };
  let state = empty;
  const frames: Frame[] = [];
  for (const entry of entries) {
    let window = [...state.view.entries, entry];
    let before = state.view.before;
    const ops: Op[] = [["p", ["view", "entries"], state.view.entries.length, 0, [copyJson(entry)]]];
    if (window.length > 100) {
      const drop = window.length - 50;
      before = window[drop - 1]!.id;
      window = window.slice(drop);
      ops.push(["p", ["view", "entries"], 0, drop, []], ["s", ["view", "before"], before]);
    }
    if (entry.head !== undefined) ops.push(["s", ["head"], copyJson(entry)]);
    state = {
      ...state,
      head: entry.head === undefined ? state.head : entry,
      view: { ...state.view, entries: window, ...(before === undefined ? {} : { before }) },
    };
    frames.push({ state, ops });
  }
  return { empty, frames };
}

/** Server transcript benchmarks: no database writes, harness scheduling, network, or browser. */
export function suite(path: string, conversation?: number) {
  const db = resolve(path);
  const { record, entries } = load(db, conversation);
  const { empty, frames } = prepare(record, entries);
  const tail = frames.at(-1)?.state ?? empty;
  const baseline: State = {
    ...tail,
    view: {
      ...empty.view,
      entries: entries.slice(-50),
      ...(entries.length > 50 ? { before: entries[entries.length - 51]!.id } : {}),
    },
  };
  // Configuration rendering involves discovery, not transcript rendering. Exclude it.
  const projection = () => new Projection(`/api/s/benchmark/c/${record.id}`);
  const prime = async (state: State) => {
    const result = projection();
    await result.update(state);
    return result;
  };
  type Run = (emit: (patches: readonly Patch[]) => void) => Promise<void>;
  type Case = { name: string; operations: number; setup(): Promise<Run> };
  const cases: Case[] = [
    {
      name: "initial-window",
      operations: 1,
      async setup() {
        const current = projection();
        return async (emit) => {
          emit(await current.update(baseline));
        };
      },
    },
  ];
  if (entries.length) {
    const pages = Array.from({ length: Math.ceil(entries.length / 50) }, (_, index) =>
      entries.slice(index * 50, index * 50 + 50),
    );
    cases.push(
      {
        name: "history-pages",
        operations: pages.length,
        async setup() {
          return async (emit) => {
            for (const page of pages) {
              const tools = regions.tools({ entries: page, docs: {} });
              emit([{ html: page.map((entry) => regions.entry(entry, tools)).join("") }]);
            }
          };
        },
      },
      {
        name: "entry-appends",
        operations: frames.length,
        async setup() {
          const current = await prime(empty);
          return async (emit) => {
            for (const frame of frames) emit(await current.update(frame.state, frame.ops));
          };
        },
      },
    );
  }
  const boundaries = frames.flatMap((frame, index) =>
    entries[index]!.head === undefined
      ? []
      : [{ frame, before: frames[index - 1]?.state ?? empty }],
  );
  if (boundaries.length)
    cases.push({
      name: "context-boundaries",
      operations: boundaries.length,
      async setup() {
        const primed = await Promise.all(
          boundaries.map(async ({ frame, before }) => ({ frame, current: await prime(before) })),
        );
        return async (emit) => {
          for (const { frame, current } of primed)
            emit(await current.update(frame.state, frame.ops));
        };
      },
    });

  // Deterministic synthetic progress from the longest recorded text response/output.
  let response: { message: AssistantMessage; index: number; length: number } | undefined;
  const calls = new Map<string, { call: ToolCall; index: number }>();
  let output: { call: ToolCall; index: number; text: string } | undefined;
  for (const [index, entry] of entries.entries())
    for (const message of entry.model ?? []) {
      if (message.role === "assistant") {
        const length = message.content.reduce(
          (sum, part) => sum + (part.type === "text" ? part.text.length : 0),
          0,
        );
        if (length > (response?.length ?? 0)) response = { message, index, length };
        for (const part of message.content)
          if (part.type === "toolCall") calls.set(part.id, { call: part, index });
      } else if (message.role === "toolResult") {
        const call = calls.get(message.toolCallId);
        const text = message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
        if (call && text.length > (output?.text.length ?? 0)) output = { ...call, text };
      }
    }
  const progress = (name: string, before: State, updates: Frame[]) =>
    cases.push({
      name,
      operations: updates.length,
      async setup() {
        const current = await prime(before);
        return async (emit) => {
          for (const frame of updates) emit(await current.update(frame.state, frame.ops));
        };
      },
    });
  const liveFrame = (before: State, value: State["view"]["docs"][string]): Frame => ({
    state: { ...before, view: { ...before.view, docs: { ...before.view.docs, "pi.live": value } } },
    ops: [["s", ["view", "docs", "pi.live"], value]],
  });
  if (response) {
    const { message, index } = response;
    const before = frames[index - 1]?.state ?? empty;
    const updates = Array.from({ length: chunks }, (_, step) =>
      liveFrame(before, {
        generation: {
          attempt: 1,
          message: copyJson({
            ...message,
            content: message.content
              .filter((part) => part.type === "text")
              .map((part) => ({
                ...part,
                text: part.text.slice(0, Math.ceil((part.text.length * (step + 1)) / chunks)),
              })),
          }),
        },
      }),
    );
    const final = frames[index]!;
    updates.push({ state: final.state, ops: [...final.ops, ["d", ["view", "docs", "pi.live"]]] });
    progress("synthetic-response-and-finalization", before, updates);
  }
  if (output) {
    const { call, index, text } = output;
    const before = frames[index]!.state;
    progress(
      "synthetic-tool-progress",
      before,
      Array.from({ length: chunks }, (_, step) =>
        liveFrame(before, {
          tools: [
            {
              callId: call.id,
              name: call.name,
              status: "running",
              output: text.slice(0, Math.ceil((text.length * (step + 1)) / chunks)),
            },
          ],
        }),
      ),
    );
  }

  return {
    db,
    conversation: record.id,
    storedEntries: entries.length,
    scope:
      "Server transcript rendering and SSE encoding; excludes loading, chrome, transport, and browser. Progress is synthetic; fork-inherited entries are not loaded.",
    synthetic: {
      chunks,
      responseEntry: response ? entries[response.index]!.id : null,
      toolCallEntry: output ? entries[output.index]!.id : null,
    },
    cases,
  };
}

async function benchmark(path: string, conversation?: number) {
  const { cases, ...source } = suite(path, conversation);
  let highlights = 0;
  const original = Object.getOwnPropertyDescriptor(hljs, "highlight");
  assert(original);
  hljs.highlight = new Proxy(hljs.highlight.bind(hljs), {
    apply(target, receiver, args) {
      highlights++;
      return Reflect.apply(target, receiver, args);
    },
  });
  try {
    const results = [];
    for (const scenario of cases) {
      const timings: number[] = [];
      let counters:
        | { htmlBytes: number; sseBytes: number; patches: number; highlights: number }
        | undefined;
      // One unreported warm-up, then ten fresh projection instances per workload.
      for (let sample = -1; sample < samples; sample++) {
        const run = await scenario.setup();
        highlights = 0;
        const counts = { htmlBytes: 0, sseBytes: 0, patches: 0, highlights: 0 };
        const start = performance.now();
        await run((patches) => {
          for (const { html, ...options } of patches) {
            counts.htmlBytes += Buffer.byteLength(html);
            counts.sseBytes += Buffer.byteLength(patch(html, options));
            counts.patches++;
          }
        });
        const elapsed = performance.now() - start;
        counts.highlights = highlights;
        if (sample < 0) continue;
        if (counters) assert.deepEqual(counts, counters, "Benchmark work changed between samples");
        counters = counts;
        timings.push(elapsed);
      }
      const sorted = [...timings].sort((a, b) => a - b);
      results.push({
        name: scenario.name,
        operations: scenario.operations,
        ...counters,
        medianMs: sorted[Math.ceil(samples * 0.5) - 1]!,
        p95Ms: sorted[Math.ceil(samples * 0.95) - 1]!,
        samplesMs: timings,
      });
    }
    return {
      ...source,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      results,
    };
  } finally {
    Object.defineProperty(hljs, "highlight", original);
  }
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({
      options: {
        db: { type: "string" },
        conversation: { type: "string" },
        help: { type: "boolean" },
      },
    });
    if (values.help) console.log("pds-bench --db /path/to/session.sqlite [--conversation id]");
    else {
      assert(values.db, "Usage: pds-bench --db /path/to/session.sqlite [--conversation id]");
      if (values.conversation !== undefined)
        assert(/^\d+$/.test(values.conversation), "Invalid conversation ID");
      console.log(
        JSON.stringify(
          await benchmark(
            values.db,
            values.conversation === undefined ? undefined : Number(values.conversation),
          ),
          null,
          2,
        ),
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
