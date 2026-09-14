import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";

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

  const handlers = new Map<string, Handler>();
  const notices: Notice[] = [];
  const pi = {
    on(name: string, handler: Handler): void {
      handlers.set(name, handler);
    },
  };
  ext(pi as unknown as Parameters<typeof ext>[0]);

  const context: TestContext = {
    cwd: workingDirectory,
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

  emit("session_start", { type: "session_start", reason: "startup" });

  return {
    emit,
    notices,
    root,
    cleanup(this: void) {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function contextResult(harness: ReturnType<typeof createHarness>, messages: Message[]) {
  return harness.emit("context", { type: "context", messages }) as ContextResult | undefined;
}

function injectedRuleContent(result: ContextResult | undefined): string {
  const message = result?.messages?.find(
    (candidate) => candidate.role === "custom" && candidate.customType === "rules",
  );
  assert.ok(message, "expected an injected rules message");
  assert.equal(message.display, false);
  assert.ok(typeof message.content === "string");
  return message.content;
}

const scopedRule = (pattern: string, body = "Scoped rule") => `---
paths: "${pattern}"
---
${body}
`;

void describe("path rules extension", async () => {
  await test("loads global and scoped rules recursively and reports invalid rules", (t) => {
    const harness = createHarness({
      "00-global.md": "Global rule\n",
      "10-invalid.md": scopedRule("[z-a].ts", "Invalid rule"),
      "nested/20-source.md": scopedRule("src/**/*.{ts,tsx}", "Source rule"),
      "nested/ignored.txt": "Not a rule",
    });
    t.after(harness.cleanup);

    assert.deepEqual(harness.notices, [
      {
        message: "Loaded 2 rules from .agents/rules (1 global, 1 scoped)",
        level: "info",
      },
      {
        message:
          "Skipped 1 rule(s):\n.agents/rules/10-invalid.md: paths must contain at least one valid glob",
        level: "warning",
      },
    ]);

    const globalOnly = injectedRuleContent(
      contextResult(harness, [{ role: "user", content: "No files in context" }]),
    );
    assert.match(globalOnly, /source="\.agents\/rules\/00-global\.md"/);
    assert.doesNotMatch(globalOnly, /20-source/);

    const withSource = injectedRuleContent(
      contextResult(harness, [{ role: "user", content: "Review @src/nested/main.ts" }]),
    );
    const globalIndex = withSource.indexOf("00-global.md");
    const scopedIndex = withSource.indexOf("20-source.md");
    assert.ok(globalIndex >= 0);
    assert.ok(scopedIndex > globalIndex);
    assert.match(withSource, /paths="src\/\*\*\/\*\.\{ts,tsx\}"/);
    assert.match(withSource, /Source rule/);
  });

  await test("finds paths in prompts, messages, tool calls, and grep results", async (t) => {
    const cases: Array<{
      name: string;
      prepare?: (harness: ReturnType<typeof createHarness>) => void;
      messages: Message[];
    }> = [
      {
        name: "prompt references",
        prepare(harness) {
          harness.emit("before_agent_start", {
            type: "before_agent_start",
            prompt: "Inspect @src/prompt.ts",
          });
        },
        messages: [{ role: "user", content: "Inspect it" }],
      },
      {
        name: "user file references",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: '<file name="src/file.ts">' },
              { type: "text", text: 'Compare with @"src/other file.ts"' },
            ],
          },
        ],
      },
      {
        name: "path tool calls",
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "read-1",
                name: "read",
                arguments: { path: "src/read.ts" },
              },
            ],
          },
        ],
      },
      {
        name: "grep results",
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "grep-1",
                name: "grep",
                arguments: { path: "src" },
              },
            ],
          },
          {
            role: "toolResult",
            toolName: "grep",
            toolCallId: "grep-1",
            content: [{ type: "text", text: "nested/result.ts:12:match" }],
          } as Message,
        ],
      },
    ];

    for (const testCase of cases) {
      await t.test(testCase.name, (t) => {
        const harness = createHarness(
          { "source.md": scopedRule("packages/app/src/**") },
          "packages/app",
        );
        t.after(harness.cleanup);
        testCase.prepare?.(harness);

        const content = injectedRuleContent(contextResult(harness, testCase.messages));
        assert.match(content, /source="\.agents\/rules\/source\.md"/);
      });
    }
  });

  await test("replaces stale injected messages", (t) => {
    const harness = createHarness();
    t.after(harness.cleanup);
    const stale = { role: "custom", customType: "rules", content: "stale" };
    const unrelated = { role: "custom", customType: "other", content: "keep" };
    const user = { role: "user", content: "hello" };

    const result = contextResult(harness, [stale, unrelated, user]);
    assert.deepEqual(result?.messages, [unrelated, user]);
    assert.equal(contextResult(harness, [unrelated, user]), undefined);
  });

  await test("blocks only mutations whose scoped rules are not yet visible", (t) => {
    const harness = createHarness({
      "docs.md": scopedRule("docs/**", "Documentation rule"),
      "source.md": scopedRule("src/**", "Source rule"),
    });
    t.after(harness.cleanup);

    assert.equal(contextResult(harness, [{ role: "user", content: "Make a change" }]), undefined);

    const firstEdit = harness.emit("tool_call", {
      type: "tool_call",
      toolCallId: "edit-1",
      toolName: "edit",
      input: { path: "src/main.ts" },
    }) as ToolCallResult | undefined;
    assert.equal(firstEdit?.block, true);
    assert.match(firstEdit?.reason ?? "", /\.agents\/rules\/source\.md/);

    assert.equal(
      harness.emit("tool_call", {
        type: "tool_call",
        toolCallId: "read-1",
        toolName: "read",
        input: { path: "docs/readme.md" },
      }),
      undefined,
    );
    assert.equal(
      harness.emit("tool_call", {
        type: "tool_call",
        toolCallId: "write-1",
        toolName: "write",
        input: { path: "../outside.ts" },
      }),
      undefined,
    );

    injectedRuleContent(
      contextResult(harness, [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "edit-1",
              name: "edit",
              arguments: { path: "src/main.ts" },
            },
          ],
        },
      ]),
    );

    assert.equal(
      harness.emit("tool_call", {
        type: "tool_call",
        toolCallId: "write-2",
        toolName: "write",
        input: { path: "src/other.ts" },
      }),
      undefined,
    );

    const docsWrite = harness.emit("tool_call", {
      type: "tool_call",
      toolCallId: "write-3",
      toolName: "write",
      input: { path: "docs/readme.md" },
    }) as ToolCallResult | undefined;
    assert.equal(docsWrite?.block, true);
    assert.match(docsWrite?.reason ?? "", /\.agents\/rules\/docs\.md/);
  });
});
