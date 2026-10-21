import * as workflow from "./workflows.ts";
import * as runtime from "./index.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { readHistory, fixture, waitFor, code } from "./testing.ts";
import {
  validateAsk,
  validateAnswer,
  prepareReview,
  WorkflowError,
  Workflows,
  type AskRequest,
  type AskResponse,
  type ReviewReport,
} from "./workflows.ts";

const context = BACKGROUND_CONTEXT;
const request: AskRequest = {
  title: "Choose an approach",
  questions: [
    {
      id: "design",
      prompt: "How should we store preferences?",
      type: "single",
      preview: true,
      options: [
        {
          value: "sqlite",
          label: "SQLite",
          preview: "CREATE TABLE preferences (…)",
          recommended: true,
        },
        { value: "json", label: "JSON", preview: '{"theme":"dark"}' },
      ],
    },
    {
      id: "checks",
      prompt: "Which checks matter?",
      type: "multiple",
      options: [
        { value: "unit", label: "Unit tests" },
        { value: "browser", label: "Browser tests" },
      ],
    },
  ],
};
const answer: AskResponse = {
  action: "submit",
  answers: [{ id: "design", selected: ["sqlite"], optionNotes: [] }],
};
const report: ReviewReport = {
  scope: "Preferences",
  verdict: "needs attention",
  callouts: ["Schema changes need human review."],
  findings: [
    {
      id: "race",
      priority: "P1",
      title: "Serialize preference updates",
      file: "preferences.ts",
      startLine: 4,
      endLine: 6,
      explanation: "Concurrent read-modify-write operations lose updates.",
    },
    {
      id: "empty",
      priority: "P2",
      title: "Handle an empty database",
      file: "preferences.ts",
      startLine: 8,
      endLine: 8,
      explanation: "The initial query can return no row.",
    },
  ],
};
function workflowCode(code: WorkflowError["code"]) {
  return (error: unknown) => error instanceof WorkflowError && error.code === code;
}

await test("ask validates bounded schemas, identities, previews and answer semantics", () => {
  assert.deepEqual(validateAsk(request), request);
  for (const invalid of [
    {},
    { questions: [] },
    { ...request, extra: true },
    { questions: [request.questions[0], request.questions[0]] },
    {
      questions: [
        {
          ...request.questions[0],
          options: [request.questions[0].options[0], request.questions[0].options[0]],
        },
      ],
    },
    { questions: [{ ...request.questions[0], options: [{ value: "a", label: "A" }] }] },
    { title: " ", questions: request.questions },
  ])
    assert.throws(() => validateAsk(invalid), workflowCode("invalid"));
  assert.deepEqual(validateAnswer(request, answer), answer);
  assert.deepEqual(validateAnswer(request, { action: "submit", answers: [] }), {
    action: "submit",
    answers: [],
  });
  for (const invalid of [
    { ...answer, answers: [{ ...answer.answers[0], id: "missing" }] },
    { ...answer, answers: [{ ...answer.answers[0], selected: ["missing"] }] },
    { ...answer, answers: [{ ...answer.answers[0], selected: ["sqlite", "json"] }] },
    { ...answer, answers: [answer.answers[0], answer.answers[0]] },
    { ...answer, action: "cancel" },
    { ...answer, answers: [{ ...answer.answers[0], text: "x".repeat(10001) }] },
  ])
    assert.throws(() => validateAnswer(request, invalid), workflowCode("invalid"));
  const custom = validateAnswer(request, {
    action: "submit",
    answers: [
      {
        ...answer.answers[0],
        text: "Use TOML",
        optionNotes: [{ value: "sqlite", note: "Not selected" }],
      },
      { id: "checks", selected: ["unit"], text: "Also run lint", optionNotes: [] },
    ],
  });
  assert.deepEqual(
    custom.answers.map((item) => item.selected),
    [[], ["unit"]],
  );
  assert.deepEqual(custom.answers[0].optionNotes, []);
  const elaboration = validateAnswer(request, {
    action: "elaborate",
    answers: [{ ...answer.answers[0], optionNotes: [{ value: "json", note: "Why not this?" }] }],
  });
  assert.deepEqual(elaboration.answers[0].optionNotes, [{ value: "json", note: "Why not this?" }]);
});

