import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type {
  AgentEvent,
  ConversationId,
  EntryId,
  SnapshotEvent,
  SubmissionId,
  TaskId,
} from "@earendil-works/pi-durable";
import { SettledConversation } from "../pi-notifications.ts";

const input = 1 as SubmissionId;
const conversation = 1 as ConversationId;
const entry = 1 as EntryId;
const task = 1 as TaskId;
const start: AgentEvent = { type: "run_start", inputs: [input] };
const end: AgentEvent = { type: "run_end", inputs: [input] };
const snapshot: SnapshotEvent = {
  type: "snapshot",
  entries: [],
  tools: [],
  nestedTools: [],
  compactions: [],
  inbox: [],
  agent: {},
  usage: { models: {}, tools: {} },
};
function answer(text: string): AgentEvent {
  return {
    type: "message_end",
    entry: {
      id: entry,
      conversationId: conversation,
      kind: "pi.assistant",
      model: [fauxAssistantMessage(text)],
    },
  };
}

await test("turn and compaction ends are not settlement; run_end carries the final answer", () => {
  const state = new SettledConversation();
  state.snapshot(snapshot);
  assert.equal(state.accept([start])?.state, "working");
  assert.equal(state.accept([answer("Intermediate"), { type: "turn_end" }]), undefined);
  assert.equal(
    state.accept([{ type: "compaction_end", taskId: task, reason: "manual" }]),
    undefined,
  );
  assert.deepEqual(state.accept([answer("Final\nanswer"), end]), {
    state: "done",
    app: "pi",
    msg: "Final\nanswer",
  });
  assert.equal(state.accept([{ type: "turn_end" }]), undefined);
});

await test("run_end/run_start in one commit and queued follow-ups suppress intermediate alerts", () => {
  const state = new SettledConversation();
  state.accept([start]);
  assert.equal(state.accept([answer("Intermediate"), end, start])?.state, "working");
  assert.equal(
    state.accept([
      answer("Next"),
      end,
      { type: "inbox_update", items: [{ id: input, mode: "followUp" }] },
    ]),
    undefined,
  );
  assert.equal(state.accept([{ type: "inbox_update", items: [] }, start])?.state, "working");
  assert.equal(state.accept([answer("Last"), end])?.msg, "Last");
});

await test("snapshots and stream overflow establish a baseline without replaying completion", () => {
  const state = new SettledConversation();
  state.snapshot({
    ...snapshot,
    entries: [
      {
        id: entry,
        conversationId: conversation,
        kind: "pi.assistant",
        model: [fauxAssistantMessage("Old answer")],
      },
    ],
  });
  assert.equal(state.accept([{ type: "turn_end" }]), undefined);
  state.accept([start]);
  assert.equal(state.accept([snapshot])?.state, "idle");
  assert.equal(
    state.accept([{ type: "compaction_end", taskId: task, reason: "manual" }]),
    undefined,
  );
  state.snapshot({ ...snapshot, run: { inputs: [input] } });
  assert.equal(state.accept([answer("Resumed"), end])?.msg, "Resumed");
});

await test("failure details survive settlement; unrelated cancelled inputs do not silence a run", () => {
  const state = new SettledConversation();
  state.accept([start]);
  assert.equal(
    state.accept([
      { type: "task_failed", taskId: task, kind: "pi.generation", message: "Provider unavailable" },
    ]),
    undefined,
  );
  assert.deepEqual(state.accept([end]), { state: "error", app: "pi", msg: "Provider unavailable" });
  state.accept([start]);
  assert.deepEqual(
    state.accept([
      end,
      {
        type: "submission",
        record: {
          id: input,
          conversationId: conversation,
          type: "input",
          status: "unanswered",
          reason: "model_error",
          detail: "Original error",
        },
      },
    ]),
    { state: "error", app: "pi", msg: "Original error" },
  );
  state.accept([start]);
  state.accept([
    {
      type: "submission",
      record: {
        id: 2 as SubmissionId,
        conversationId: conversation,
        type: "input",
        status: "unanswered",
        reason: "aborted",
      },
    },
  ]);
  assert.equal(state.accept([answer("Done"), end])?.state, "done");
});

await test("previews omit thinking and tool arguments, and bound control/Unicode text", () => {
  const state = new SettledConversation();
  state.accept([start]);
  const event: AgentEvent = {
    type: "message_end",
    entry: {
      id: entry,
      conversationId: conversation,
      kind: "pi.assistant",
      model: [
        fauxAssistantMessage([
          { type: "thinking", thinking: "PRIVATE REASONING" },
          {
            type: "toolCall",
            id: "tool1",
            name: "tool",
            arguments: { secret: "PRIVATE ARGUMENT" },
          },
          { type: "text", text: "Hello\u0000\n" + "🙂".repeat(1024) },
        ]),
      ],
    },
  };
  const result = state.accept([event, end]);
  assert(result?.msg);
  assert(!result.msg.includes("PRIVATE"));
  assert(!result.msg.includes("\u0000"));
  assert(result.msg.isWellFormed());
  assert(Buffer.byteLength(result.msg) <= 2048);
});
