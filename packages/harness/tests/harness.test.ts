import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { defineDoc } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import {
  Connection,
  localDaemon,
  RemoteExecutionEnv,
  type SshConnectOptions,
} from "@earendil-works/pi-env";
import * as api from "../index.ts";

const context = BACKGROUND_CONTEXT;

await test("public API opens a native, paused harness with only the fixed coding extensions", async (t) => {
  assert.deepEqual(Object.keys(api).sort(), ["DrvRunEnv", "openHarness"]);
  const Marker = defineDoc<{ created: boolean }>({
    kind: "test.created",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "current",
    initial: () => ({ created: false }),
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
    ["coding-tools", "coding", "context"],
  );
  assert.deepEqual(agent.tools.map((tool) => tool.name).sort(), ["bash", "edit", "read", "write"]);
  assert.deepEqual(await harness.snapshot(Marker, root.id, context), { created: true });
  assert.equal((await harness.inspect(context)).scheduling, "paused");
  assert.equal(resolutions, 0);
});

await test("harness reads live settings rather than freezing them at open", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "harness-settings-"));
  const env = new NodeExecutionEnv({
    cwd,
    shellEnv: { ...process.env, HOME: cwd, XDG_CONFIG_HOME: cwd, XDG_CONFIG_DIRS: cwd },
  });
  const faux = fauxProvider({ models: [{ id: "test" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  let transport: "sse" | "websocket" = "sse";
  const harness = await api.openHarness(
    new MemoryStorage(),
    {
      models,
      env: () => env,
      settings: {
        get stream() {
          return { transport };
        },
      },
    },
    context,
  );
  t.after(async () => {
    await harness.close(context);
    await env.cleanup(context);
    await rm(cwd, { recursive: true, force: true });
  });
  const root = await harness.root(context, {
    agent: { model: { provider: "faux", modelId: "test" }, cwd },
  });
  const observed: unknown[] = [];
  for (const value of ["sse", "websocket"] as const) {
    transport = value;
    faux.setResponses([
      (_input, options) => {
        observed.push(options?.transport);
        return fauxAssistantMessage("Done.");
      },
    ]);
    await root.submit({ type: "input", content: "Hello." }, context);
    await root.waitForIdle(context);
  }
  assert.deepEqual(observed, ["sse", "websocket"]);
});

await test("DrvRunEnv owns its route and connection; cleanup leaves other environments usable", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "drv-run-env-"));
  const targets: SshConnectOptions[] = [];
  const options = {
    instance: "test1",
    runtimeDirectory: "/run/user/1000",
    cwd,
    connect(target: SshConnectOptions) {
      targets.push(target);
      return { connection: new Connection({ command: [localDaemon()] }), remote: () => undefined };
    },
  };
  const a = new api.DrvRunEnv(options);
  const b = new api.DrvRunEnv(options);
  t.after(async () => {
    await a.cleanup(context);
    await b.cleanup(context);
    await rm(cwd, { recursive: true, force: true });
  });
  assert(a instanceof RemoteExecutionEnv);
  assert.equal(a.id, "drv.run.test1");
  assert.equal(a.cwd, cwd);
  assert.notEqual(a.connection, b.connection);
  assert.equal(targets.length, 2);
  assert.deepEqual(targets[0], {
    host: "drv.run.test1",
    user: "root",
    ssh: "ssh",
    configFile: "/etc/ssh/ssh_config",
    identityFile: "/run/user/1000/drv.run.test1/client-key",
    knownHostsFile: "/run/user/1000/drv.run.test1/known_hosts",
    hostKeyAlias: "drv.run.test1",
  });
  const close = t.mock.method(a.connection, "close");
  await a.cleanup(context);
  assert.equal(close.mock.callCount(), 1);
  const result = await b.exec(["true"], {}, context);
  assert(result.ok);
  assert.equal(result.value.exitCode, 0);
  for (const instance of ["../test1", "-test", "test;echo", ""]) {
    assert.throws(() => new api.DrvRunEnv({ ...options, instance }), TypeError);
  }
  assert.throws(() => new api.DrvRunEnv({ ...options, cwd: "relative" }), TypeError);
  assert.equal(targets.length, 2);
});
