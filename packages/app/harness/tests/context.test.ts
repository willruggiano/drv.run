import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxToolCall,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type Conversation,
  type Cursor,
  type EntryRecord,
  ToolResultEntry,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { FileError } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { ContextFiles, contextPaths, loadContextFiles, type ContextFile } from "../context.ts";
import { openHarness } from "../index.ts";

const context = BACKGROUND_CONTEXT;
const done = () => fauxAssistantMessage("Done.");
const write = (path = "result.json", content = "1") =>
  fauxAssistantMessage(fauxToolCall("write", { path, content }), { stopReason: "toolUse" });
function promptContext(messages: readonly Message[]): {
  files: ContextFile[];
  contributing: boolean;
} {
  let value: string | null | undefined;
  for (const message of messages) {
    if (message.role === "system" && message.sections && "context" in message.sections)
      value = message.sections.context;
  }
  assert(value);
  return JSON.parse(value);
}

async function readHistory(conversation: Conversation): Promise<EntryRecord[]> {
  const entries: EntryRecord[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await conversation.entries({ order: "ascending" }, 256, cursor, context);
    entries.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  return entries;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function configured(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "harness-context-"));
  const workspace = join(directory, "workspace");
  const home = join(directory, "home");
  const user = join(home, ".config");
  const system = join(directory, "system");
  await Promise.all([workspace, user, system].map((path) => mkdir(path, { recursive: true })));
  const faux = fauxProvider({ models: [{ id: "faux-1", reasoning: true }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const environment = (cwd = workspace) =>
    new NodeExecutionEnv({
      cwd,
      shellEnv: { ...process.env, HOME: home, XDG_CONFIG_HOME: user, XDG_CONFIG_DIRS: system },
    });
  const views: NodeExecutionEnv[] = [];
  let harness: Awaited<ReturnType<typeof openHarness>> | undefined;
  async function open() {
    harness = await openHarness(
      await openNodeSqliteStorage(join(directory, "session.sqlite")),
      {
        models,
        env: ({ cwd }) => {
          const env = environment(cwd);
          views.push(env);
          return env;
        },
      },
      context,
    );
    return {
      harness,
      root: await harness.root(context, {
        agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: workspace },
      }),
    };
  }
  t.after(async () => {
    await harness?.close(context);
    await Promise.all(views.map((env) => env.cleanup(context)));
    await rm(directory, { recursive: true, force: true });
  });
  const f = {
    directory,
    workspace,
    faux,
    async create() {
      assert(!harness);
      return open();
    },
    async reopen() {
      await harness?.close(context);
      return open();
    },
  };
  const run = async (conversation: Conversation) => {
    await conversation.submit(
      { type: "input", content: "Work.", requestId: randomUUID() },
      context,
    );
    await conversation.waitForIdle(context);
  };
  return { f, home, user, system, environment, run };
}

await test("XDG context paths use defaults, absolute overrides and low-to-high precedence", () => {
  assert.deepEqual(contextPaths("/home/pi", "", ""), [
    "/etc/xdg/llms.txt",
    "/home/pi/.config/llms.txt",
  ]);
  assert.deepEqual(contextPaths("/home/pi", "relative", "/high:/low:/high:relative:"), [
    "/low/llms.txt",
    "/high/llms.txt",
    "/home/pi/.config/llms.txt",
  ]);
  assert.deepEqual(contextPaths("/home/pi", "/user", "/system"), [
    "/system/llms.txt",
    "/user/llms.txt",
  ]);
  assert.throws(() => contextPaths("relative", "", ""));
});

await test("context discovery uses the execution environment, not server HOME or cwd", async (t) => {
  const { f, environment } = await configured(t);
  const env = environment();
  t.after(() => env.cleanup(context));
  // Model a different filesystem namespace. Only these explicit environment methods can read it.
  env.cwd = "/guest/work/sub";
  env.canonicalPath = async (path) => ({ ok: true, value: path });
  env.exec = async (_command, options, ctx) => {
    options?.onOutput?.("/guest/home\0/guest/config\0/guest/system\0", ctx, {
      stream: "stdout",
    });
    return { ok: true, value: { exitCode: 0 } };
  };
  env.fileInfo = async (path) =>
    path === "/guest/work/.git"
      ? { ok: true, value: { name: ".git", path, kind: "file", size: 0, mtimeMs: 0 } }
      : { ok: false, error: new FileError("not_found", "Missing", path) };
  const files = new Map([
    ["/guest/system/llms.txt", "System instructions."],
    ["/guest/config/llms.txt", "User instructions."],
    ["/guest/work/README.md", "Project documentation."],
    ["/guest/work/CONTRIBUTING.md", "Contribution instructions."],
  ]);
  const reader = env.openBinaryReader.bind(env);
  let index = 0;
  const paths = new Map<string, string>();
  for (const [path, content] of files) {
    const local = join(f.directory, `remote-${index++}`);
    await writeFile(local, content);
    paths.set(path, local);
  }
  env.openBinaryReader = (path, options, ctx) => {
    const local = paths.get(path);
    assert(local, `Unexpected remote read: ${path}`);
    return reader(local, options, ctx);
  };
  assert.deepEqual(
    (await loadContextFiles(env, false, context)).files,
    [...files].slice(0, 3).map(([path, content], i) => ({
      path,
      content,
      level: ["system", "user", "repo"][i],
    })),
  );
});

await test("repository context uses worktree roots, follows symlinked documents and ignores agent conventions", async (t) => {
  const { f, system, user, environment } = await configured(t);
  const sub = join(f.workspace, "worktree", "sub");
  const root = posix.dirname(sub);
  await mkdir(sub, { recursive: true });
  await mkdir(join(f.workspace, ".git"));
  await writeFile(join(root, ".git"), "gitdir: ../.git/worktrees/worktree\n");
  await writeFile(join(f.workspace, "README.md"), "Wrong worktree.");
  await writeFile(join(root, "AGENTS.md"), "Not loaded.");
  await mkdir(join(root, ".agents/rules"), { recursive: true });
  await writeFile(join(root, ".agents/rules/global.md"), "Not loaded either.");
  await writeFile(join(root, "readme-source"), "Right worktree.");
  await symlink("readme-source", join(root, "README.md"));
  await writeFile(join(sub, "README.md"), "Not the root.");
  await writeFile(join(system, "llms.txt"), "System.");
  await writeFile(join(user, "llms.txt"), "User.");
  await writeFile(join(root, "CONTRIBUTING.md"), "Contribute.");
  const env = environment(sub);
  t.after(() => env.cleanup(context));
  const baseline = await loadContextFiles(env, false, context);
  assert.deepEqual(baseline.files, [
    { level: "system", path: join(system, "llms.txt"), content: "System." },
    { level: "user", path: join(user, "llms.txt"), content: "User." },
    { level: "repo", path: join(root, "README.md"), content: "Right worktree." },
  ]);
  assert.deepEqual((await loadContextFiles(env, true, context)).files, [
    ...baseline.files,
    { level: "repo", path: join(root, "CONTRIBUTING.md"), content: "Contribute." },
  ]);
});

await test("baseline context precedes the first request and CONTRIBUTING blocks the first mutation", async (t) => {
  const { f, system, user, run } = await configured(t);
  await writeFile(join(system, "llms.txt"), "System.");
  await writeFile(join(user, "llms.txt"), "User.");
  await writeFile(join(f.workspace, "README.md"), "Readme.");
  await writeFile(join(f.workspace, "CONTRIBUTING.md"), "Contribute.");
  const session = await f.create();
  f.faux.setResponses([
    ({ messages }) => {
      assert.deepEqual(
        promptContext(messages).files.map((file) => file.level),
        ["system", "user", "repo"],
      );
      assert.equal(promptContext(messages).contributing, false);
      return write();
    },
    async ({ messages }) => {
      assert.equal(await exists(join(f.workspace, "result.json")), false);
      assert.equal(promptContext(messages).contributing, true);
      assert.deepEqual(promptContext(messages).files.at(-1), {
        level: "repo",
        path: join(f.workspace, "CONTRIBUTING.md"),
        content: "Contribute.",
      });
      return write();
    },
    done(),
  ]);
  await run(session.root);
  assert.equal(f.faux.state.callCount, 3);
  assert.equal(JSON.parse(await readFile(join(f.workspace, "result.json"), "utf8")), 1);
  assert.deepEqual(
    (await readHistory(session.root))
      .filter((entry) => ToolResultEntry.is(entry))
      .map((entry) => entry.data.diagnostics.map((d) => d.code)),
    [["context_required"], []],
  );
});

await test("parallel mutations cannot authorize their own batch", async (t) => {
  const { f, run } = await configured(t);
  await writeFile(join(f.workspace, "CONTRIBUTING.md"), "Contribute.");
  await writeFile(join(f.workspace, "edit.json"), "0");
  const session = await f.create();
  const mutation = fauxAssistantMessage(
    [
      fauxToolCall("write", { path: "result.json", content: "1" }),
      fauxToolCall("edit", { path: "edit.json", edits: [{ oldText: "0", newText: "1" }] }),
    ],
    { stopReason: "toolUse" },
  );
  f.faux.setResponses([
    mutation,
    async () => {
      assert.equal(await exists(join(f.workspace, "result.json")), false);
      assert.equal(JSON.parse(await readFile(join(f.workspace, "edit.json"), "utf8")), 0);
      return mutation;
    },
    done(),
  ]);
  await run(session.root);
  assert.equal(JSON.parse(await readFile(join(f.workspace, "result.json"), "utf8")), 1);
  assert.equal(JSON.parse(await readFile(join(f.workspace, "edit.json"), "utf8")), 1);
});

await test("changed instructions block mutation until the changed content reaches a new request", async (t) => {
  for (const name of ["README.md", "CONTRIBUTING.md"])
    await t.test(name, async (t) => {
      const { f, run } = await configured(t);
      const file = join(f.workspace, name);
      await writeFile(file, "Before.");
      const session = await f.create();
      f.faux.setResponses(name === "CONTRIBUTING.md" ? [write(), done()] : [done()]);
      await run(session.root);
      f.faux.setResponses([
        async () => {
          await writeFile(file, "After.");
          return write();
        },
        async ({ messages }) => {
          assert.equal(await exists(join(f.workspace, "result.json")), false);
          assert.equal(
            promptContext(messages).files.find((item) => item.path === file)?.content,
            "After.",
          );
          return write();
        },
        done(),
      ]);
      await run(session.root);
      assert.equal(JSON.parse(await readFile(join(f.workspace, "result.json"), "utf8")), 1);
    });
});

await test("missing files allow mutation; newly created CONTRIBUTING requires disclosure", async (t) => {
  const { f, run } = await configured(t);
  const session = await f.create();
  f.faux.setResponses([write(), done()]);
  await run(session.root);
  assert.equal(JSON.parse(await readFile(join(f.workspace, "result.json"), "utf8")), 1);
  f.faux.setResponses([
    async () => {
      await writeFile(join(f.workspace, "CONTRIBUTING.md"), "New.");
      return write("result.json", "2");
    },
    async () => {
      assert.equal(JSON.parse(await readFile(join(f.workspace, "result.json"), "utf8")), 1);
      return write("result.json", "2");
    },
    done(),
  ]);
  await run(session.root);
  assert.equal(JSON.parse(await readFile(join(f.workspace, "result.json"), "utf8")), 2);
});

await test("instruction failures block mutations, never retain stale context, and recover", async (t) => {
  const { f, run } = await configured(t);
  const file = join(f.workspace, "README.md");
  await writeFile(file, "Valid.");
  const session = await f.create();
  f.faux.setResponses([done()]);
  await run(session.root);
  await rm(file);
  await mkdir(file);
  f.faux.setResponses([write(), done()]);
  await run(session.root);
  assert.equal(f.faux.state.callCount, 3);
  assert.equal(await exists(join(f.workspace, "result.json")), false);
  await rm(file, { recursive: true });
  await writeFile(file, "Fixed.");
  f.faux.setResponses([write(), done()]);
  await run(session.root);
  assert.equal(f.faux.state.callCount, 5);
  assert.equal(JSON.parse(await readFile(join(f.workspace, "result.json"), "utf8")), 1);
});

await test("unreadable CONTRIBUTING blocks mutations and oversized instructions fail without truncation", async (t) => {
  const { f, run, environment } = await configured(t);
  await mkdir(join(f.workspace, "CONTRIBUTING.md"));
  const session = await f.create();
  f.faux.setResponses([write(), done()]);
  await run(session.root);
  assert.equal(await exists(join(f.workspace, "result.json")), false);
  const results = (await readHistory(session.root))
    .flatMap((entry) => entry.model ?? [])
    .filter((message) => message.role === "toolResult");
  assert.equal(results[0]?.isError, true);
  await writeFile(join(f.workspace, "README.md"), "x".repeat(1024 * 1024 + 1));
  const env = environment();
  t.after(() => env.cleanup(context));
  await assert.rejects(loadContextFiles(env, false, context));
});

await test("activation survives restart and compaction, forks as-of, and resets independently", async (t) => {
  const { f, run } = await configured(t);
  await writeFile(join(f.workspace, "CONTRIBUTING.md"), "Contribute.");
  let session = await f.create();
  f.faux.setResponses([done()]);
  await run(session.root);
  const before = (await readHistory(session.root)).at(-1)!;
  f.faux.setResponses([write(), done()]);
  await run(session.root);
  const after = (await readHistory(session.root)).at(-1)!;
  assert.equal(
    (await session.harness.snapshot(ContextFiles, session.root.id, context))?.contributing,
    true,
  );
  session = await f.reopen();
  const early = await session.root.fork(before.id, { ownership: { kind: "ownerless" } }, context);
  const late = await session.root.fork(after.id, { ownership: { kind: "ownerless" } }, context);
  for (const [conversation, expected] of [
    [early, false],
    [late, true],
    [session.root, true],
  ] as const) {
    f.faux.setResponses([
      ({ messages }) => {
        assert.equal(promptContext(messages).contributing, expected);
        return done();
      },
    ]);
    await run(conversation);
  }
  await late.submit(
    { type: "write", entry: { kind: "pi.compaction", data: { reason: "manual" }, head: after.id } },
    context,
  );
  f.faux.setResponses([
    ({ messages }) => {
      assert.equal(promptContext(messages).contributing, true);
      return done();
    },
  ]);
  await run(late);
  await late.reset(undefined, context);
  // A compaction before the next request must not hide that reset from the loader.
  const reset = (await readHistory(late)).at(-1)!;
  await late.submit(
    { type: "write", entry: { kind: "pi.compaction", data: { reason: "manual" }, head: reset.id } },
    context,
  );
  f.faux.setResponses([
    ({ messages }) => {
      assert.equal(promptContext(messages).contributing, false);
      return done();
    },
  ]);
  await run(late);
  assert.equal(
    (await session.harness.snapshot(ContextFiles, session.root.id, context))?.contributing,
    true,
  );
});

await test("changing base directory removes the previous repository context and activation", async (t) => {
  const { f, run } = await configured(t);
  await mkdir(join(f.workspace, ".git"));
  await writeFile(join(f.workspace, "README.md"), "First.");
  await writeFile(join(f.workspace, "CONTRIBUTING.md"), "First contributions.");
  const other = join(f.workspace, "other");
  await mkdir(join(other, ".git"), { recursive: true });
  await writeFile(join(other, "README.md"), "Second.");
  await writeFile(join(other, "CONTRIBUTING.md"), "Second contributions.");
  const session = await f.create();
  f.faux.setResponses([write(), done()]);
  await run(session.root);
  await session.root.configure({ cwd: other }, context);
  f.faux.setResponses([
    ({ messages }) => {
      assert.deepEqual(promptContext(messages), {
        ...promptContext(messages),
        files: [{ level: "repo", path: join(other, "README.md"), content: "Second." }],
        contributing: false,
      });
      return write();
    },
    done(),
  ]);
  await run(session.root);
  assert.equal(await exists(join(other, "result.json")), false);
  f.faux.setResponses([write(), done()]);
  await run(session.root);
  assert.equal(JSON.parse(await readFile(join(other, "result.json"), "utf8")), 1);
});
