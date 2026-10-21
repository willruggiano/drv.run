import { Environment, environment, getConversation, type Session } from "./index.ts";
import assert from "node:assert/strict";
import { posix } from "node:path";
import { BACKGROUND_CONTEXT, awaitWithContext } from "@earendil-works/chord/context";
import { Type, type Static, type TSchema } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import {
  defineDoc,
  defineExtension,
  defineTool,
  section,
  LiveDoc,
  InboxDoc,
  type Conversation,
  type ConversationId,
  type TaskId,
  type Tx,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { reviewInstructions } from "./review-instructions.ts";

const context = BACKGROUND_CONTEXT;
const strict = { additionalProperties: false };
const text = (maxLength = 10000) => Type.String({ minLength: 1, maxLength, pattern: "\\S" });
const id = Type.String({ minLength: 1, maxLength: 80, pattern: "^[a-zA-Z0-9_-]+$" });
const note = Type.String({ maxLength: 10000 });
const option = Type.Object(
  {
    value: id,
    label: text(300),
    description: Type.Optional(text()),
    preview: Type.Optional(text()),
    recommended: Type.Optional(Type.Boolean()),
  },
  strict,
);
export const AskSchema = Type.Object(
  {
    title: Type.Optional(text(300)),
    questions: Type.Array(
      Type.Object(
        {
          id,
          prompt: text(),
          label: Type.Optional(text(100)),
          type: Type.Union([Type.Literal("single"), Type.Literal("multiple")]),
          preview: Type.Optional(Type.Boolean()),
          options: Type.Array(option, { maxItems: 30 }),
        },
        strict,
      ),
      { minItems: 1, maxItems: 20 },
    ),
  },
  strict,
);
export type AskRequest = Static<typeof AskSchema>;
export const AnswerSchema = Type.Object(
  {
    action: Type.Union([Type.Literal("submit"), Type.Literal("elaborate"), Type.Literal("cancel")]),
    answers: Type.Array(
      Type.Object(
        {
          id,
          selected: Type.Array(id, { maxItems: 30, uniqueItems: true }),
          text: Type.Optional(note),
          note: Type.Optional(note),
          optionNotes: Type.Array(Type.Object({ value: id, note }, strict), { maxItems: 30 }),
        },
        strict,
      ),
      { maxItems: 20 },
    ),
  },
  strict,
);
export type AskResponse = Static<typeof AnswerSchema>;
export type AskRecord = { request: AskRequest; response?: AskResponse };
export type AskView = AskRecord & { id: number; actionable: boolean };

export const ReviewTargetSchema = Type.Union([
  Type.Object({ kind: Type.Literal("uncommitted") }, strict),
  Type.Object({ kind: Type.Literal("branch"), ref: text(300) }, strict),
  Type.Object({ kind: Type.Literal("commit"), ref: text(300) }, strict),
  Type.Object(
    { kind: Type.Literal("paths"), paths: Type.Array(text(4096), { minItems: 1, maxItems: 30 }) },
    strict,
  ),
]);
export const ReviewStartSchema = Type.Object(
  { target: ReviewTargetSchema, instructions: Type.Optional(note) },
  strict,
);
export type ReviewTarget = Static<typeof ReviewTargetSchema>;
export const ReportSchema = Type.Object(
  {
    scope: text(),
    findings: Type.Array(
      Type.Object(
        {
          id,
          priority: Type.Union([
            Type.Literal("P0"),
            Type.Literal("P1"),
            Type.Literal("P2"),
            Type.Literal("P3"),
          ]),
          title: text(300),
          file: text(4096),
          startLine: Type.Integer({ minimum: 1 }),
          endLine: Type.Integer({ minimum: 1 }),
          explanation: text(),
          suggestion: Type.Optional(text()),
        },
        strict,
      ),
      { maxItems: 100 },
    ),
    verdict: Type.Union([Type.Literal("correct"), Type.Literal("needs attention")]),
    callouts: Type.Array(text(), { maxItems: 30 }),
  },
  strict,
);
export type ReviewReport = Static<typeof ReportSchema>;
export const ReviewFinishSchema = Type.Object(
  {
    action: Type.Union([Type.Literal("return"), Type.Literal("handoff"), Type.Literal("fix")]),
    findings: Type.Array(id, { maxItems: 100, uniqueItems: true }),
    requestId: Type.String({
      pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    }),
  },
  strict,
);
export type ReviewState = {
  origin: number;
  originEntry?: number;
  cwd: string;
  target: ReviewTarget;
  resolved: { head?: string; base?: string; commit?: string };
  instructions: string;
  scope: string;
  report?: ReviewReport;
};
export type WorkflowState = { asks: Record<string, AskRecord>; review?: ReviewState };
export type WorkflowView = { asks: AskView[]; review?: ReviewState };
export const Workflows = defineDoc<WorkflowState>({
  kind: "app.workflows",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ asks: {} }),
});

