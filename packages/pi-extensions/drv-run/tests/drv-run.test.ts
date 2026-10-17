import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Connection, RemoteExecutionEnv, sshArguments } from "@earendil-works/pi-env";
import { localIntegration } from "../../../pi-runtime/index.ts";
import { code, exists, model } from "../../../pi-runtime/testing.ts";
import { createDrvRunIntegration, listInstances } from "../index.ts";
import { remoteFixture } from "./fixture.ts";

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
  assert.equal((await f.integration.targets()).filter((target) => target.available).length, 1);
  assert.deepEqual(
    await listInstances({ ...f.options, stateDirectory: join(f.directory, "missing") }),
    [],
  );
  await assert.rejects(listInstances({ ...f.options, systemctl: join(f.directory, "missing") }));
});

await test("binding validation rejects stopped, absent and malformed targets", async (t) => {
  const f = await remoteFixture(t);
  await f.integration.validate(f.binding);
  for (const target of ["../test1", "-test", "test;echo", ""]) {
    await assert.rejects(f.integration.validate({ ...f.binding, target }), code("invalid"));
  }
  await assert.rejects(f.integration.validate({ ...f.binding, cwd: "/tmp" }), code("invalid"));
  await assert.rejects(
    f.integration.validate({ ...f.binding, provider: "local" }),
    code("invalid"),
  );
  await assert.rejects(
    f.integration.validate({ ...f.binding, target: "missing" }),
    code("unavailable"),
  );
  await writeFile(f.states, "{}");
  await assert.rejects(f.integration.validate(f.binding), code("unavailable"));
  assert.equal(f.connections.length, 0);
});

await test("lease pins the owner route and host key, uses /workspace and cleans up the connection", async (t) => {
  const f = await remoteFixture(t);
  const lease = await f.integration.open(f.binding);
  t.after(() => lease.close());
  assert(lease.env instanceof RemoteExecutionEnv);
  assert.equal(lease.env.cwd, "/workspace");
  assert.equal(lease.env.id, "drv.run.test1");
  assert.deepEqual(f.sshOptions, [
    {
      host: "drv.run.test1",
      user: "root",
      ssh: "ssh",
      configFile: "/etc/ssh/ssh_config",
      identityFile: join(f.options.runtimeDirectory, "drv.run.test1", "client-key"),
      knownHostsFile: join(f.options.runtimeDirectory, "drv.run.test1", "known_hosts"),
      hostKeyAlias: "drv.run.test1",
    },
  ]);
  const args = sshArguments(f.sshOptions[0]);
  assert(args.includes("StrictHostKeyChecking=yes"));
  assert(args.includes("IdentitiesOnly=yes"));
  assert(args.includes("GlobalKnownHostsFile=none"));
  assert(args.includes("PermitLocalCommand=no"));
  const close = t.mock.method(f.connections[0], "close");
  await lease.close();
  assert.equal(close.mock.callCount(), 1);
});

await test("faux turns use the daemon for read/write/edit; extension removal preserves history and forbids local fallback", async (t) => {
  const f = await remoteFixture(t);
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
  const session = await f.sessions.create(randomUUID(), f.binding, model);
  assert(
    (await session.root.agent(context)).extensions.some(
      (extension) => extension.name === "drv.run",
    ),
  );
  await session.prompt("Use the remote filesystem.", randomUUID());
  await session.root.waitForIdle(context);
  assert.equal(JSON.parse(await readFile(file, "utf8")), 2);
  assert.equal(f.connections.length, 1);
  const history = await session.history();
  const results = history
    .flatMap((entry) => entry.model ?? [])
    .filter((message) => message.role === "toolResult");
  assert.equal(results.length, 3);
  assert(results.every((result) => !result.isError));
  await f.reopen([localIntegration(f.workspace)]);
  const restored = await f.sessions.get(session.id);
  assert.deepEqual(await restored.history(), history);
  await assert.rejects(restored.prompt("Try local instead.", randomUUID()), code("unavailable"));
  await assert.rejects(restored.resume(), code("unavailable"));
  assert.equal(f.faux.state.callCount, 4);
  assert.equal((await f.sessions.catalog()).sessions.length, 1);
});

await test("codemode nested tools use the bound remote daemon", async (t) => {
  const f = await remoteFixture(t);
  const file = join(f.workspace, "codemode-remote.json");
  f.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("codemode", {
        code: `
      await tools.write({ path: ${JSON.stringify(file)}, content: "1" });
      await tools.edit({ path: ${JSON.stringify(file)}, edits: [{ oldText: "1", newText: "2" }] });
      await tools.read({ path: ${JSON.stringify(file)} });
    `,
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Done."),
  ]);
  const session = await f.sessions.create(randomUUID(), f.binding, model);
  await session.prompt("Use codemode in the guest.", randomUUID());
  await session.root.waitForIdle(context);
  const results = (await session.history())
    .flatMap((entry) => entry.model ?? [])
    .filter((message) => message.role === "toolResult");
  assert.equal(results.length, 1);
  assert.equal(results[0].toolName, "codemode");
  assert.equal(results[0].isError, false);
  assert.equal(JSON.parse(await readFile(file, "utf8")), 2);
  assert.equal(f.connections.length, 1);
});

await test("stopping an instance blocks existing sessions without opening another connection", async (t) => {
  const f = await remoteFixture(t);
  const session = await f.sessions.create(randomUUID(), f.binding, model);
  await rm(join(f.options.runtimeDirectory, "drv.run.test1", "client.conf"));
  await assert.rejects(session.prompt("Work.", randomUUID()), code("unavailable"));
  await assert.rejects(session.resume(), code("unavailable"));
  assert.equal(f.connections.length, 0);
  assert.equal(f.faux.state.callCount, 0);
  assert.equal((await session.history()).length, 0);
});

await test("transport failure returns a failed tool result without touching local files", async (t) => {
  const f = await remoteFixture(t);
  const integration = createDrvRunIntegration({
    ...f.options,
    connect: () => ({
      connection: new Connection({ command: [join(f.directory, "missing-ssh")] }),
      remote: () => undefined,
    }),
  });
  await f.reopen([integration]);
  const file = join(f.workspace, "never.json");
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("write", { path: file, content: "1" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("Failed."),
  ]);
  const session = await f.sessions.create(randomUUID(), f.binding, model);
  await session.prompt("Work.", randomUUID());
  await session.root.waitForIdle(context);
  assert.equal(await exists(file), false);
  const results = (await session.history())
    .flatMap((entry) => entry.model ?? [])
    .filter((message) => message.role === "toolResult");
  assert.equal(results.length, 1);
  assert.equal(results[0].isError, true);
});

await test("repository inspection uses the guest environment and fails closed when stopped", async (t) => {
  const f = await remoteFixture(t);
  const session = await f.sessions.create(randomUUID(), f.binding, model);
  const exec = t.mock.method(RemoteExecutionEnv.prototype, "exec");
  await session.repository();
  assert.equal(exec.mock.callCount(), 1);
  assert.equal(exec.mock.calls[0].arguments[1]?.cwd, "/workspace");
  assert.equal(f.connections.length, 1);
  assert.equal(f.faux.state.callCount, 0);
  await writeFile(f.states, JSON.stringify({ test1: "inactive" }));
  assert.deepEqual(await session.repository(), { state: "unavailable" });
  assert.equal(exec.mock.callCount(), 1);
});
