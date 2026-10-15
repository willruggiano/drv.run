import assert from "node:assert/strict";
import { withAbortSignal } from "@earendil-works/chord/context";
import type { ToolCall } from "@earendil-works/pi-ai";
import type { Op } from "@earendil-works/chord/delta";
import { copyJson } from "@earendil-works/chord/json";
import { Watch, type WatchEnd } from "@earendil-works/chord/watch";
import {
  AgentDoc,
  InboxDoc,
  LiveDoc,
  UsageDoc,
  type Conversation,
  type ConversationView,
  type EntryRecord,
  type Observation,
} from "@earendil-works/pi-durable";
import { Env } from "durable-harness";
import { context, type Application } from "./application.ts";
import { regions } from "./render.ts";

type State = {
  view: ConversationView;
  head: EntryRecord | null;
  environment: string;
};

/** Native observation plus a head marker that survives window eviction. */
export async function observe(app: Application, conversation: Conversation, signal: AbortSignal) {
  const ctx = withAbortSignal(signal, context);
  let view: ConversationView | undefined;
  let environment = "local";
  let environmentAdvanced = false;
  let state: State | undefined;
  let output: Watch<State> | undefined;
  let end: WatchEnd | undefined;
  const observations: Pick<Observation<unknown>, "detach">[] = [];
  const detach = () => {
    for (const observation of observations) observation.detach();
    signal.removeEventListener("abort", abort);
  };
  const abort = () => {
    output?.abort();
    detach();
  };
  const ended = (value: WatchEnd) => {
    end = value;
    output?.end(value);
    detach();
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    const observed = await app.harness.observeConversation(
      conversation.id,
      {
        advance(call, frameContext) {
          assert(call.kind === "value");
          view = call.value;
          if (!state) return;
          let head = state.head;
          // Native entry appends are splices. Inspect before Chord folds/evicts them.
          for (const op of call.ops) {
            if (op[0] !== "p" || op[1].length !== 1 || op[1][0] !== "entries") continue;
            for (const record of op[4]) {
              assert(record !== null && typeof record === "object" && !Array.isArray(record));
              if (record.head !== undefined) head = record as EntryRecord & typeof record;
            }
          }
          const ops = call.ops.map(prefix);
          if (head !== state.head) ops.push(["s", ["head"], copyJson(head)]);
          state = { view, head, environment };
          output!.advance({ kind: "value", value: state, ops, retired: false }, frameContext);
        },
        end: ended,
      },
      ctx,
    );
    observations.push(observed);
    view ??= observed.value;
    signal.throwIfAborted();
    const env = await app.harness.observeDoc(
      Env,
      conversation.id,
      {
        advance(call, frameContext) {
          assert(call.kind === "value");
          environmentAdvanced = true;
          environment = call.value.env?.host ?? "local";
          if (!state) return;
          state = { ...state, environment };
          output!.advance(
            {
              kind: "value",
              value: state,
              ops: [["s", ["environment"], environment]],
              retired: false,
            },
            frameContext,
          );
        },
        end: ended,
      },
      ctx,
    );
    assert(env, "PDS conversations have an environment document");
    observations.push(env);
    if (!environmentAdvanced) environment = env.value.env?.host ?? "local";
    // Calls can precede acquisition resolution; the line read below selects the latest value.
    const watch = await conversation.commit(async (tx) => {
      const head = (await tx.latestHeadMarker(conversation.id)) ?? null;
      signal.throwIfAborted();
      assert(!end && view, "Observation ended during acquisition");
      state = { view, head, environment };
      output = new Watch(state, detach, () => {});
      return output;
    }, ctx);
    signal.throwIfAborted();
    assert(!end, "Observation ended during acquisition");
    return watch;
  } catch (error) {
    output?.end({ kind: "failed", error });
    detach();
    throw error;
  }
}

function prefix(op: Op): Op {
  assert(op[0] !== "r");
  const path = ["view", ...op[1]] as const;
  switch (op[0]) {
    case "s":
      return ["s", path, op[2]];
    case "d":
      return ["d", path];
    case "a":
      return ["a", path, op[2]];
    case "t":
      return ["t", path, op[2]];
    case "m":
      return ["m", path, op[2]];
    case "p":
      return ["p", path, op[2], op[3], op[4]];
  }
}

export type Patch = { html: string; selector?: string; mode?: "append" };

/** Disposable per-observer HTML projection, not a second conversation store. */
export class Projection {
  #head: number | null | undefined;
  #last = -1;
  #html = new Map<string, string>();
  #tools = new Map<string, string>();
  #calls = new Map<string, ToolCall>();
  readonly chrome: {
    configuration?(): Promise<Readonly<Record<string, string>>>;
    metadata?(view: ConversationView): Promise<string>;
  };
  constructor(chrome: Projection["chrome"] = {}) {
    this.chrome = chrome;
  }

  async update(state: State, ops?: readonly Op[]): Promise<Patch[]> {
    const patches: Patch[] = [];
    const { view, head } = state;
    const changed = (...path: string[]) =>
      !ops ||
      ops.some(
        (op) =>
          op[0] === "r" || path.slice(0, op[1].length).every((key, index) => key === op[1][index]),
      );
    const cached = (key: string, html: string) => {
      if (this.#html.get(key) !== html) {
        this.#html.set(key, html);
        patches.push({ html });
      }
    };
    const baseline = this.#head === undefined || this.#head !== (head?.id ?? null);
    if (baseline) {
      patches.push({ html: regions.baseline(view, head) });
      this.#head = head?.id ?? null;
      this.#last = view.entries.at(-1)?.id ?? -1;
      this.#html.delete("live");
      this.#html.delete("status");
      this.#tools = regions.toolUpdates(view);
      this.#calls = regions.calls(view);
    } else if (changed("view", "entries")) {
      const added = view.entries.filter(
        (record) => record.id > this.#last && record.id !== head?.id,
      );
      if (added.length) {
        const gap =
          view.before !== undefined && view.before > this.#last
            ? regions.history(
                view.conversation.id,
                added[0]!.id,
                this.#last < 0 ? undefined : this.#last,
              )
            : "";
        const tools = regions.tools(view, this.#calls);
        patches.push({
          html: gap + added.map((record) => regions.entry(record, tools)).join(""),
          selector: "#entries",
          mode: "append",
        });
        this.#last = added.at(-1)!.id;
      }
    }
    if (baseline || changed("view", "docs", LiveDoc.definition.kind, "generation"))
      cached("live", regions.live(view));
    if (baseline || changed("view", "docs", LiveDoc.definition.kind))
      cached("status", regions.status(view));
    if (changed("view", "docs", InboxDoc.definition.kind)) cached("queue", regions.queue(view));
    if (
      !baseline &&
      (changed("view", "entries") || changed("view", "docs", LiveDoc.definition.kind, "tools"))
    ) {
      const tools = regions.toolUpdates(view, this.#calls);
      for (const [id, html] of tools)
        if (this.#tools.has(id) && this.#tools.get(id) !== html) patches.push({ html });
      this.#tools = tools;
      this.#calls = regions.calls(view, this.#calls);
    }
    if (
      this.chrome.metadata &&
      (changed("view", "docs", UsageDoc.definition.kind) ||
        changed("view", "docs", AgentDoc.definition.kind) ||
        changed("view", "entries"))
    )
      cached("metadata", await this.chrome.metadata(view));
    if (
      this.chrome.configuration &&
      (changed("view", "docs", AgentDoc.definition.kind) || changed("environment"))
    ) {
      for (const [key, html] of Object.entries(await this.chrome.configuration()))
        cached(key, html);
    }
    return patches;
  }
}
