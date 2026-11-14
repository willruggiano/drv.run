import assert from "node:assert/strict";
import {
  BACKGROUND_CONTEXT,
  awaitWithContext,
  withAbortSignal,
} from "@earendil-works/chord/context";
import type { Op } from "@earendil-works/chord/delta";
import { copyJson } from "@earendil-works/chord/json";
import { Watch, type WatchEnd } from "@earendil-works/chord/watch";
import type {
  ConversationId,
  ConversationView,
  ConversationWindow,
  EntryRecord,
  Observation,
} from "@earendil-works/pi-durable";
import { Problem } from "../src/problem.ts";
import type { Sessions } from "../src/sessions.ts";

type Query = {
  readonly externalId: string;
  readonly conversationId: ConversationId;
};
type Options = {
  readonly sessions: Sessions;
  readonly window?: Pick<ConversationWindow, "min" | "max">;
  /** Server-side lifecycle diagnostics. An observer's failed end need not mean storage failed. */
  readonly onEnd: (end: WatchEnd) => void;
};
type State = {
  readonly view: ConversationView;
  readonly head: EntryRecord | null;
};

function prefixed(op: Op): Op {
  // Pi 1.5.2 observers deliver unfolded view operations, never root replacements.
  assert(op[0] !== "r");
  switch (op[0]) {
    case "s":
      return ["s", ["view", ...op[1]], op[2]];
    case "d":
      return ["d", ["view", ...op[1]]];
    case "a":
      return ["a", ["view", ...op[1]], op[2]];
    case "t":
      return ["t", ["view", ...op[1]], op[2]];
    case "m":
      return ["m", ["view", ...op[1]], op[2]];
    case "p":
      return ["p", ["view", ...op[1]], op[2], op[3], op[4]];
  }
}

export async function watch(
  query: Query,
  signal: AbortSignal,
  options: Options,
): Promise<ReadableStream<readonly Op[]>> {
  const context = withAbortSignal(signal, BACKGROUND_CONTEXT);
  signal.throwIfAborted();
  const harness = await awaitWithContext(options.sessions.get(query.externalId), context);
  if (!harness) throw new Problem(404);
  const conversation = await harness.conversation(query.conversationId, context);
  if (!conversation) throw new Problem(404);

  let observation: Observation<ConversationView> | undefined;
  let latest: ConversationView | undefined;
  let state: State | undefined;
  let output: Watch<State> | undefined;
  let end: WatchEnd | undefined;
  const detach = () => {
    observation?.detach();
    signal.removeEventListener("abort", abort);
  };
  const abort = () => {
    end = { kind: "aborted" };
    output?.abort();
    detach();
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    observation = await harness.observeConversation(
      query.conversationId,
      {
        advance(call, frameContext) {
          assert(call.kind === "value");
          latest = call.value;
          if (!state) return;
          let head = state.head;
          for (const op of call.ops) {
            if (op[0] !== "p" || op[1].length !== 1 || op[1][0] !== "entries") continue;
            for (const value of op[4]) {
              assert(value !== null && typeof value === "object" && !Array.isArray(value));
              if (value.head !== undefined) {
                // Native EntryRecords lose their branded IDs and readonly type in Chord's Op payload.
                head = value as EntryRecord & typeof value;
              }
            }
          }
          const ops = call.ops.map(prefixed);
          if (head !== state.head) ops.push(["s", ["head"], copyJson(head)]);
          state = { view: latest, head };
          output!.advance({ kind: "value", value: state, ops, retired: false }, frameContext);
        },
        end(value) {
          end = value;
          output?.end(value);
          detach();
        },
      },
      context,
      options.window,
    );
    latest ??= observation.value;
    signal.throwIfAborted();
    const delivery = await conversation.commit(async (tx) => {
      const head = (await tx.latestHeadMarker(query.conversationId)) ?? null;
      signal.throwIfAborted();
      if (end) throw new Problem(503);
      assert(latest);
      state = { view: latest, head };
      output = new Watch(state, detach, () => {});
      return { output, baseline: copyJson(state) };
    }, context);
    signal.throwIfAborted();
    if (end) throw new Problem(503);

    let stopped = false;
    let started = false;
    let resume = () => {};
    let delivered = () => {};
    return new ReadableStream<readonly Op[]>(
      {
        start(controller) {
          controller.enqueue([["r", delivery.baseline]]);
          void delivery.output.closed
            .then((value) => {
              resume();
              delivered();
              if (!stopped) {
                stopped = true;
                controller.close();
              }
              options.onEnd(value);
            })
            .catch((error: unknown) => controller.error(error));
        },
        pull(controller) {
          const next = Promise.withResolvers<void>();
          delivered = next.resolve;
          if (!started) {
            started = true;
            delivery.output.start(async (call) => {
              assert(call.kind === "value");
              const demand = Promise.withResolvers<void>();
              resume = demand.resolve;
              controller.enqueue(call.ops);
              delivered();
              // Keep Chord's listener busy until the next read; it folds intervening commits.
              await demand.promise;
            });
          } else resume();
          return next.promise;
        },
        async cancel() {
          stopped = true;
          await delivery.output.stop();
        },
      },
      { highWaterMark: 0 },
    );
  } catch (error) {
    output?.end({ kind: "failed", error });
    detach();
    throw error;
  }
}