for (const action of ["submit", "cancel", "elaborate"] as const) {
  await test(`ask ${action} completes the original tool and rejects later responses`, async (t) => {
    const f = await fixture(t);
    const session = await f.create();
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("ask_user", request), { stopReason: "toolUse" }),
      fauxAssistantMessage("Acknowledged."),
    ]);
    await session.root.submit(
      { type: "input", content: "Ask about preferences.", requestId: randomUUID() },
      context,
    );
    await waitFor(async () =>
      (await workflow.workflows(session)).asks.some((item) => item.actionable),
    );
    const ask = (await workflow.workflows(session)).asks[0];
    const response = { ...answer, action, ...(action === "cancel" ? { answers: [] } : {}) };
    await workflow.answer(session, ask.id, response);
    await session.root.waitForIdle(context);
    const saved = (await workflow.workflows(session)).asks[0];
    assert.deepEqual(saved.response, response);
    assert.equal(saved.actionable, false);
    const results = (await readHistory(session.root))
      .flatMap((entry) => entry.model ?? [])
      .filter((message) => message.role === "toolResult");
    assert.equal(results.length, 1);
    assert.equal(results[0].isError, false);
    await assert.rejects(workflow.answer(session, ask.id, answer), workflowCode("conflict"));
    assert.equal(f.faux.state.callCount, 2);
  });
}

await test("ask recovers the original request after restart without admitting a new user message", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("ask_user", request), { stopReason: "toolUse" }),
  ]);
  await session.root.submit({ type: "input", content: "Ask.", requestId: randomUUID() }, context);
  await waitFor(async () => (await workflow.workflows(session)).asks.length === 1);
  const original = (await workflow.workflows(session)).asks[0];
  await f.reopen();
  const restored = await f.sessions.get(session.id);
  assert.equal((await runtime.sessionInfo(restored)).needsResume, true);
  assert.equal((await workflow.workflows(restored)).asks[0].id, original.id);
  assert.equal((await restored.harness.inspect(context)).scheduling, "paused");
  await workflow.answer(restored, original.id, answer);
  assert.deepEqual((await workflow.workflows(restored)).asks[0].response, answer);
  f.faux.setResponses([fauxAssistantMessage("Thanks.")]);
  restored.harness.resume();
  await restored.root.waitForIdle(context);
  assert.equal((await workflow.workflows(restored)).asks.length, 1);
  const messages = (await readHistory(restored.root)).flatMap((entry) => entry.model ?? []);
  assert.equal(messages.filter((message) => message.role === "user").length, 1);
  assert.equal(messages.filter((message) => message.role === "toolResult").length, 1);
});

await test("ask ownership, concurrent responses, fork isolation and stop use existing task state", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("ask_user", request), { stopReason: "toolUse" }),
    fauxAssistantMessage("Done."),
  ]);
  await session.root.submit({ type: "input", content: "Ask.", requestId: randomUUID() }, context);
  await waitFor(async () => (await workflow.workflows(session)).asks.length === 1);
  const ask = (await workflow.workflows(session)).asks[0];
  const entry = (await readHistory(session.root))[0];
  const fork = await session.root.fork(entry.id, { ownership: { kind: "ownerless" } }, context);
  assert.deepEqual((await workflow.workflows(session, fork)).asks, []);
  await assert.rejects(workflow.answer(session, ask.id, answer, fork), workflowCode("not_found"));
  const results = await Promise.allSettled([
    workflow.answer(session, ask.id, answer),
    workflow.answer(session, ask.id, answer),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  await session.root.waitForIdle(context);
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("ask_user", request), { stopReason: "toolUse" }),
  ]);
  await session.root.submit(
    { type: "input", content: "Ask again.", requestId: randomUUID() },
    context,
  );
  await waitFor(async () =>
    (await workflow.workflows(session)).asks.some((item) => item.actionable),
  );
  const pending = (await workflow.workflows(session)).asks.find((item) => item.actionable)!;
  await session.root.abort(context);
  assert.equal(
    (await workflow.workflows(session)).asks.find((item) => item.id === pending.id)?.actionable,
    false,
  );
  await assert.rejects(workflow.answer(session, pending.id, answer), workflowCode("conflict"));
});

