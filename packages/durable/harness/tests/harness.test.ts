import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { defineDoc } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import {
  Connection,
  localDaemon,
  RemoteExecutionEnv,
  type SshConnectOptions,
} from "@earendil-works/pi-env";
import * as api from "durable-harness";

const context = BACKGROUND_CONTEXT;

await test("public API opens a native, paused harness with the fixed extensions", async (t) => {
  assert.deepEqual(Object.keys(api).sort(), ["DrvRunEnv", "Review", "openHarness"]);
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

await test("DrvRunEnv owns its route and connection; cleanup leaves other environments usable", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "drv-run-env-"));
  const targets: SshConnectOptions[] = [];
  const options = {
    instance: "test1",
    runtimeDirectory: "/run/user/1000",
    cwd,
    connect(target: SshConnectOptions) {
      targets.push(target);
      return {
        connection: new Connection({ command: [localDaemon()] }),
        remote: () => undefined,
      };
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
