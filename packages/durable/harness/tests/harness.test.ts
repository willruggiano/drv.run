import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { defineDoc, CompactionTask } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import {
  Connection,
  localDaemon,
  RemoteExecutionEnv,
  type SshConnectOptions,
} from "@earendil-works/pi-env";
import * as api from "../src/index.ts";

const context = BACKGROUND_CONTEXT;

await test("public API opens a native, paused harness with the fixed extensions", async (t) => {
  assert.deepEqual(Object.keys(api).sort(), ["Env", "Review", "SshExecutionEnv", "openHarness"]);
  const Marker = defineDoc<{ created: boolean }>({
    kind: "test.created",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "current",
    initial: () => ({ created: false }),
    checkpointWhen: () => true,
  });
  let resolutions = 0;
  const harness = await api.openHarness(
    new MemoryStorage(),
    {
      models: createModels(),
      env() {
        resolutions++;
        return undefined;
      },
      async conversationCreated(tx, conversation) {
        (await tx.doc(Marker, conversation.id)).created = true;
      },
    },
    context,
  );
  t.after(() => harness.close(context));
  const root = await harness.root(context);
  const agent = await root.agent(context);
  assert.deepEqual(
    agent.extensions.map((extension) => extension.name),
    ["coding-tools", "coding", "context", "web", "review"],
  );
  assert.deepEqual(agent.tools.map((tool) => tool.name).sort(), [
    "bash",
    "edit",
    "read",
    "web_fetch",
    "web_search",
    "write",
  ]);
  assert.deepEqual(await harness.snapshot(Marker, root.id, context), {
    created: true,
  });
  assert.equal((await harness.inspect(context)).scheduling, "paused");
  assert.equal(resolutions, 0);
});

const sshTarget = {
  host: "drv.run.test1",
  user: "root",
  port: 22,
  configFile: "/etc/ssh/ssh_config",
  identityFile: "/run/user/1000/drv.run.test1/client-key",
  knownHostsFile: "/run/user/1000/drv.run.test1/known_hosts",
  hostKeyAlias: "drv.run.test1",
};

await test("SSH environments project targets, isolate connections, and keep file identity across cwd changes", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ssh-env-"));
  const targets: SshConnectOptions[] = [];
  const connect = (target: SshConnectOptions) => {
    targets.push(target);
    return { connection: new Connection({ command: [localDaemon()] }), remote: () => undefined };
  };
  const target = { ...sshTarget, ssh: "forbidden", binary: "forbidden" };
  const a = new api.SshExecutionEnv({ target, cwd, connect });
  const b = new api.SshExecutionEnv({ target, cwd: "/", connect });
  const c = new api.SshExecutionEnv({ target: { ...target, port: 2222 }, cwd, connect });
  t.after(async () => {
    await Promise.all([a, b, c].map((env) => env.cleanup(context)));
    await rm(cwd, { recursive: true, force: true });
  });
  assert(a instanceof RemoteExecutionEnv);
  assert.equal(a.cwd, cwd);
  assert.equal(a.id, b.id);
  assert.notEqual(a.id, c.id);
  assert.notEqual(a.connection, b.connection);
  assert.deepEqual(targets, [sshTarget, sshTarget, { ...sshTarget, port: 2222 }]);
  target.host = "changed";
  assert.deepEqual(targets[0], sshTarget);
  const close = t.mock.method(a.connection, "close");
  await a.cleanup(context);
  assert.equal(close.mock.callCount(), 1);
  const result = await b.exec(["true"], {}, context);
  assert(result.ok);
  assert.equal(result.value.exitCode, 0);

  const failure = new Error("cleanup failure");
  const cleanup = t.mock.method(RemoteExecutionEnv.prototype, "cleanup", async () => {
    throw failure;
  });
  await assert.rejects(a.cleanup(context), (error: unknown) => error === failure);
  assert.equal(close.mock.callCount(), 2);
  cleanup.mock.restore();
});

await test("minimal SSH targets use lazy upstream defaults and validate before connection construction", async (t) => {
  const target = { host: "guest", knownHostsFile: "/known_hosts", hostKeyAlias: "guest" };
  const env = new api.SshExecutionEnv({ target, cwd: "/workspace" });
  t.after(() => env.cleanup(context));
  assert(env.connection instanceof Connection);
  const calls: SshConnectOptions[] = [];
  const connect = (value: SshConnectOptions) => {
    calls.push(value);
    return { connection: new Connection({ command: [localDaemon()] }), remote: () => undefined };
  };
  const other = new api.SshExecutionEnv({ target, cwd: "/", connect });
  t.after(() => other.cleanup(context));
  assert.deepEqual(calls, [target]);
  assert.throws(
    () => new api.SshExecutionEnv({ target: { ...target, host: "-option" }, cwd: "/", connect }),
  );
  assert.equal(calls.length, 1);
});

