import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { ConversationBusy } from "@earendil-works/pi-durable";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fixture, readHistory, code, model } from "./sessions-testing.ts";
import {
  changeDirectory,
  completeWorkingDirectories,
  environment,
  Environment,
  sessionInfo,
} from "../sessions.ts";
import { conversationURL } from "../presentation.ts";
import { modelKey, targetKey } from "../htmx/forms.ts";
import { directoryFixture, post, serve } from "./testing.ts";

const context = BACKGROUND_CONTEXT;

await test("HTML base directory is stored in Durable cwd, validates input, and defaults to /workspace", async (t) => {
  const f = await directoryFixture(t, "/workspace");
  const base = await serve(t, f.sessions);
  const post = (path: string, data: BodyInit) =>
    fetch(base + path, {
      method: "POST",
      headers: { Origin: base },
      body: data,
      redirect: "manual",
    });
  const create = async (baseDirectory?: string) => {
    const id = randomUUID();
    const response = await post(
      "/sessions",
      new URLSearchParams({
        id,
        target: targetKey(f.binding),
        model: modelKey(model),
        ...(baseDirectory === undefined ? {} : { baseDirectory }),
      }),
    );
    return { id, response };
  };
  for (const input of [undefined, "", "foo", "/foo", "/foo/"]) {
    const { id, response } = await create(input);
    assert.equal(response.status, 303);
    const session = await f.sessions.get(id);
    const info = await sessionInfo(session);
    assert.equal(info.cwd, input ? "/workspace/foo" : "/workspace");
    assert.equal((await session.root.agent(context)).cwd, info.cwd);
  }
  for (const input of ["../etc", "a\nb", "x".repeat(4097)])
    assert.equal((await create(input)).response.status, 400);
  const malformed = new FormData();
  malformed.set("id", randomUUID());
  malformed.set("target", targetKey(f.binding));
  malformed.set("model", modelKey(model));
  malformed.set("baseDirectory", new Blob(["not a text field"]), "path.txt");
  assert.equal((await post("/sessions", malformed)).status, 400);
  const { id } = await create("one");
  const session = await f.sessions.get(id);
  const configure = (baseDirectory: string) =>
    post(
      conversationURL(session) + "/settings",
      new URLSearchParams({
        name: "",
        target: targetKey(f.binding),
        model: modelKey(model),
        baseDirectory,
      }),
    );
  assert.equal((await session.root.agent(context)).cwd, "/workspace/one");
  assert.equal((await configure("two")).status, 303);
  assert.equal((await session.root.agent(context)).cwd, "/workspace/two");
  assert.equal((await configure("../etc")).status, 400);
  assert.equal((await session.root.agent(context)).cwd, "/workspace/two");
  assert.equal((await configure("")).status, 303);
  assert.equal((await session.root.agent(context)).cwd, "/workspace");
  assert.deepEqual((await sessionInfo(session)).binding, f.binding);
  const directories = (query: string) =>
    fetch(
      base +
        "/sessions/directories?" +
        new URLSearchParams({
          target: targetKey(f.binding),
          baseDirectory: query,
        }),
    );
  for (const query of ["../", "/../", "\0", "x".repeat(4097)])
    assert.equal((await directories(query)).status, 400);
  f.stop();
  assert.equal((await directories("")).status, 409);
  assert.equal(f.connections, 0, "validation does not connect or execute tools");
});