export class WorkflowError extends Error {
  readonly code: "invalid" | "conflict" | "not_found" | "unavailable";
  constructor(code: WorkflowError["code"], message: string) {
    super(message);
    this.code = code;
  }
}
export function validate<S extends TSchema>(schema: S, value: unknown): Static<S> {
  if (!Value.Check(schema, value)) throw new WorkflowError("invalid", "Invalid workflow input.");
  // Snapshot caller-owned objects before any asynchronous operation.
  return structuredClone(value) as Static<S>;
}
function unique(values: string[], description: string): void {
  if (new Set(values).size !== values.length)
    throw new WorkflowError("invalid", `Duplicate ${description}.`);
}
export function validateAsk(value: unknown): AskRequest {
  const request = validate(AskSchema, value);
  if (JSON.stringify(request).length > 100000)
    throw new WorkflowError("invalid", "Question set is too large.");
  unique(
    request.questions.map((question) => question.id),
    "question IDs",
  );
  for (const question of request.questions) {
    unique(
      question.options.map((item) => item.value),
      "option values",
    );
    if (question.preview && question.options.some((item) => !item.preview))
      throw new WorkflowError("invalid", "Every preview option needs content.");
  }
  return request;
}
export function validateAnswer(request: AskRequest, value: unknown): AskResponse {
  const response = validate(AnswerSchema, value);
  unique(
    response.answers.map((answer) => answer.id),
    "answer IDs",
  );
  if (response.action === "cancel" && response.answers.length)
    throw new WorkflowError("invalid", "Cancellation cannot include answers.");
  for (const answer of response.answers) {
    const question = request.questions.find((item) => item.id === answer.id);
    if (!question) throw new WorkflowError("invalid", "Unknown question.");
    const values = new Set(question.options.map((item) => item.value));
    if (
      answer.selected.some((value) => !values.has(value)) ||
      answer.optionNotes.some((item) => !values.has(item.value))
    )
      throw new WorkflowError("invalid", "Unknown option.");
    unique(
      answer.optionNotes.map((item) => item.value),
      "option notes",
    );
    if (question.type === "single") {
      if (answer.selected.length > 1)
        throw new WorkflowError("invalid", "Select at most one option.");
      if (answer.text?.trim()) answer.selected = [];
    }
    if (response.action === "submit")
      answer.optionNotes = answer.optionNotes.filter((item) =>
        answer.selected.includes(item.value),
      );
  }
  return response;
}
export function answerText(request: AskRequest, response: AskResponse): string {
  if (response.action === "cancel")
    return "The user cancelled these questions. No answer was inferred.";
  const lines = request.questions.map((question) => {
    const answer = response.answers.find((item) => item.id === question.id);
    if (!answer) return `${question.prompt}\nUnanswered.`;
    const chosen = answer.selected.map(
      (value) => question.options.find((item) => item.value === value)!.label,
    );
    return [
      question.prompt,
      ...chosen,
      answer.text,
      answer.note && `Question note: ${answer.note}`,
      ...answer.optionNotes.map(
        (item) =>
          `Note on ${question.options.find((option) => option.value === item.value)!.label}: ${item.note}`,
      ),
      !chosen.length && !answer.text?.trim() ? "Unanswered." : undefined,
    ]
      .filter(Boolean)
      .join("\n");
  });
  return [
    response.action === "elaborate"
      ? "Explain the questions/options identified by the notes. Preserve the answers already provided; ask a new question set only where clarification is needed."
      : "User responses:",
    ...lines,
  ].join("\n\n");
}