await test("review targets resolve Git identities and paths without changing the checkout", async (t) => {
  const f = await fixture(t);
  const git = (...args: string[]) => promisify(execFile)("git", args, { cwd: f.workspace });
  await git("init", "-b", "main");
  await git("config", "user.name", "Test");
  await git("config", "user.email", "test@example.test");
  await writeFile(join(f.workspace, "preferences.ts"), "export const value = 1;\n");
  await git("add", ".");
  await git("commit", "--no-gpg-sign", "-m", "Initial");
  const root = (await git("rev-parse", "HEAD")).stdout.trim();
  await git("branch", "base");
  await writeFile(join(f.workspace, "preferences.ts"), "export const value = 2;\n");
  await git("commit", "--no-gpg-sign", "-am", "Update");
  const head = (await git("rev-parse", "HEAD")).stdout.trim();
  const env = new NodeExecutionEnv({ cwd: f.workspace });
  t.after(() => env.cleanup(context));
  const branch = await prepareReview(env, { target: { kind: "branch", ref: "base" } });
  assert.deepEqual(branch.resolved, { head, commit: root, base: root });
  assert.deepEqual((await prepareReview(env, { target: { kind: "commit", ref: root } })).resolved, {
    commit: root,
  });
  assert.equal(
    (await prepareReview(env, { target: { kind: "uncommitted" } })).target.kind,
    "uncommitted",
  );
  assert.equal(
    (await prepareReview(env, { target: { kind: "paths", paths: ["preferences.ts"] } })).target
      .kind,
    "paths",
  );
  for (const target of [
    { kind: "branch", ref: "--help" },
    { kind: "commit", ref: "missing" },
    { kind: "paths", paths: ["../outside"] },
    { kind: "paths", paths: ["missing"] },
  ])
    await assert.rejects(prepareReview(env, { target }), workflowCode("invalid"));
  assert.equal((await git("rev-parse", "HEAD")).stdout.trim(), head);
  await mkdir(join(f.workspace, ".pi"));
  await mkdir(join(f.workspace, "REVIEW_GUIDELINES.md"));
  await assert.rejects(
    prepareReview(env, { target: { kind: "uncommitted" } }),
    workflowCode("unavailable"),
  );
  await rm(join(f.workspace, "REVIEW_GUIDELINES.md"), { recursive: true });
  await writeFile(join(f.workspace, "REVIEW_GUIDELINES.md"), new Uint8Array([0xff]));
  await assert.rejects(
    prepareReview(env, { target: { kind: "uncommitted" } }),
    workflowCode("invalid"),
  );
  await writeFile(join(f.workspace, "REVIEW_GUIDELINES.md"), "x".repeat(100001));
  await assert.rejects(
    prepareReview(env, { target: { kind: "uncommitted" } }),
    workflowCode("invalid"),
  );
});