await test("cd updates only the selected conversation, validates directories, and persists without model input", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const nested = join(f.workspace, "space name");
  await mkdir(nested);
  await symlink(nested, join(f.workspace, "alias"));
  await writeFile(join(f.workspace, "file"), "file");
  await session.root.submit({ type: "write", entry: { kind: "test", data: {} } }, context);
  const before = await readHistory(session.root);
  const branch = await session.root.fork(
    before.at(-1)!.id,
    { ownership: { kind: "ownerless" } },
    context,
  );
  const base = await serve(t, f.sessions);
  const submit = (argument: string) =>
    post(base + conversationURL(session, branch.id) + "/cd", { argument });
  assert.equal((await submit("alias")).status, 303);
  assert.equal((await branch.agent(context)).cwd, nested);
  assert.equal((await session.root.agent(context)).cwd, f.workspace);
  assert.deepEqual(await session.harness.snapshot(Environment, branch.id, context), {
    provider: f.binding.provider,
    target: f.binding.target,
  });
  assert.equal((await environment(session, branch)).cwd, nested);
  assert.equal((await submit("..")).status, 303);
  assert.equal((await branch.agent(context)).cwd, f.workspace);
  for (const path of ["missing", "file", "bad\0path", "bad\npath", "x".repeat(4097)]) {
    assert.equal((await submit(path)).status, 400);
    assert.equal((await branch.agent(context)).cwd, f.workspace);
  }
  assert.equal((await submit(nested)).status, 303);
  assert.equal((await branch.agent(context)).cwd, nested);
  // Model an execution environment whose home differs from the server's HOME.
  const env = await environment(session, branch);
  const canonicalPath = env.canonicalPath.bind(env);
  const home = t.mock.method(env, "canonicalPath", (path: string, ctx: typeof context) =>
    canonicalPath(path === "~" ? f.workspace : path, ctx),
  );
  assert.equal((await submit("")).status, 303);
  assert.equal(home.mock.calls[0].arguments[0], "~");
  assert.equal((await branch.agent(context)).cwd, f.workspace);
  home.mock.restore();
  assert.equal((await submit(nested)).status, 303);
  assert.deepEqual(await readHistory(session.root), before);
  assert.deepEqual(await readHistory(branch), before);
  assert.equal(f.faux.state.callCount, 0);
  await f.reopen();
  const reopened = await f.sessions.get(session.id);
  const restored = await reopened.harness.conversation(branch.id, context);
  assert(restored);
  assert.equal((await restored.agent(context)).cwd, nested);
  assert.equal((await reopened.root.agent(context)).cwd, f.workspace);
});

await test("directory completion follows cwd, supports parents and absolute paths, and omits files", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  await mkdir(join(f.workspace, "space name", "nested"), { recursive: true });
  await mkdir(join(f.workspace, ".hidden"));
  await writeFile(join(f.workspace, "file"), "file");
  await symlink(join(f.workspace, "space name"), join(f.workspace, "alias"));
  await symlink(join(f.workspace, "file"), join(f.workspace, "file-link"));
  await symlink(join(f.workspace, "missing"), join(f.workspace, "broken"));
  const base = await serve(t, f.sessions);
  const complete = async (query: string) => {
    const response = await fetch(
      `${base}${conversationURL(session)}/completions?kind=directory&query=${encodeURIComponent(query)}`,
    );
    assert.equal(response.status, 200);
    return completeWorkingDirectories(session, query);
  };
  assert.deepEqual(await complete(""), ["alias/", "space name/"]);
  assert.deepEqual(await complete("."), [".hidden/"]);
  assert.deepEqual(await complete("space name/"), ["space name/nested/"]);
  assert.deepEqual(await complete(f.workspace + "/sp"), [f.workspace + "/space name/"]);
  assert.deepEqual(await complete("missing/"), []);
  await changeDirectory(session, "space name");
  assert.deepEqual(await complete(""), ["nested/"]);
  assert.deepEqual(await complete("../a"), ["../alias/"]);
  const env = await environment(session);
  const openDirReader = env.openDirReader.bind(env);
  const home = t.mock.method(env, "openDirReader", (path: string, ctx: typeof context) =>
    openDirReader(path === "~/" ? env.cwd : path, ctx),
  );
  assert.deepEqual(await complete("~/"), ["~/nested/"]);
  assert.equal(home.mock.calls[0].arguments[0], "~/");
  home.mock.restore();
  for (const query of ["bad\0path", "bad\npath", "x".repeat(4097)])
    await assert.rejects(completeWorkingDirectories(session, query), code("invalid"));
  assert.equal(f.faux.state.callCount, 0);
  await f.reopen({ env: undefined });
  const reopened = await f.sessions.get(session.id);
  await assert.rejects(changeDirectory(reopened, f.workspace), code("unavailable"));
  await assert.rejects(completeWorkingDirectories(reopened, ""), code("unavailable"));
});

await test("cd rejects active runs and concurrent environment changes", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const nested = join(f.workspace, "nested");
  await mkdir(nested);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.faux.setResponses([
    async () => {
      started.resolve();
      await release.promise;
      return fauxAssistantMessage("Done.");
    },
  ]);
  const submission = await session.root.submit({ type: "input", content: "Wait." }, context);
  await started.promise;
  try {
    await assert.rejects(changeDirectory(session, nested), ConversationBusy);
    assert.equal((await session.root.agent(context)).cwd, f.workspace);
  } finally {
    release.resolve();
    await submission.wait(context);
  }
  const env = await environment(session);
  const canonicalPath = env.canonicalPath.bind(env);
  t.mock.method(env, "canonicalPath", async (path: string, ctx: typeof context) => {
    await session.root.configure({ cwd: nested }, context);
    return canonicalPath(path, ctx);
  });
  await assert.rejects(changeDirectory(session, "."), code("conflict"));
  assert.equal((await session.root.agent(context)).cwd, nested);
});
