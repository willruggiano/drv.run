import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, section } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import {
  Sessions,
  localIntegration,
  loadIntegrations,
  stateDirectory,
  type Integration,
} from "./index.ts";
import { fixture, code, exists, model, waitFor } from "./testing.ts";

const context = BACKGROUND_CONTEXT;

await test("local creation validates directories, models, IDs and bindings before opening storage", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.sessions.create("bad", f.binding, model), code("invalid"));
  await assert.rejects(
    f.sessions.create(randomUUID(), { ...f.binding, provider: "missing" }, model),
    code("unavailable"),
  );
  await assert.rejects(
    f.sessions.create(randomUUID(), { ...f.binding, cwd: "." }, model),
    code("invalid"),
  );
  await assert.rejects(
    f.sessions.create(randomUUID(), f.binding, { provider: "missing", modelId: "missing" }),
    code("invalid"),
  );
  assert.equal((await f.sessions.catalog()).sessions.length, 0);
  assert.equal(f.faux.state.callCount, 0);
});

await test("distinct local sessions keep their directories across a restart in a different directory", async (t) => {
  const f = await fixture(t);
  const second = join(f.workspace, "second");
  await mkdir(second);
  const binding = { provider: "local", target: second, cwd: second };
  const a = await f.create();
  const b = await f.sessions.create(randomUUID(), binding, model);
  await assert.rejects(f.sessions.create(a.id, binding, model), code("conflict"));
  await f.reopen([localIntegration(second)]);
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("write", { path: "where.json", content: "1" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("Done."),
    fauxAssistantMessage(fauxToolCall("write", { path: "where.json", content: "2" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("Done."),
  ]);
  for (const id of [a.id, b.id]) {
    const session = await f.sessions.get(id);
    await session.prompt("Write in your directory.", randomUUID());
    await session.root.waitForIdle(context);
  }
  assert.equal(JSON.parse(await readFile(join(f.workspace, "where.json"), "utf8")), 1);
  assert.equal(JSON.parse(await readFile(join(second, "where.json"), "utf8")), 2);
  assert.deepEqual((await (await f.sessions.get(a.id)).info()).binding, f.binding);
  assert.deepEqual((await (await f.sessions.get(b.id)).info()).binding, binding);
});

await test("missing integrations preserve history, cannot prompt or resume, and never acquire local tools", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  f.faux.setResponses([fauxAssistantMessage("Done.")]);
  await session.prompt("Work.", randomUUID());
  await session.root.waitForIdle(context);
  const history = await session.history();
  await f.reopen([]);
  const restored = await f.sessions.get(session.id);
  assert.deepEqual(await restored.history(), history);
  assert.equal((await f.sessions.catalog()).sessions.length, 1);
  assert.equal((await f.sessions.catalog()).targets.length, 0);
  await assert.rejects(restored.prompt("Work.", randomUUID()), code("unavailable"));
  await assert.rejects(restored.resume(), code("unavailable"));
  assert.equal(f.faux.state.callCount, 1);
});

await test("removed local directories are unavailable without losing readable sessions", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  await rm(f.workspace, { recursive: true });
  await assert.rejects(session.prompt("Work.", randomUUID()), code("unavailable"));
  await assert.rejects(session.resume(), code("unavailable"));
  assert.equal((await session.history()).length, 0);
  assert.equal((await f.sessions.catalog()).sessions.length, 1);
});

await test("integration leases are lazy, shared by concurrent tools, scoped and closed exactly once", async (t) => {
  const f = await fixture(t);
  let opens = 0,
    closes = 0,
    validations = 0;
  const base = localIntegration(f.workspace);
  const extension = defineExtension({
    name: "test.instructions",
    sections: [section("test", () => "Use the project directory.")],
  });
  const integration: Integration = {
    ...base,
    extensions: [extension],
    async validate(binding) {
      validations++;
      await base.validate(binding);
    },
    async open(binding) {
      opens++;
      const lease = await base.open(binding);
      return {
        env: lease.env,
        async close() {
          closes++;
          await lease.close();
        },
      };
    },
  };
  await f.reopen([integration]);
  const session = await f.create();
  assert.equal(opens, 0);
  await session.history();
  await f.sessions.catalog();
  assert.equal(opens, 0);
  assert(
    (await session.root.agent(context)).extensions.some((item) => item.name === extension.name),
  );
  f.faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("write", { path: "a.json", content: "1" }),
        fauxToolCall("write", { path: "b.json", content: "2" }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Done."),
  ]);
  await session.prompt("Write both files.", randomUUID());
  await session.root.waitForIdle(context);
  assert.equal(opens, 1);
  assert(validations >= 4); // create, prompt, generation and each tool call
  assert.equal(await exists(join(f.workspace, "a.json")), true);
  assert.equal(await exists(join(f.workspace, "b.json")), true);
  await Promise.all([f.sessions.close(), f.sessions.close()]);
  assert.equal(closes, 1);
  await assert.rejects(f.create(), code("closing"));
});

