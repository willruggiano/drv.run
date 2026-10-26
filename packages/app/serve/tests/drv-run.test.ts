import * as runtime from "../sessions.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Connection, RemoteExecutionEnv } from "@earendil-works/pi-env";
import { resolveBaseDirectory } from "../sessions.ts";
import { readHistory, code, exists, model, waitFor } from "./sessions-testing.ts";
import { listInstances } from "../instances.ts";
import { remoteFixture } from "./drv-run-testing.ts";

const context = BACKGROUND_CONTEXT;

await test("inventory excludes invalid and incomplete instances; readiness requires active service and client config", async (t) => {
  const f = await remoteFixture(t);
  await f.instance("stopped", "path:/stopped");
  await f.instance("unready", "path:/unready", false);
  await f.instance("incomplete", undefined);
  await f.instance("bad-name", "path:/invalid");
  await writeFile(f.states, JSON.stringify({ test1: "active", unready: "active" }));
  assert.deepEqual(await listInstances(f.options), [
    { id: "stopped", reference: "path:/stopped", running: false },
    { id: "test1", reference: "path:/test", running: true },
    { id: "unready", reference: "path:/unready", running: false },
  ]);
  const calls: string[][] = (await readFile(f.calls, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    calls.sort((a, b) => a[2].localeCompare(b[2])),
    ["stopped", "test1", "unready"].map((id) => [
      "--user",
      "show",
      `drv.run@${id}.service`,
      "--property=ActiveState",
      "--value",
    ]),
  );
  assert.equal((await f.targets()).filter((target) => target.available).length, 1);
  assert.deepEqual(
    await listInstances({ ...f.options, stateDirectory: join(f.directory, "missing") }),
    [],
  );
  await assert.rejects(listInstances({ ...f.options, systemctl: join(f.directory, "missing") }));
});

await test("environment admission rejects local execution and stopped or absent instances without connecting", async (t) => {
  const f = await remoteFixture(t);
  assert((await f.sessions.catalog()).targets.every((target) => target.provider === "drv.run"));
  const local = await f.sessions.create(
    randomUUID(),
    { provider: "local", target: f.workspace, cwd: f.workspace },
    model,
  );
  await assert.rejects(runtime.environment(local), code("unavailable"));
  for (const target of ["../test1", "-test", "test;echo", "missing"]) {
    const session = await f.sessions.create(randomUUID(), { ...f.binding, target }, model);
    await assert.rejects(runtime.environment(session), code("unavailable"));
  }
  await writeFile(f.states, "{}");
  const session = await f.sessions.create(randomUUID(), f.binding, model);
  await assert.rejects(runtime.environment(session), code("unavailable"));
  assert.equal(f.connections.length, 0);
});

await test("faux turns use the daemon for read/write/edit; instance removal preserves history and forbids local fallback", async (t) => {
  const f = await remoteFixture(t);
  // The local daemon needs an existing cwd even when tool paths are absolute.
  await f.reopen({ targets: f.targets });
  const file = join(f.workspace, "remote.json");
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("write", { path: file, content: "1" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage(fauxToolCall("edit", { path: file, oldText: "1", newText: "2" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage(fauxToolCall("read", { path: file }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Done."),
  ]);
  const session = await f.sessions.create(randomUUID(), f.binding, model, undefined, "");
  assert.equal((await runtime.sessionInfo(session)).binding?.provider, "drv.run");
  await session.root.submit(
    { type: "input", content: "Use the remote filesystem.", requestId: randomUUID() },
    context,
  );
  await session.root.waitForIdle(context);
  assert.equal(JSON.parse(await readFile(file, "utf8")), 2);
  assert.equal(f.connections.length, 1);
  const history = await readHistory(session.root);
  const results = history
    .flatMap((entry) => entry.model ?? [])
    .filter((message) => message.role === "toolResult");
  assert.equal(results.length, 3);
  assert(results.every((result) => !result.isError));
  await rm(join(f.directory, "drv.run", "test1"), { recursive: true });
  await f.reopen();
  const restored = await f.sessions.get(session.id);
  assert.deepEqual(await readHistory(restored.root), history);
  await assert.rejects(runtime.environment(restored), code("unavailable"));
  restored.harness.resume();
  assert.equal(f.faux.state.callCount, 4);
  assert.equal((await f.sessions.catalog()).sessions.length, 1);
});

await test("stopping an instance blocks existing sessions without opening another connection", async (t) => {
  const f = await remoteFixture(t);
  const session = await f.sessions.create(randomUUID(), f.binding, model);
  await rm(join(f.options.runtimeDirectory, "drv.run.test1", "client.conf"));
  await assert.rejects(runtime.environment(session), code("unavailable"));
  session.harness.resume();
  assert.equal(f.connections.length, 0);
  assert.equal(f.faux.state.callCount, 0);
  assert.equal((await readHistory(session.root)).length, 0);
});

await test("transport failure reports tool errors without touching local files", async (t) => {
  const f = await remoteFixture(t);
  const broken = {
    ...f.options,
    connect: () => ({
      connection: new Connection({ command: [join(f.directory, "missing-ssh")] }),
      remote: () => undefined,
    }),
  };
  await f.reopen({ drvRun: broken });
  const file = join(f.workspace, "never.json");
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("write", { path: file, content: "1" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("Failed."),
  ]);
  const session = await f.sessions.create(randomUUID(), f.binding, model);
  await session.root.submit({ type: "input", content: "Work.", requestId: randomUUID() }, context);
  await session.root.waitForIdle(context);
  assert.equal(await exists(file), false);
  const results = (await readHistory(session.root))
    .flatMap((entry) => entry.model ?? [])
    .filter((message) => message.role === "toolResult");
  assert.equal(results.length, 1);
  assert.equal(results[0].isError, true);
  assert.equal(f.faux.state.callCount, 2);
});

await test(
  "canceling inventory discovery terminates its systemctl process",
  { timeout: 10000 },
  async (t) => {
    const f = await remoteFixture(t);
    const marker = join(f.directory, "discovery-pid");
    const systemctl = join(f.directory, "blocked-systemctl");
    await writeFile(
      systemctl,
      `#!${process.execPath}
import { writeFile } from "node:fs/promises";
process.stdin.resume();
await writeFile(${JSON.stringify(marker)}, String(process.pid));
`,
      { mode: 0o700 },
    );
    let pid: number | undefined;
    function alive() {
      if (pid === undefined || pid <= 0) return false;
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
        throw error;
      }
    }
    const controller = new AbortController();
    t.after(() => {
      controller.abort();
      if (pid !== undefined && alive()) process.kill(pid);
    });
    const pending = listInstances({ ...f.options, systemctl }, controller.signal);
    const rejected = assert.rejects(pending, { name: "AbortError" });
    await waitFor(async () => {
      if (!(await exists(marker))) return false;
      const candidate = Number(await readFile(marker, "utf8"));
      if (!Number.isSafeInteger(candidate) || candidate <= 0) return false;
      pid = candidate;
      return true;
    });
    assert(alive());
    controller.abort();
    await rejected;
    await waitFor(async () => !alive());
    assert.equal(f.connections.length, 0);
  },
);

await test("canceling an environment waiter leaves the cached environment usable", async (t) => {
  const f = await remoteFixture(t);
  const session = await f.sessions.create(randomUUID(), f.binding, model);
  const controller = new AbortController();
  const reason = new Error("Caller left");
  await session.root.configure({ cwd: f.workspace }, context);
  const connect = f.options.connect.bind(f.options);
  t.mock.method(f.options, "connect", (...args: Parameters<typeof connect>) => {
    controller.abort(reason);
    return connect(...args);
  });
  await assert.rejects(
    runtime.environment(session, session.root, withAbortSignal(controller.signal, context)),
    reason,
  );
  const env = await runtime.environment(session);
  const result = await env.exec("true", {}, context);
  assert(result.ok);
  assert.equal(result.value.exitCode, 0);
  assert.equal(f.connections.length, 1);
  assert.equal(f.faux.state.callCount, 0);
});

await test("base directory input is always workspace-relative and invalid paths fail closed", async (t) => {
  const f = await remoteFixture(t);
  for (const [input, expected] of [
    ["", "/workspace"],
    ["/", "/workspace"],
    [".", "/workspace"],
    ["foo", "/workspace/foo"],
    ["/foo", "/workspace/foo"],
    ["//foo/./bar/", "/workspace/foo/bar"],
    ["/workspace/foo", "/workspace/workspace/foo"],
    ["space name", "/workspace/space name"],
  ])
    assert.equal(resolveBaseDirectory("/workspace", input), expected);
  for (const input of ["../", "foo/../bar", "a\0b", "a\nb", "x".repeat(4097)]) {
    await assert.rejects(
      f.sessions.create(randomUUID(), f.binding, model, undefined, input),
      code("invalid"),
    );
    await assert.rejects(f.sessions.completeDirectories(f.binding, input), code("invalid"));
  }
  for (const input of [undefined, "", "foo", "/foo"]) {
    const session = await f.sessions.create(randomUUID(), f.binding, model, undefined, input);
    assert.equal((await session.root.agent(context)).cwd, input ? "/workspace/foo" : "/workspace");
    assert.equal((await runtime.sessionInfo(session)).directoryRoot, "/workspace");
    assert.deepEqual((await runtime.sessionInfo(session)).binding, f.binding);
  }
  assert.equal(f.connections.length, 0);
});

await test("native Durable cwd drives remote tools, forks, completions and restart without changing the target", async (t) => {
  const f = await remoteFixture(t);
  // A temporary guest workspace makes the real daemon test independent of /workspace permissions.
  await f.reopen({ targets: f.targets });
  for (const path of ["one", "two", "space name", ".hidden", "one/nested"])
    await mkdir(join(f.workspace, path));
  await writeFile(join(f.workspace, "file.txt"), "not a directory");
  const opened = f.sessions.opened.size;
  assert.deepEqual(await f.sessions.completeDirectories(f.binding, ""), [
    "one/",
    "space name/",
    "two/",
  ]);
  assert.deepEqual(await f.sessions.completeDirectories(f.binding, "/o"), ["/one/"]);
  assert.deepEqual(await f.sessions.completeDirectories(f.binding, "one/n"), ["one/nested/"]);
  assert.deepEqual(await f.sessions.completeDirectories(f.binding, "."), [".hidden/"]);
  assert.deepEqual(await f.sessions.completeDirectories(f.binding, "absent/"), []);
  assert.equal(f.sessions.opened.size, opened, "directory browsing must not open a harness");
  assert.equal(f.connections.length, 1);
  assert.equal(f.faux.state.callCount, 0);
  const session = await f.sessions.create(randomUUID(), f.binding, model, undefined, "/one");
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("write", { path: "root.txt", content: "root" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage(fauxToolCall("bash", { command: "pwd > cwd.txt" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("Done."),
  ]);
  await session.root.submit(
    { type: "input", content: "Write relative to the base directory.", requestId: randomUUID() },
    context,
  );
  await session.root.waitForIdle(context);
  assert.equal(await readFile(join(f.workspace, "one/root.txt"), "utf8"), "root");
  assert.equal(
    (await readFile(join(f.workspace, "one/cwd.txt"), "utf8")).trim(),
    join(f.workspace, "one"),
  );
  const history = await readHistory(session.root);
  const fork = await session.root.fork(
    history.at(-1)!.id,
    { ownership: { kind: "ownerless" } },
    context,
  );
  assert.equal((await fork.agent(context)).cwd, join(f.workspace, "one"));
  await fork.configure({ cwd: await f.sessions.baseDirectory(f.binding, "/two") }, context);
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("write", { path: "branch.txt", content: "branch" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("Done."),
  ]);
  const before = f.connections.length;
  await fork.submit(
    { type: "input", content: "Write in the fork.", requestId: randomUUID(), whenBusy: "reject" },
    context,
  );
  await fork.waitForIdle(context);
  assert.equal(await readFile(join(f.workspace, "two/branch.txt"), "utf8"), "branch");
  assert.deepEqual(await runtime.completePaths(session, "root"), ["root.txt"]);
  assert.deepEqual(await runtime.completePaths(session, "branch", fork), ["branch.txt"]);
  assert.equal(f.connections.length, before + 1, "each cwd environment owns its connection");
  await f.reopen({ targets: f.targets });
  const restored = await f.sessions.get(session.id);
  assert.equal((await runtime.sessionInfo(restored)).cwd, join(f.workspace, "one"));
  const restoredFork = await runtime.getConversation(restored, fork.id);
  assert.equal((await restoredFork.agent(context)).cwd, join(f.workspace, "two"));
  assert.deepEqual(await runtime.completePaths(restored, "branch", restoredFork), ["branch.txt"]);
  await writeFile(f.states, "{}");
  await assert.rejects(
    runtime.completePaths(restored, "branch", restoredFork),
    code("unavailable"),
  );
  await assert.rejects(f.sessions.completeDirectories(f.binding, ""), code("unavailable"));
  const closes = f.connections.map((connection) => t.mock.method(connection, "close"));
  await f.sessions.close();
  // Reopen already closed the earlier environments; shutdown closes only the current ones.
  assert.equal(
    closes.reduce((count, close) => count + close.mock.callCount(), 0),
    1,
  );
});
