import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
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
import { createContextExtension, contextPaths, loadContextFiles } from "../src/context.ts";
import { openHarness } from "../src/index.ts";

const context = BACKGROUND_CONTEXT;
const done = () => fauxAssistantMessage("Done.");
const write = (path = "result.json", content = "1") =>
  fauxAssistantMessage(fauxToolCall("write", { path, content }), { stopReason: "toolUse" });
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

await test("context extension only renders a prompt section", () => {
  const extension = createContextExtension();
  assert.deepEqual(
    extension.sections?.map((section) => section.key),
    ["context"],
  );
  assert.equal(extension.hooks, undefined);
  assert.equal(extension.wraps, undefined);
});

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
    await loadContextFiles(env, context),
    [...files].map(([path, content], i) => ({
      path,
      content,
      level: ["system", "user", "project", "project"][i],
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
  assert.deepEqual(await loadContextFiles(env, context), [
    { level: "system", path: join(system, "llms.txt"), content: "System." },
    { level: "user", path: join(user, "llms.txt"), content: "User." },
    { level: "project", path: join(root, "README.md"), content: "Right worktree." },

    { level: "project", path: join(root, "CONTRIBUTING.md"), content: "Contribute." },
  ]);
});

await test("all context is supplied before the first mutation", async (t) => {
  const { f, system, user, run } = await configured(t);
  await writeFile(join(system, "llms.txt"), "System.");
  await writeFile(join(user, "llms.txt"), "User.");
  await writeFile(join(f.workspace, "README.md"), "Readme.");
  await writeFile(join(f.workspace, "CONTRIBUTING.md"), "Contribute.");
  const session = await f.create();
  f.faux.setResponses([
    ({ messages }) => {
      assert(messages.some((message) => message.role === "system" && message.sections?.context));
      return write();
    },
    done(),
  ]);
  await run(session.root);
  assert.equal(f.faux.state.callCount, 2);
  assert.equal(JSON.parse(await readFile(join(f.workspace, "result.json"), "utf8")), 1);
  assert.deepEqual(
    (await readHistory(session.root))
      .filter((entry) => ToolResultEntry.is(entry))
      .map((entry) => entry.data.diagnostics.map((d) => d.code)),
    [[]],
  );
});

await test("missing context files are omitted", async (t) => {
  const { environment } = await configured(t);
  const env = environment();
  t.after(() => env.cleanup(context));
  assert.deepEqual(await loadContextFiles(env, context), []);
});

await test("context discovery reloads changed project files", async (t) => {
  const { f, environment } = await configured(t);
  const env = environment();
  t.after(() => env.cleanup(context));
  const path = join(f.workspace, "CONTRIBUTING.md");
  await writeFile(path, "Before.");
  assert.deepEqual(await loadContextFiles(env, context), [
    { level: "project", path, content: "Before." },
  ]);
  await writeFile(path, "After.");
  assert.deepEqual(await loadContextFiles(env, context), [
    { level: "project", path, content: "After." },
  ]);
});

await test("unreadable and oversized instructions fail without truncation", async (t) => {
  const { f, environment } = await configured(t);
  const env = environment();
  t.after(() => env.cleanup(context));
  const file = join(f.workspace, "CONTRIBUTING.md");
  await mkdir(file);
  await assert.rejects(loadContextFiles(env, context));
  await rm(file, { recursive: true });
  await writeFile(join(f.workspace, "README.md"), "x".repeat(1024 * 1024 + 1));
  await assert.rejects(loadContextFiles(env, context));
});

await test("context is supplied after restart, fork, compaction and reset", async (t) => {
  const { f, run } = await configured(t);
  await writeFile(join(f.workspace, "CONTRIBUTING.md"), "Contribute.");
  let session = await f.create();
  f.faux.setResponses([done()]);
  await run(session.root);
  const before = (await readHistory(session.root)).at(-1)!;
  session = await f.reopen();
  const branch = await session.root.fork(before.id, { ownership: { kind: "ownerless" } }, context);
  for (const conversation of [branch, session.root]) {
    const calls = f.faux.state.callCount;
    f.faux.setResponses([write(), done()]);
    await run(conversation);
    assert.equal(f.faux.state.callCount, calls + 2);
  }
  await branch.submit(
    {
      type: "write",
      entry: { kind: "pi.compaction", data: { reason: "manual" }, head: before.id },
    },
    context,
  );
  f.faux.setResponses([write(), done()]);
  await run(branch);
  assert.equal(f.faux.state.callCount, 7);
  await branch.reset(undefined, context);
  const reset = (await readHistory(branch)).at(-1)!;
  await branch.submit(
    { type: "write", entry: { kind: "pi.compaction", data: { reason: "manual" }, head: reset.id } },
    context,
  );
  f.faux.setResponses([write(), done()]);
  await run(branch);
  assert.equal(f.faux.state.callCount, 9);
  assert.equal(JSON.parse(await readFile(join(f.workspace, "result.json"), "utf8")), 1);
});

await test("changing base directory supplies the new project context before mutation", async (t) => {
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
  f.faux.setResponses([write(), done()]);
  await run(session.root);
  assert.equal(f.faux.state.callCount, 4);
  assert.equal(JSON.parse(await readFile(join(other, "result.json"), "utf8")), 1);
});