await test("integration acquisition failure is a tool error, never a local fallback; a later attempt can retry", async (t) => {
  const f = await fixture(t);
  let attempts = 0;
  const base = localIntegration(f.workspace);
  await f.reopen([
    {
      ...base,
      open(binding) {
        attempts++;
        // Generation also asks for an environment, but ignores acquisition failure.
        if (attempts <= 2) throw new Error("Connection unavailable.");
        return base.open(binding);
      },
    },
  ]);
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("write", { path: "never.json", content: "1" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("Failed."),
  ]);
  const session = await f.create();
  await session.prompt("Try writing.", randomUUID());
  await session.root.waitForIdle(context);
  const results = (await session.history())
    .flatMap((entry) => entry.model ?? [])
    .filter((message) => message.role === "toolResult");
  assert.equal(results.length, 1);
  assert.equal(results[0].isError, true);
  assert.equal(await exists(join(f.workspace, "never.json")), false);
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("write", { path: "retry.json", content: "2" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("Done."),
  ]);
  await session.prompt("Try again.", randomUUID());
  await session.root.waitForIdle(context);
  assert.equal(JSON.parse(await readFile(join(f.workspace, "retry.json"), "utf8")), 2);
});

await test("availability is checked again for tools, not just at prompt admission", async (t) => {
  const f = await fixture(t);
  let available = true;
  const base = localIntegration(f.workspace);
  await f.reopen([
    {
      ...base,
      async validate(binding) {
        assert(available);
        await base.validate(binding);
      },
    },
  ]);
  f.faux.setResponses([
    () => {
      available = false;
      return fauxAssistantMessage(fauxToolCall("write", { path: "never.json", content: "1" }), {
        stopReason: "toolUse",
      });
    },
    fauxAssistantMessage("Failed."),
  ]);
  const session = await f.create();
  await session.prompt("Work.", randomUUID());
  await session.root.waitForIdle(context);
  assert.equal(await exists(join(f.workspace, "never.json")), false);
  const results = (await session.history())
    .flatMap((entry) => entry.model ?? [])
    .filter((message) => message.role === "toolResult");
  assert.equal(results[0].isError, true);
});

await test("local environment cleanup and identity follow Durable's contract", async (t) => {
  const f = await fixture(t);
  const local = localIntegration(f.workspace);
  const lease = await local.open(f.binding);
  assert(lease.env instanceof NodeExecutionEnv);
  assert.equal(lease.env.cwd, f.workspace);
  assert.equal(lease.env.id, new NodeExecutionEnv({ cwd: f.directory }).id);
  await lease.close();
});

await test("explicit module loading validates factories and rejects duplicate integration identities", async (t) => {
  const f = await fixture(t);
  const module = join(f.workspace, "integration.mjs");
  await writeFile(
    module,
    'export default () => ({ id: "example", targets: async () => [], validate: async () => {}, open: () => { throw new Error(); } });',
  );
  const loaded = await loadIntegrations([module]);
  assert.equal(loaded[0].id, "example");
  assert.deepEqual(await loaded[0].targets(), []);
  const invalid = join(f.workspace, "invalid.mjs");
  await writeFile(invalid, "export default 42;");
  await assert.rejects(loadIntegrations([invalid]), assert.AssertionError);
  await assert.rejects(loadIntegrations([join(f.workspace, "missing.mjs")]));
  await assert.rejects(
    Sessions.open({ ...f.options, integrations: [...loaded, ...loaded] }),
    assert.AssertionError,
  );
});

