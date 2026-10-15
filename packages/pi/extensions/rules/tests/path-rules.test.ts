import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import ext from "../index.ts";

type Message = {
  role: string;
  content?: unknown;
  customType?: string;
  display?: boolean;
};
type Handler = (event: unknown, context: TestContext) => unknown;
type Notice = { message: string; level: string };
type TestContext = {
  cwd: string;
  sessionManager: SessionManager;
  ui: {
    notify(message: string, level: string): void;
  };
};
type ContextResult = { messages?: Message[] };
type ToolCallResult = { block?: boolean; reason?: string };

function createHarness(ruleFiles?: Record<string, string>, cwd = ".") {
  const root = mkdtempSync(join(tmpdir(), "pi-rules-"));
  const workingDirectory = join(root, cwd);
  mkdirSync(workingDirectory, { recursive: true });

  if (ruleFiles) {
    for (const [name, content] of Object.entries(ruleFiles)) {
      const filename = join(root, ".agents", "rules", name);
      mkdirSync(dirname(filename), { recursive: true });
      writeFileSync(filename, content);
    }
  }

  const sessionManager = SessionManager.inMemory(workingDirectory);
  const rootId = sessionManager.appendMessage({ role: "user", content: "Start", timestamp: 0 });
  const handlers = new Map<string, Handler>();
  const notices: Notice[] = [];
  const pi = {
    on(name: string, handler: Handler): void {
      handlers.set(name, handler);
    },
    appendEntry(customType: string, data: unknown): void {
      sessionManager.appendCustomEntry(customType, data);
    },
  };
  const context: TestContext = {
    cwd: workingDirectory,
    sessionManager,
    ui: {
      notify(message, level) {
        notices.push({ message, level });
      },
    },
  };

  function emit(name: string, event: unknown): unknown {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`Extension did not register ${name}`);
    return handler(event, context);
  }

  function reload(reason = "reload"): void {
    handlers.clear();
    ext(pi as unknown as Parameters<typeof ext>[0]);
    emit("session_start", { type: "session_start", reason });
  }
  reload("startup");

  let nextCallId = 0;
  return {
    emit,
    reload,
    notices,
    root,
    rootId,
    sessionManager,
    call(toolName: string, path: string, parentToolCallId?: string) {
      return emit("tool_call", {
        type: "tool_call",
        toolCallId: `${parentToolCallId ?? "direct"}/${nextCallId++}`,
        parentToolCallId,
        toolName,
        input: { path },
      }) as ToolCallResult | undefined;
    },
    navigate(entryId: string): void {
      const oldLeafId = sessionManager.getLeafId();
      sessionManager.branch(entryId);
      emit("session_tree", { type: "session_tree", oldLeafId, newLeafId: entryId });
    },
    cleanup(this: void) {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function contextResult(
  harness: ReturnType<typeof createHarness>,
  messages: Message[] = harness.sessionManager.buildSessionContext().messages,
) {
  return harness.emit("context", { type: "context", messages }) as ContextResult | undefined;
}

function injectedRules(result: ContextResult | undefined): Message {
  const messages = result?.messages?.filter(
    (candidate) => candidate.role === "custom" && candidate.customType === "rules",
  );
  assert.equal(messages?.length, 1);
  const message = messages![0];
  assert.equal(message.display, false);
  assert.equal(typeof message.content, "string");
  return message;
}

function activations(harness: ReturnType<typeof createHarness>) {
  return harness.sessionManager
    .getBranch()
    .flatMap((entry) =>
      entry.type === "custom" && entry.customType === "path-rules-activation" ? [entry.data] : [],
    );
}

const scopedRule = (pattern: string, body = "Scoped rule") => `---
paths: "${pattern}"
---
${body}
`;

void describe("path rules extension", async () => {
  await test("loads global and scoped rules recursively and skips invalid rules", (t) => {
    const harness = createHarness({
      "00-global.md": "Global rule\n",
      "10-invalid.md": scopedRule("[z-a].ts"),
      "nested/20-source.md": scopedRule("src/**/*.{ts,tsx}"),
      "nested/ignored.txt": "Not a rule",
    });
    t.after(harness.cleanup);

    assert.deepEqual(
      harness.notices.map((notice) => notice.level),
      ["info", "warning"],
    );
    injectedRules(contextResult(harness));
    assert.deepEqual(activations(harness), []);
    assert.equal(harness.call("edit", "unscoped.txt"), undefined);

    for (const filename of ["src/main.ts", "src/nested/main.tsx"]) {
      assert.equal(harness.call("edit", filename)?.block, true);
    }
    assert.deepEqual(activations(harness), [
      { root: harness.root, ruleIds: [".agents/rules/nested/20-source.md"] },
    ]);
    injectedRules(contextResult(harness));
    assert.equal(harness.call("edit", "src/main.ts"), undefined);
  });

  await test("resolves tool paths relative to cwd within the rules workspace", (t) => {
    const harness = createHarness(
      { "source.md": scopedRule("packages/app/src/**") },
      "packages/app",
    );
    t.after(harness.cleanup);
    assert.equal(harness.call("read", "src/main.ts"), undefined);
    assert.deepEqual(activations(harness), [
      { root: harness.root, ruleIds: [".agents/rules/source.md"] },
    ]);
    injectedRules(contextResult(harness));
    assert.equal(harness.call("write", "src/new.ts"), undefined);
    assert.equal(harness.call("edit", join(harness.root, "packages/app/src/main.ts")), undefined);
  });

  await test("direct and nested mutations block until the next model context", async (t) => {
    for (const parent of [undefined, "codemode"]) {
      await t.test(parent ?? "direct", (t) => {
        const harness = createHarness({ "docs.md": scopedRule("**/*.md") });
        t.after(harness.cleanup);
        assert.equal(contextResult(harness), undefined);

        assert.equal(harness.call("edit", "README.md", parent)?.block, true);
        assert.equal(harness.call("write", "other.md", parent)?.block, true);
        assert.equal(activations(harness).length, 1);
        // No transcript tool call or nestedCalls metadata is needed to activate the rule.
        injectedRules(contextResult(harness));
        assert.equal(harness.call("edit", "README.md", parent), undefined);
        assert.equal(harness.call("write", "other.md", parent), undefined);
        assert.equal(activations(harness).length, 1);
      });
    }
  });

  await test("reads activate rules but cannot unlock edits in the same script", (t) => {
    const harness = createHarness({
      "docs.md": scopedRule("**/*.md"),
      "source.md": scopedRule("src/**"),
    });
    t.after(harness.cleanup);
    contextResult(harness);

    assert.equal(harness.call("read", "README.md", "codemode"), undefined);
    assert.equal(harness.call("edit", "README.md", "codemode")?.block, true);
    assert.equal(harness.call("read", ".agents/rules/docs.md", "codemode"), undefined);
    assert.equal(harness.call("edit", "README.md", "codemode")?.block, true);
    injectedRules(contextResult(harness));
    assert.equal(harness.call("edit", "README.md", "codemode"), undefined);
    assert.equal(harness.call("edit", "src/new.ts", "codemode")?.block, true);
    injectedRules(contextResult(harness));
    assert.equal(harness.call("edit", "src/new.ts", "codemode"), undefined);
  });

  await test("parallel mutations cannot unlock each other and persist each rule once", async (t) => {
    const harness = createHarness({
      "source.md": scopedRule("src/**"),
      "typescript.md": scopedRule("**/*.ts"),
    });
    t.after(harness.cleanup);
    contextResult(harness);

    const results = await Promise.all(
      ["src/a.ts", "src/b.ts", "src/c.ts"].map(async (filename) =>
        harness.call("edit", filename, "codemode"),
      ),
    );
    assert.deepEqual(
      results.map((result) => result?.block),
      [true, true, true],
    );
    assert.deepEqual(activations(harness), [
      { root: harness.root, ruleIds: [".agents/rules/source.md", ".agents/rules/typescript.md"] },
    ]);
    injectedRules(contextResult(harness));
    assert.equal(harness.call("edit", "src/a.ts"), undefined);
  });

  await test("ignores tools other than read, edit, and write", (t) => {
    const harness = createHarness({ "docs.md": scopedRule("**/*.md") });
    t.after(harness.cleanup);
    writeFileSync(join(harness.root, "README.md"), "");
    for (const parent of [undefined, "codemode"]) {
      for (const tool of ["grep", "find", "ls", "bash", "custom"]) {
        assert.equal(harness.call(tool, "README.md", parent), undefined);
      }
    }
    assert.deepEqual(activations(harness), []);
    assert.equal(contextResult(harness), undefined);
    assert.equal(harness.call("edit", "README.md")?.block, true);
  });

  await test("ignores outside paths and does not discover paths in arbitrary tool text", (t) => {
    const harness = createHarness({ "source.md": scopedRule("**") });
    t.after(harness.cleanup);

    for (const filename of ["../outside.ts", join(harness.root, "..", "outside.ts"), "."]) {
      assert.equal(harness.call("write", filename), undefined);
    }
    assert.equal(
      contextResult(harness, [
        { role: "user", content: '@src/main.ts <file name="src/main.ts">' },
        { role: "toolResult", content: [{ type: "text", text: "@src/main.ts" }] },
        { role: "custom", customType: "other", content: "@src/main.ts" },
      ]),
      undefined,
    );
    assert.deepEqual(activations(harness), []);
    assert.equal(contextResult(harness), undefined);
  });

  await test("replaces stale injected messages without activating paths mentioned in them", (t) => {
    const harness = createHarness({ "docs.md": scopedRule("**/*.md") });
    t.after(harness.cleanup);
    const stale = { role: "custom", customType: "rules", content: "@README.md" };
    const unrelated = { role: "custom", customType: "other", content: "keep" };
    const user = { role: "user", content: "hello" };

    assert.deepEqual(contextResult(harness, [stale, unrelated, user])?.messages, [unrelated, user]);
    assert.equal(contextResult(harness, [unrelated, user]), undefined);
    harness.call("read", "README.md");
    const result = contextResult(harness, [stale, unrelated, user]);
    injectedRules(result);
    assert.equal(result?.messages?.length, 3);
    assert.deepEqual(result?.messages?.slice(0, 2), [unrelated, user]);
  });

  await test("activation survives context changes, compaction, and a fresh extension runtime", (t) => {
    const harness = createHarness({ "docs.md": scopedRule("**/*.md") });
    t.after(harness.cleanup);
    harness.call("read", "README.md");
    injectedRules(contextResult(harness));
    injectedRules(contextResult(harness, [{ role: "user", content: "Unrelated follow-up" }]));

    const firstKeptEntryId = harness.sessionManager.appendMessage({
      role: "user",
      content: "Continue",
      timestamp: 1,
    });
    harness.sessionManager.appendCompaction("Summary", firstKeptEntryId, 100);
    harness.emit("session_compact", { type: "session_compact" });
    // Compaction removes the activation entry from model context, but not the branch.
    assert.equal(
      harness.sessionManager.buildContextEntries().some((entry) => entry.type === "custom"),
      false,
    );
    assert.equal(activations(harness).length, 1);
    assert.equal(harness.call("edit", "README.md")?.block, true);
    injectedRules(contextResult(harness));
    assert.equal(harness.call("edit", "README.md"), undefined);

    for (const reason of ["reload", "resume", "fork"]) {
      harness.reload(reason);
      assert.equal(harness.call("edit", "README.md")?.block, true);
      injectedRules(contextResult(harness));
      assert.equal(harness.call("edit", "README.md"), undefined);
      assert.equal(activations(harness).length, 1);
    }
  });

  await test("tree navigation restores only activations on the selected branch", (t) => {
    const harness = createHarness({
      "docs.md": scopedRule("docs/**"),
      "source.md": scopedRule("src/**"),
    });
    t.after(harness.cleanup);
    harness.call("read", "src/main.ts");
    const sourceLeaf = harness.sessionManager.getLeafId()!;
    injectedRules(contextResult(harness));

    harness.navigate(harness.rootId);
    assert.equal(contextResult(harness), undefined);
    harness.call("read", "docs/readme.md");
    const docsLeaf = harness.sessionManager.getLeafId()!;
    injectedRules(contextResult(harness));
    assert.equal(harness.call("edit", "docs/readme.md"), undefined);
    assert.equal(harness.call("edit", "src/main.ts")?.block, true);

    harness.navigate(sourceLeaf);
    assert.equal(activations(harness).length, 1);
    assert.equal(harness.call("edit", "src/main.ts")?.block, true);
    injectedRules(contextResult(harness));
    assert.equal(harness.call("edit", "src/main.ts"), undefined);
    assert.equal(harness.call("edit", "docs/readme.md")?.block, true);

    harness.navigate(docsLeaf);
    harness.reload("fork");
    assert.equal(activations(harness).length, 1);
    injectedRules(contextResult(harness));
    assert.equal(harness.call("edit", "docs/readme.md"), undefined);
    assert.equal(harness.call("edit", "src/main.ts")?.block, true);

    harness.sessionManager.resetLeaf();
    harness.reload("new");
    assert.equal(contextResult(harness), undefined);
    assert.deepEqual(activations(harness), []);
  });

  await test("restoration ignores activations from other workspaces", (t) => {
    const harness = createHarness({ "docs.md": scopedRule("**/*.md") });
    t.after(harness.cleanup);
    harness.sessionManager.appendCustomEntry("path-rules-activation", {
      root: join(harness.root, "other"),
      ruleIds: [".agents/rules/docs.md"],
    });
    harness.reload();
    assert.equal(contextResult(harness), undefined);
    assert.equal(harness.call("edit", "README.md")?.block, true);
  });

  await test("is inert without a rules workspace", (t) => {
    const harness = createHarness();
    t.after(harness.cleanup);
    assert.deepEqual(harness.notices, []);
    harness.call("read", "README.md", "codemode");
    assert.equal(harness.call("edit", "README.md", "codemode"), undefined);
    assert.equal(contextResult(harness), undefined);
    assert.deepEqual(activations(harness), []);
  });
});