const AskTool = defineTool({
  name: "ask_user",
  description:
    "Ask the user structured questions. Waits for explicit submit, elaboration, or cancellation. Partial answers are allowed.",
  parameters: AskSchema,
  structuredOutputSchema: AnswerSchema,
  replay: "safe",
  callers: ["model"],
  execute: async (args, api, callContext) => {
    const request = validateAsk(args);
    const key = String(api.taskId);
    await api.commit(async (tx) => {
      const state = await tx.doc(Workflows, api.conversationId);
      state.asks[key] ??= { request };
    }, callContext);
    const watch = await api.watchDoc(Workflows, api.conversationId, callContext);
    assert(watch);
    try {
      const answered = new Promise<AskResponse>((resolve) => {
        const receive = (state: Readonly<WorkflowState> | null) => {
          const response = state?.asks[key]?.response;
          if (response) resolve(response);
        };
        receive(watch.value);
        watch.start(async (state) => {
          receive(state);
        });
      });
      const response = await awaitWithContext(
        Promise.race([
          answered,
          watch.closed.then((end): never => {
            throw new Error(`Question watch ended: ${end.reason}`);
          }),
        ]),
        callContext,
      );
      return {
        output: [{ type: "text", text: answerText(request, response) }],
        structuredOutput: response,
      };
    } finally {
      await watch.stop();
    }
  },
});
export const AskExtension = defineExtension({ name: "ask", tools: [AskTool] });

export const ReportTool = defineTool({
  name: "submit_review",
  description:
    "Submit the final review, including every actionable finding and separate non-blocking human callouts, and finish this turn.",
  parameters: ReportSchema,
  replay: "safe",
  callers: ["model"],
  execute: async (args, api, callContext) => {
    const report = validate(ReportSchema, args);
    unique(
      report.findings.map((item) => item.id),
      "finding IDs",
    );
    if (report.findings.some((item) => item.endLine < item.startLine))
      throw new WorkflowError("invalid", "Invalid finding location.");
    await api.commit(async (tx) => {
      const state = await tx.doc(Workflows, api.conversationId);
      if (!state.review) throw new WorkflowError("conflict", "Not a review conversation.");
      state.review.report = report;
    }, callContext);
    return { output: [{ type: "text", text: reportText(report) }], control: { terminate: true } };
  },
});
export const ReviewExtension = defineExtension({
  name: "reviewer",
  tools: [ReportTool],
  sections: [
    section("review", async (input, callContext) => {
      const state = await input.read.snapshot(Workflows, input.conversationId, callContext);
      return state?.review?.instructions;
    }),
  ],
});

export async function answerQuestion(
  tx: Tx,
  conversationId: ConversationId,
  taskId: number,
  value: unknown,
): Promise<void> {
  if (!Number.isSafeInteger(taskId) || taskId < 0)
    throw new WorkflowError("invalid", "Invalid question identity.");
  const task = await tx.task(taskId as TaskId);
  if (!task || task.conversationId !== conversationId)
    throw new WorkflowError("not_found", "Question not found.");
  if (task.abortRequested || !["pending", "running", "waiting"].includes(task.state.status))
    throw new WorkflowError("conflict", "Question is no longer active.");
  const state = await tx.doc(Workflows, conversationId);
  const ask = state.asks[String(taskId)];
  if (!ask) throw new WorkflowError("not_found", "Question not found.");
  if (ask.response) throw new WorkflowError("conflict", "Question was already answered.");
  ask.response = validateAnswer(ask.request, value);
}