await test("review has fresh context and normal tools; report, passive handoff and selected fixes persist", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.workspace, "preferences.ts"), "export const value = 1;\n");
  const session = await f.create();
  f.faux.setResponses([fauxAssistantMessage("Private coding history.")]);
  await session.root.submit(
    {
      type: "input",
      content: "Coding history should not reach the reviewer.",
      requestId: randomUUID(),
    },
    context,
  );
  await session.root.waitForIdle(context);
  const agent = await session.root.agent(context);
  assert.equal(
    agent.tools.some((tool) => tool.name === "submit_review"),
    false,
  );
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("submit_review", report), { stopReason: "toolUse" }),
  ]);
  const reviewer = await workflow.startReview(session, {
    target: { kind: "paths", paths: ["preferences.ts"] },
  });
  await reviewer.waitForIdle(context);
  const reviewerAgent = await reviewer.agent(context);
  assert.equal(reviewerAgent.cwd, agent.cwd);
  assert.deepEqual(reviewerAgent.model, agent.model);
  assert.equal(reviewerAgent.thinkingLevel, agent.thinkingLevel);
  for (const tool of [...agent.tools, ...agent.callable])
    assert(
      [...reviewerAgent.tools, ...reviewerAgent.callable].some(
        (candidate) => candidate.name === tool.name,
      ),
    );
  assert(reviewerAgent.tools.some((tool) => tool.name === "submit_review"));
  const reviewMessages = (await readHistory(reviewer)).flatMap((entry) => entry.model ?? []);
  assert.equal(reviewMessages.filter((message) => message.role === "user").length, 1);
  const saved = (await workflow.workflows(session, reviewer)).review!;
  assert.equal(saved.origin, session.root.id);
  assert.deepEqual(saved.report, report);
  await assert.rejects(
    workflow.startReview(
      session,
      { target: { kind: "paths", paths: ["preferences.ts"] } },
      reviewer,
    ),
    workflowCode("conflict"),
  );
  await assert.rejects(
    workflow.finishReview(
      session,
      { action: "fix", findings: [], requestId: randomUUID() },
      reviewer,
    ),
    workflowCode("invalid"),
  );
  await assert.rejects(
    workflow.finishReview(
      session,
      { action: "fix", findings: ["unknown"], requestId: randomUUID() },
      reviewer,
    ),
    workflowCode("invalid"),
  );
  await session.root.configure({ cwd: join(f.workspace, "other") }, context);
  await assert.rejects(
    workflow.finishReview(
      session,
      { action: "fix", findings: ["race"], requestId: randomUUID() },
      reviewer,
    ),
    workflowCode("conflict"),
  );
  await session.root.configure({ cwd: f.workspace }, context);
  const calls = f.faux.state.callCount;
  const returned = await workflow.finishReview(
    session,
    { action: "return", findings: [], requestId: randomUUID() },
    reviewer,
  );
  assert.equal(returned.id, session.root.id);
  const requestId = randomUUID();
  await workflow.finishReview(session, { action: "handoff", findings: [], requestId }, reviewer);
  await workflow.finishReview(session, { action: "handoff", findings: [], requestId }, reviewer);
  assert.equal(f.faux.state.callCount, calls);
  const handoffs = (await readHistory(session.root)).filter((entry) => entry.kind === "app.review");
  assert.equal(handoffs.length, 1);
  assert.deepEqual(handoffs[0].data, { reviewer: reviewer.id, report });
  f.faux.setResponses([fauxAssistantMessage("Fixed the selected issue.")]);
  await workflow.finishReview(
    session,
    { action: "fix", findings: ["race"], requestId: randomUUID() },
    reviewer,
  );
  await session.root.waitForIdle(context);
  assert.equal(f.faux.state.callCount, calls + 1);
  const fixes = (await readHistory(session.root)).filter(
    (entry) => entry.kind === "app.review-fix",
  );
  assert.equal(fixes.length, 1);
  assert.deepEqual(fixes[0].data, {
    reviewer: reviewer.id,
    report: { ...report, findings: [report.findings[0]] },
  });
  await f.reopen();
  const restored = await f.sessions.get(session.id);
  assert.deepEqual(
    (await workflow.workflows(restored, await runtime.getConversation(restored, reviewer.id)))
      .review,
    saved,
  );
});

await test("empty review reports finish successfully and missing targets never fall back to local execution", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.workspace, "preferences.ts"), "export {};\n");
  const session = await f.create();
  const empty = { ...report, verdict: "correct", findings: [], callouts: [] };
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("submit_review", empty), { stopReason: "toolUse" }),
  ]);
  const reviewer = await workflow.startReview(session, {
    target: { kind: "paths", paths: ["preferences.ts"] },
  });
  await reviewer.waitForIdle(context);
  assert.deepEqual(
    (await session.harness.snapshot(Workflows, reviewer.id, context))?.review?.report,
    empty,
  );
  await f.reopen({ env: undefined, targets: async () => [] });
  const restored = await f.sessions.get(session.id);
  await assert.rejects(
    workflow.startReview(restored, { target: { kind: "paths", paths: ["preferences.ts"] } }),
    code("unavailable"),
  );
});