await test("env selection is rewindable, forks at the selected entry, and survives SQLite reopen", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "env-document-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "session.sqlite");
  let harness = await api.openHarness(
    await openNodeSqliteStorage(path),
    { models: createModels() },
    context,
  );
  t.after(() => harness.close(context));
  const first = { type: "ssh" as const, ...sshTarget };
  const second = { ...first, host: "other-host" };
  const root = await harness.root(context, {
    agent: { cwd: "/first" },
    async init(tx, id) {
      (await tx.doc(api.Env, id)).env = first;
    },
  });
  const at = await root.commit((tx) => tx.appendEntry(root.id, { kind: "app.marker" }), context);
  await root.commit(async (tx) => {
    (await tx.doc(api.Env, root.id)).env = second;
  }, context);
  const fork = await root.fork(at.id, { ownership: { kind: "ownerless" } }, context);
  assert.deepEqual(await harness.snapshot(api.Env, fork.id, context), { env: first });
  assert.deepEqual(await harness.snapshot(api.Env, root.id, context), { env: second });
  await harness.close(context);
  harness = await api.openHarness(
    await openNodeSqliteStorage(path),
    { models: createModels() },
    context,
  );
  assert.deepEqual(await harness.snapshot(api.Env, root.id, context), { env: second });
  assert.deepEqual(await harness.snapshot(api.Env, fork.id, context), { env: first });
  const reopened = await harness.conversation(root.id, context);
  assert(reopened);
  assert.equal((await reopened.agent(context)).cwd, "/first");
});

await test("document changes do not mutate or close a borrowed environment or cancel its in-flight command", async (t) => {
  const selected = { type: "ssh" as const, ...sshTarget };
  const env = new api.SshExecutionEnv({
    target: selected,
    cwd: "/",
    connect: () => ({
      connection: new Connection({ command: [localDaemon()] }),
      remote: () => undefined,
    }),
  });
  const harness = await api.openHarness(new MemoryStorage(), { models: createModels() }, context);
  const root = await harness.root(context, {
    async init(tx, id) {
      (await tx.doc(api.Env, id)).env = selected;
    },
  });
  const controller = new AbortController();
  t.after(async () => {
    controller.abort();
    await harness.close(context);
    await env.cleanup(context);
  });
  const started = Promise.withResolvers<void>();
  const request = env.connection.request.bind(env.connection);
  t.mock.method(env.connection, "request", (...[op, value, options]: Parameters<typeof request>) =>
    request(op, value, {
      ...options,
      onStart(id, session) {
        options?.onStart?.(id, session);
        if (op === "exec") started.resolve();
      },
    }),
  );
  const close = t.mock.method(env.connection, "close");
  const kill = t.mock.method(env.connection, "kill");
  const identity = env.id;
  let settled = false;
  const running = env
    .exec(["sleep", "1000"], {}, withAbortSignal(controller.signal, context))
    .finally(() => {
      settled = true;
    });
  await started.promise;
  for (const target of [{ ...selected, host: "other-host" }, undefined]) {
    await root.commit(async (tx) => {
      const draft = await tx.doc(api.Env, root.id);
      if (target === undefined) delete draft.env;
      else draft.env = target;
    }, context);
    assert.equal(env.id, identity);
    assert.equal(env.cwd, "/");
    assert.equal(settled, false);
    assert.equal(close.mock.callCount(), 0);
    assert.equal(kill.mock.callCount(), 0);
  }
  controller.abort();
  const result = await running;
  assert.equal(result.ok, false);
  assert.equal(settled, true);
});

await test("task-owned children copy env data before the caller's creation hook, without sharing drafts", async (t) => {
  let creations = 0;
  const harness = await api.openHarness(
    new MemoryStorage(),
    {
      models: createModels(),
      async conversationCreated(tx, record) {
        creations++;
        if (record.owner) {
          const selected = (await tx.doc(api.Env, record.id)).env;
          assert.deepEqual(selected, (await tx.doc(api.Env, record.owner.conversationId)).env);
        }
      },
    },
    context,
  );
  t.after(() => harness.close(context));
  const root = await harness.root(context);
  const taskId = await root.commit(
    (tx) =>
      tx.createTask(
        CompactionTask,
        { reason: "manual" },
        { conversationId: root.id, ownership: { kind: "conversation" } },
      ),
    context,
  );
  const empty = await harness.createConversation({ ownership: { kind: "task", taskId } }, context);
  assert.deepEqual(await harness.snapshot(api.Env, empty.id, context), {});
  const target = { type: "ssh" as const, ...sshTarget };
  await root.commit(async (tx) => {
    (await tx.doc(api.Env, root.id)).env = target;
  }, context);
  const child = await harness.createConversation({ ownership: { kind: "task", taskId } }, context);
  await child.commit(async (tx) => {
    const selected = (await tx.doc(api.Env, child.id)).env;
    assert(selected);
    selected.host = "child-only";
  }, context);
  assert.deepEqual(await harness.snapshot(api.Env, root.id, context), { env: target });
  assert.deepEqual(await harness.snapshot(api.Env, child.id, context), {
    env: { ...target, host: "child-only" },
  });
  assert.equal(creations, 3);
});