await test("state directory follows absolute XDG_STATE_HOME without systemd", () => {
  assert.equal(stateDirectory({ XDG_STATE_HOME: "/state" }, "/home/test"), "/state");
  assert.equal(
    stateDirectory({ XDG_STATE_HOME: "relative" }, "/home/test"),
    "/home/test/.local/state",
  );
  assert.equal(stateDirectory({}, "/home/test"), "/home/test/.local/state");
});

await test("concurrent creation is idempotent", async (t) => {
  const f = await fixture(t);
  const id = randomUUID();
  const results = await Promise.all(
    Array.from({ length: 8 }, () => f.sessions.create(id, f.binding, model)),
  );
  for (const result of results) assert.equal(result, results[0]);
  assert.equal((await f.sessions.catalog()).sessions.length, 1);
  const before = await results[0].info();
  await f.reopen();
  assert.deepEqual(await (await f.sessions.get(id)).info(), before);
});

await test("local coding tools use the bound directory, not the state directory", async (t) => {
  const f = await fixture(t);
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("write", { path: "state.json", content: '{"value":1}' }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage(fauxToolCall("edit", { path: "state.json", oldText: "1", newText: "2" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage(
      fauxToolCall("bash", { command: "test -f state.json && touch command-ran" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(fauxToolCall("read", { path: "state.json" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Done."),
  ]);
  const session = await f.sessions.create(randomUUID(), f.binding, model);
  await session.prompt("Exercise the coding tools.", randomUUID());
  await session.root.waitForIdle(context);
  assert.deepEqual(JSON.parse(await readFile(join(f.workspace, "state.json"), "utf8")), {
    value: 2,
  });
  assert.equal(await exists(join(f.workspace, "command-ran")), true);
  assert.equal(await exists(join(f.directory, "state.json")), false);
  const messages = (await session.history()).flatMap((entry) => entry.model ?? []);
  const results = messages.filter((message) => message.role === "toolResult");
  assert.equal(results.length, 4);
  assert.equal(
    results.every((result) => !result.isError),
    true,
  );
  assert.equal(f.faux.state.callCount, 5);
});

await test("opening persisted work is read-only until explicit resume, even when another session runs", async (t) => {
  const f = await fixture(t);
  const started = Promise.withResolvers<void>();
  f.faux.setResponses([
    async (_messages, options) => {
      assert(options?.signal);
      started.resolve();
      await new Promise<void>((resolve) => {
        if (options.signal?.aborted) resolve();
        else options.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return fauxAssistantMessage("", { stopReason: "aborted" });
    },
  ]);
  const session = await f.sessions.create(randomUUID(), f.binding, model);
  await session.prompt("Work until interrupted.", randomUUID());
  await started.promise;
  await f.reopen();
  const restored = await f.sessions.get(session.id);
  assert.equal(restored.needsResume, true);
  await restored.history();
  await f.sessions.catalog();
  assert.equal(f.faux.state.callCount, 1);
  await assert.rejects(restored.prompt("New work", randomUUID()), code("conflict"));
  await assert.rejects(restored.stop(), code("conflict"));
  f.faux.setResponses([fauxAssistantMessage("Other session."), fauxAssistantMessage("Resumed.")]);
  const other = await f.sessions.create(randomUUID(), f.binding, model);
  await other.prompt("Independent work", randomUUID());
  await other.root.waitForIdle(context);
  assert.equal(f.faux.state.callCount, 2);
  assert.equal(restored.needsResume, true);
  assert.equal((await restored.harness.inspect(context)).scheduling, "paused");
  await restored.resume();
  await restored.root.waitForIdle(context);
  assert.equal(restored.needsResume, false);
  assert.equal(f.faux.state.callCount, 3);
  assert.equal((await restored.harness.inspect(context)).tasks.length, 0);
});

await test("stop aborts a running local process group", async (t) => {
  const f = await fixture(t);
  f.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("bash", { command: "touch started; sleep 30; touch finished" }),
      { stopReason: "toolUse" },
    ),
  ]);
  const session = await f.sessions.create(randomUUID(), f.binding, model);
  await session.prompt("Run a long command.", randomUUID());
  await waitFor(() => exists(join(f.workspace, "started")));
  await session.stop();
  assert.equal((await session.harness.inspect(context)).tasks.length, 0);
  assert.equal(await exists(join(f.workspace, "finished")), false);
});