export function reportText(report: ReviewReport): string {
  return [
    report.scope,
    `Verdict: ${report.verdict}`,
    ...report.findings.map(
      (item) =>
        `[${item.priority}] ${item.title}\n${item.file}:${item.startLine}-${item.endLine}\n${item.explanation}${item.suggestion ? `\nSuggestion: ${item.suggestion}` : ""}`,
    ),
    report.findings.length ? "" : "No actionable findings.",
    "Human Reviewer Callouts (Non-Blocking)",
    ...report.callouts.map((item) => `**${item}**`),
    report.callouts.length ? "" : "- (none)",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Read-only setup operations; the reviewer itself retains normal tool capabilities. */
export async function prepareReview(
  env: ExecutionEnv,
  value: unknown,
): Promise<Omit<ReviewState, "origin" | "originEntry">> {
  const { target, instructions = "" } = validate(ReviewStartSchema, value);
  const git = async (...args: string[]): Promise<string> => {
    let stdout = "",
      stderr = "";
    const result = await env.exec(
      ["git", ...args],
      {
        cwd: env.cwd,
        timeout: 10,
        env: { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
        onOutput(chunk, _context, info) {
          if (info.stream === "stdout") stdout = (stdout + chunk).slice(0, 8192);
          else stderr = (stderr + chunk).slice(0, 8192);
        },
      },
      context,
    );
    if (!result.ok) throw new WorkflowError("unavailable", result.error.message);
    if (result.value.exitCode !== 0)
      throw new WorkflowError("invalid", `Git failed: ${stderr.trim() || args[0]}`);
    return stdout.trim();
  };
  const resolved: ReviewState["resolved"] = {};
  let scope: string;
  if (target.kind === "paths") {
    for (const path of target.paths) {
      if (
        Array.from(path).some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ) ||
        posix.isAbsolute(path) ||
        path.split("/").includes("..")
      )
        throw new WorkflowError("invalid", "Review paths must be workspace-relative without '..'.");
      const info = await env.fileInfo(posix.resolve(env.cwd, path), context);
      if (!info.ok)
        throw new WorkflowError(
          info.error.code === "not_found" ? "invalid" : "unavailable",
          info.error.message,
        );
    }
    scope = `Review the current contents of these paths as a snapshot, not a diff: ${JSON.stringify(target.paths)}. This is a live workspace, not an immutable snapshot.`;
  } else {
    await git("rev-parse", "--git-dir");
    if (target.kind === "uncommitted") {
      scope =
        "Review all staged, unstaged, and untracked changes in the current workspace. Inspect git status, both staged and unstaged diffs, and untracked files. The files remain live.";
    } else {
      const commit = await git(
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${target.ref}^{commit}`,
      );
      if (target.kind === "commit") {
        resolved.commit = commit;
        scope = `Review the changes introduced by commit ${commit}, including a root commit if applicable. Inspect its parents when needed. Do not switch the checkout.`;
      } else {
        resolved.head = await git("rev-parse", "--verify", "HEAD^{commit}");
        resolved.commit = commit;
        resolved.base = await git("merge-base", resolved.head, commit);
        scope = `Review changes between merge base ${resolved.base} and HEAD ${resolved.head} (requested base ${JSON.stringify(target.ref)}, resolved ${commit}). Do not switch the checkout.`;
      }
    }
  }
  let guidelines = "";
  for (let directory = env.cwd; ; directory = posix.dirname(directory)) {
    const pi = await env.openDirReader(posix.join(directory, ".pi"), context);
    if (!pi.ok && !["not_found", "not_directory"].includes(pi.error.code))
      throw new WorkflowError("unavailable", pi.error.message);
    if (pi.ok) {
      await pi.value.close(context);
      const reader = await env.openBinaryReader(
        posix.join(directory, "REVIEW_GUIDELINES.md"),
        undefined,
        context,
      );
      if (!reader.ok && reader.error.code !== "not_found")
        throw new WorkflowError("unavailable", reader.error.message);
      if (reader.ok) {
        try {
          const result = await reader.value.read(0, 100001, context);
          if (!result.ok) throw new WorkflowError("unavailable", result.error.message);
          if (result.value.length > 100000)
            throw new WorkflowError("invalid", "Review guidelines exceed 100 KB.");
          try {
            guidelines = new TextDecoder("utf-8", { fatal: true }).decode(result.value);
          } catch {
            throw new WorkflowError("invalid", "Review guidelines must be UTF-8.");
          }
        } finally {
          await reader.value.close(context);
        }
      }
      break;
    }
    if (posix.dirname(directory) === directory) break;
  }
  return {
    target,
    resolved,
    cwd: env.cwd,
    scope,
    instructions: [
      reviewInstructions,
      scope,
      "Use submit_review to deliver your final report and end the turn. Its structured fields transport the findings, verdict and callouts required above. Do not implement fixes.",
      instructions && `Additional user instructions:\n${instructions}`,
      guidelines && `Project review guidelines:\n${guidelines}`,
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}

export async function workflows(
  session: Session,
  conversation = session.root,
): Promise<WorkflowView> {
  const state = await session.harness.snapshot(Workflows, conversation.id, context);
  return {
    asks: await Promise.all(
      Object.entries(state?.asks ?? {}).map(async ([id, ask]) => {
        const task = ask.response
          ? undefined
          : await session.harness.getTask(Number(id) as TaskId, context);
        return {
          ...ask,
          id: Number(id),
          actionable:
            !ask.response &&
            !!task &&
            !task.abortRequested &&
            ["pending", "running", "waiting"].includes(task.state.status),
        };
      }),
    ),
    ...(state?.review ? { review: state.review } : {}),
  };
}

async function requireIdle(conversation: Conversation): Promise<void> {
  await conversation.commit(async (tx) => {
    const live = await tx.doc(LiveDoc, conversation.id);
    const inbox = await tx.doc(InboxDoc, conversation.id);
    if (live.run || inbox.items.length)
      throw new WorkflowError("conflict", "Conversation is busy.");
  }, context);
}

export async function answer(
  session: Session,
  taskId: number,
  response: unknown,
  conversation = session.root,
): Promise<void> {
  await conversation.commit((tx) => answerQuestion(tx, conversation.id, taskId, response), context);
}

export async function startReview(
  session: Session,
  input: unknown,
  conversation = session.root,
): Promise<Conversation> {
  await requireIdle(conversation);
  if ((await session.harness.snapshot(Workflows, conversation.id, context))?.review)
    throw new WorkflowError("conflict", "Nested reviews are not supported.");
  const agent = await conversation.agent(context);
  const prepared = await prepareReview(await environment(session, conversation), input);
  const history = await conversation.entries({}, 1, undefined, context);
  const destination = await session.harness.snapshot(Environment, conversation.id, context);
  const reviewer = await session.harness.createConversation(
    {
      ownership: { kind: "ownerless" },
      agent: {
        model: agent.model,
        thinkingLevel: agent.thinkingLevel,
        cwd: agent.cwd,
        extensions: [...agent.extensions, ReviewExtension],
        tools: [...new Set([...agent.tools, ...agent.callable, ...agent.deferred, ReportTool])],
        modelTools: [...agent.tools, ReportTool],
        instructions: agent.instructions,
      },
      init: async (tx, id) => {
        // Recheck admission atomically with creation, after asynchronous target resolution.
        const live = await tx.doc(LiveDoc, conversation.id);
        const inbox = await tx.doc(InboxDoc, conversation.id);
        if (live.run || inbox.items.length)
          throw new WorkflowError("conflict", "Conversation is busy.");
        Object.assign(await tx.doc(Environment, id), destination);
        const state = await tx.doc(Workflows, id);
        state.review = {
          ...prepared,
          origin: conversation.id,
          ...(history.items.length ? { originEntry: history.items[0].id } : {}),
        };
      },
    },
    context,
  );
  await reviewer.submit({ type: "input", content: prepared.scope, whenBusy: "reject" }, context);
  return reviewer;
}

export async function finishReview(
  session: Session,
  input: unknown,
  conversation = session.root,
): Promise<Conversation> {
  const command = validate(ReviewFinishSchema, input);
  const review = (await session.harness.snapshot(Workflows, conversation.id, context))?.review;
  if (!review) throw new WorkflowError("conflict", "Not a review conversation.");
  const origin = await getConversation(session, review.origin);
  if (command.action === "return") return origin;
  await requireIdle(origin);
  if (!review.report) throw new WorkflowError("conflict", "No review report has been submitted.");
  const selected = review.report.findings.filter((item) => command.findings.includes(item.id));
  if (selected.length !== command.findings.length || (command.action === "fix" && !selected.length))
    throw new WorkflowError("invalid", "Select existing findings to fix.");
  const report =
    command.action === "fix" ? { ...review.report, findings: selected } : review.report;
  const text = `Workspace: ${review.cwd}\nTarget: ${JSON.stringify(review.target)}\nResolved revisions: ${JSON.stringify(review.resolved)}\n\n${reportText(report)}`;
  if (command.action === "fix" && (await origin.agent(context)).cwd !== review.cwd)
    throw new WorkflowError(
      "conflict",
      "Origin directory changed. Restore it or start a new review before fixing.",
    );
  if (command.action === "handoff") {
    await origin.submit(
      {
        type: "write",
        requestId: command.requestId,
        entry: {
          kind: "app.review",
          data: { reviewer: conversation.id, report },
          model: [
            {
              role: "user",
              content: `Review handoff (informational; no fix run requested):\n\n${text}`,
              timestamp: Date.now(),
            },
          ],
        },
      },
      context,
    );
  } else {
    await origin.submit(
      {
        type: "input",
        requestId: command.requestId,
        whenBusy: "reject",
        entry: { kind: "app.review-fix", data: { reviewer: conversation.id, report } },
        content: `Implement and verify only the selected findings below. Human callouts are informational, not fix tasks. Do not start an automatic re-review loop. Review cwd: ${review.cwd}\n\n${text}`,
      },
      context,
    );
  }
  return origin;
}
