import { defineDoc } from "@earendil-works/pi-durable";
import { openCodingSessions } from "./coding.ts";
import * as runtime from "./index.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  Harness,
  createRegistry,
  defineExtension,
  section,
  type Conversation,
} from "@earendil-works/pi-durable";
import type { CodemodeToolDetails } from "@earendil-works/pi-durable/codemode";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Sessions, SessionError, stateDirectory } from "./index.ts";
import { fixture, code, exists, model, waitFor } from "./testing.ts";

const context = BACKGROUND_CONTEXT;

await test("creation is read-only and validates persistence identities and model defaults", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.sessions.create("bad", f.binding, model), code("invalid"));
  await assert.rejects(
    f.sessions.create(randomUUID(), f.binding, { provider: "missing", modelId: "missing" }),
    code("invalid"),
  );
  const session = await f.create();
  assert.equal((await session.harness.inspect(context)).scheduling, "paused");
  assert.equal(f.faux.state.callCount, 0);
  await assert.rejects(
    f.sessions.create(session.id, { ...f.binding, target: "/other" }, model),
    code("conflict"),
  );
});

await test("environment selection persists independently and forks inherit selection at the entry", async (t) => {
  const f = await fixture(t);
  const second = join(f.workspace, "second");
  await mkdir(second);
  const session = await f.create();
  const one = await session.root.submit(
    { type: "write", entry: { kind: "marker", data: { value: 1 } } },
    context,
  );
  const entry = (await one.status(context)).entry;
  assert(entry !== undefined);
  const binding = { provider: "local", target: second, cwd: second };
  await runtime.selectEnvironment(session, binding);
  const fork = await session.root.fork(entry, { ownership: { kind: "ownerless" } }, context);
  assert.deepEqual(await session.harness.snapshot(runtime.Environment, fork.id, context), {
    provider: "local",
    target: f.workspace,
  });
  assert.equal((await fork.agent(context)).cwd, f.workspace);
  assert.deepEqual(await session.harness.snapshot(runtime.Environment, session.root.id, context), {
    provider: "local",
    target: second,
  });
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("write", { path: "where.json", content: "1" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage(fauxToolCall("write", { path: "where.json", content: "1" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("Done."),
  ]);
  await fork.submit({ type: "input", content: "Write the selected file." }, context);
  await fork.waitForIdle(context);
  assert.equal(JSON.parse(await readFile(join(f.workspace, "where.json"), "utf8")), 1);
  assert.equal(await exists(join(second, "where.json")), false);
  await f.reopen();
  const restored = await f.sessions.get(session.id);
  assert.deepEqual(await restored.harness.snapshot(runtime.Environment, session.root.id, context), {
    provider: "local",
    target: second,
  });
  assert.deepEqual(await restored.harness.snapshot(runtime.Environment, fork.id, context), {
    provider: "local",
    target: f.workspace,
  });
  assert.equal((await restored.harness.inspect(context)).scheduling, "paused");
});

await test("missing environments preserve history and permit upstream progress without local fallback", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  f.faux.setResponses([fauxAssistantMessage("Done.")]);
  await session.root.submit({ type: "input", content: "Work." }, context);
  await session.root.waitForIdle(context);
  const before = await runtime.history(session);
  await f.reopen({ env: undefined, targets: async () => [] });
  const restored = await f.sessions.get(session.id);
  assert.deepEqual(await runtime.history(restored), before);
  assert.equal((await f.sessions.catalog()).sessions.length, 1);
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("write", { path: "never.json", content: "1" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("Unavailable."),
  ]);
  await restored.root.submit({ type: "input", content: "Try the missing environment." }, context);
  await restored.root.waitForIdle(context);
  assert.equal(await exists(join(f.workspace, "never.json")), false);
  const results = (await runtime.history(restored))
    .flatMap((entry) => entry.model ?? [])
    .filter((message) => message.role === "toolResult");
  assert.equal(results.length, 1);
  assert.equal(results[0].isError, true);
  restored.harness.resume();
});

await test("application environment ownership is lazy and closes after all harnesses stop", async (t) => {
  const f = await fixture(t);
  let resolutions = 0,
    closes = 0;
  await f.reopen({
    env: async (target, context) => {
      resolutions++;
      return f.options.env(target, context);
    },
    close: async () => {
      closes++;
      await f.options.close();
    },
  });
  const a = await f.create(),
    b = await f.create();
  await runtime.history(a);
  await f.sessions.catalog();
  assert.equal(resolutions, 0);
  f.faux.setResponses([fauxAssistantMessage("Done.")]);
  await a.root.submit({ type: "input", content: "Hello." }, context);
  await a.root.waitForIdle(context);
  assert(resolutions > 0);
  await a.harness.close(context);
  assert.equal(closes, 0);
  assert.equal((await b.harness.inspect(context)).scheduling, "paused");
  await Promise.all([f.sessions.close(), f.sessions.close()]);
  assert.equal(closes, 1);
  await assert.rejects(f.create(), code("closing"));
});

await test("environment failure is a tool failure and a later attempt can resolve again", async (t) => {
  const f = await fixture(t);
  let available = false;
  await f.reopen({
    env: async (target, context) => {
      if (!available) throw new SessionError("unavailable", "Disconnected.");
      return f.options.env(target, context);
    },
  });
  const session = await f.create();
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("write", { path: "never.json", content: "1" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("Unavailable."),
  ]);
  await session.root.submit({ type: "input", content: "Try writing." }, context);
  await session.root.waitForIdle(context);
  assert.equal(await exists(join(f.workspace, "never.json")), false);
  assert.equal(
    (await runtime.history(session))
      .flatMap((entry) => entry.model ?? [])
      .filter((message) => message.role === "toolResult")[0].isError,
    true,
  );
  available = true;
  f.faux.setResponses([fauxAssistantMessage("Reconnected.")]);
  await session.root.submit({ type: "input", content: "Continue." }, context);
  await session.root.waitForIdle(context);
  assert.equal((await session.harness.inspect(context)).tasks.length, 0);
});

await test("harness management accepts an application registry without coding or environments", async (t) => {
  const f = await fixture(t);
  const registry = createRegistry();
  const extension = defineExtension({
    name: "custom",
    sections: [section("custom", () => "Custom agent.")],
  });
  registry.install(extension);
  const sessions = await Sessions.open({
    directory: join(f.directory, "plain"),
    models: f.options.models,
    open: (storage) =>
      Harness.open(
        storage,
        { models: f.options.models, registry, settings: { extensions: [extension] } },
        context,
      ),
  });
  t.after(() => sessions.close());
  const session = await sessions.create(randomUUID());
  assert.equal((await runtime.sessionInfo(session)).binding, undefined);
  assert.equal((await session.root.agent(context)).model, undefined);
  await session.root.configure({ model }, context);
  assert.deepEqual(
    (await session.root.agent(context)).extensions.map((item) => item.name),
    ["custom"],
  );
  assert.deepEqual((await session.root.agent(context)).tools, []);
  f.faux.setResponses([fauxAssistantMessage("Independent agent.")]);
  await session.root.submit({ type: "input", content: "Hello." }, context);
  await session.root.waitForIdle(context);
  assert.equal(f.faux.state.callCount, 1);
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
  const before = await runtime.sessionInfo(results[0]);
  await f.reopen();
  assert.deepEqual(await runtime.sessionInfo(await f.sessions.get(id)), before);
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
  await session.root.submit(
    { type: "input", content: "Exercise the coding tools.", requestId: randomUUID() },
    context,
  );
  await session.root.waitForIdle(context);
  assert.deepEqual(JSON.parse(await readFile(join(f.workspace, "state.json"), "utf8")), {
    value: 2,
  });
  assert.equal(await exists(join(f.workspace, "command-ran")), true);
  assert.equal(await exists(join(f.directory, "state.json")), false);
  const messages = (await runtime.history(session)).flatMap((entry) => entry.model ?? []);
  const results = messages.filter((message) => message.role === "toolResult");
  assert.equal(results.length, 4);
  assert.equal(
    results.every((result) => !result.isError),
    true,
  );
  assert.equal(f.faux.state.callCount, 5);
});

await test("codemode is enabled and runs parallel coding tools in the bound directory", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  assert(
    (await session.root.agent(context)).extensions.some(
      (extension) => extension.name === "codemode",
    ),
  );
  f.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("codemode", {
        code: `
      if (typeof process !== "undefined" || typeof require !== "undefined") throw new Error("Host globals leaked");
      await Promise.all([
        tools.write({ path: "code.json", content: '{"value":1}' }),
        tools.write({ path: "parallel.json", content: '2' }),
      ]);
      await tools.edit({ path: "code.json", edits: [{ oldText: "1", newText: "3" }] });
      await Promise.all([
        tools.read({ path: "code.json" }),
        tools.bash({ command: "test -f code.json && touch code-ran" }),
      ]);
      return { done: true };
    `,
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Done."),
  ]);
  await session.root.submit(
    { type: "input", content: "Use codemode.", requestId: randomUUID() },
    context,
  );
  await session.root.waitForIdle(context);
  const history = await runtime.history(session);
  const results = history
    .flatMap((entry) => entry.model ?? [])
    .filter((message) => message.role === "toolResult");
  assert.equal(results.length, 1);
  assert.equal(results[0].toolName, "codemode");
  assert.equal(results[0].isError, false);
  const details = results[0].details as CodemodeToolDetails;
  assert.deepEqual(
    details.calls.map((call) => [call.name, call.status]),
    [
      ["write", "ok"],
      ["write", "ok"],
      ["edit", "ok"],
      ["read", "ok"],
      ["bash", "ok"],
    ],
  );
  assert.deepEqual(JSON.parse(await readFile(join(f.workspace, "code.json"), "utf8")), {
    value: 3,
  });
  assert.equal(JSON.parse(await readFile(join(f.workspace, "parallel.json"), "utf8")), 2);
  assert.equal(await exists(join(f.workspace, "code-ran")), true);
  assert.equal(await exists(join(f.directory, "code.json")), false);
  await f.reopen();
  const restored = await f.sessions.get(session.id);
  assert.deepEqual(await runtime.history(restored), history);
  f.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("codemode", {
        code: 'await tools.write({ path: "reopened.json", content: "4" });',
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Done."),
  ]);
  await restored.root.submit(
    { type: "input", content: "Use codemode after reopening.", requestId: randomUUID() },
    context,
  );
  await restored.root.waitForIdle(context);
  assert.equal(JSON.parse(await readFile(join(f.workspace, "reopened.json"), "utf8")), 4);
});

await test("codemode reports script and nested tool errors without breaking later runs", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  for (const source of [
    "const =",
    'throw new Error("Script failure")',
    'await tools.read({ path: "absent-file" });',
  ]) {
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("codemode", { code: source }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Failed."),
    ]);
    await session.root.submit(
      { type: "input", content: "Exercise a failure.", requestId: randomUUID() },
      context,
    );
    await session.root.waitForIdle(context);
    const result = (await runtime.history(session))
      .flatMap((entry) => entry.model ?? [])
      .filter((message) => message.role === "toolResult")
      .at(-1);
    assert.equal(result?.isError, true);
    assert.equal((await session.harness.inspect(context)).tasks.length, 0);
  }
  const result = (await runtime.history(session))
    .flatMap((entry) => entry.model ?? [])
    .filter((message) => message.role === "toolResult")
    .at(-1);
  assert(result);
  assert.equal((result.details as CodemodeToolDetails).calls[0].status, "error");
  f.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("codemode", {
        code: 'await tools.write({ path: "recovered.json", content: "true" });',
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Recovered."),
  ]);
  await session.root.submit(
    { type: "input", content: "Recover.", requestId: randomUUID() },
    context,
  );
  await session.root.waitForIdle(context);
  assert.equal(JSON.parse(await readFile(join(f.workspace, "recovered.json"), "utf8")), true);
});

await test(
  "stopping codemode aborts nested processes and a spinning JavaScript worker",
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t);
    const session = await f.create();
    for (const [marker, source] of [
      [
        "nested-started",
        'await tools.bash({ command: "touch nested-started; sleep 30; touch nested-finished" });',
      ],
      [
        "worker-started",
        'await tools.write({ path: "worker-started", content: "true" }); while (true) {}',
      ],
    ]) {
      f.faux.setResponses([
        fauxAssistantMessage(fauxToolCall("codemode", { code: source }), { stopReason: "toolUse" }),
      ]);
      await session.root.submit(
        { type: "input", content: "Run until stopped.", requestId: randomUUID() },
        context,
      );
      await waitFor(() => exists(join(f.workspace, marker)));
      await session.root.abort(context);
      assert.equal((await session.harness.inspect(context)).tasks.length, 0);
    }
    assert.equal(await exists(join(f.workspace, "nested-finished")), false);
  },
);

await test("opening persisted work is read-only; progress is scoped to its harness", async (t) => {
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
  await session.root.submit(
    { type: "input", content: "Work until interrupted.", requestId: randomUUID() },
    context,
  );
  await started.promise;
  await f.reopen();
  const restored = await f.sessions.get(session.id);
  assert.equal((await runtime.sessionInfo(restored)).needsResume, true);
  await runtime.rename(restored, "Interrupted work");
  assert.equal((await runtime.sessionInfo(restored)).name, "Interrupted work");
  await runtime.history(restored);
  await f.sessions.catalog();
  assert.equal(f.faux.state.callCount, 1);
  f.faux.setResponses([fauxAssistantMessage("Other session."), fauxAssistantMessage("Resumed.")]);
  const other = await f.sessions.create(randomUUID(), f.binding, model);
  await other.root.submit(
    { type: "input", content: "Independent work", requestId: randomUUID() },
    context,
  );
  await other.root.waitForIdle(context);
  assert.equal(f.faux.state.callCount, 2);
  assert.equal((await runtime.sessionInfo(restored)).needsResume, true);
  assert.equal((await restored.harness.inspect(context)).scheduling, "paused");
  restored.harness.resume();
  await restored.root.waitForIdle(context);
  assert.equal((await runtime.sessionInfo(restored)).needsResume, false);
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
  await session.root.submit(
    { type: "input", content: "Run a long command.", requestId: randomUUID() },
    context,
  );
  await waitFor(() => exists(join(f.workspace, "started")));
  await session.root.abort(context);
  assert.equal((await session.harness.inspect(context)).tasks.length, 0);
  assert.equal(await exists(join(f.workspace, "finished")), false);
});

await test("session names persist without changing bindings or starting work", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  await runtime.rename(session, "  Counter cleanup  ");
  assert.equal((await runtime.sessionInfo(session)).name, "Counter cleanup");
  assert.deepEqual((await runtime.sessionInfo(session)).binding, f.binding);
  for (const name of ["a".repeat(121), "line\nbreak", "null\0byte"])
    await assert.rejects(runtime.rename(session, name), code("invalid"));
  await f.reopen({ env: undefined, targets: async () => [] });
  const restored = await f.sessions.get(session.id);
  assert.equal((await runtime.sessionInfo(restored)).name, "Counter cleanup");
  await runtime.rename(restored, "<b>Plain text</b>");
  assert.equal((await runtime.sessionInfo(restored)).name, "<b>Plain text</b>");
  assert.equal(f.faux.state.callCount, 0);
  await runtime.rename(restored, "");
  assert.equal((await runtime.sessionInfo(restored)).name, "");
});

await test("footer repository inspection follows the bound directory without running the agent", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  assert.deepEqual(await runtime.repository(session), { state: "none" });
  const env = new NodeExecutionEnv({ cwd: f.workspace });
  t.after(() => env.cleanup(context));
  const git = async (...args: string[]) => {
    const result = await env.exec(["git", ...args], { timeout: 3 }, context);
    assert(result.ok);
    assert.equal(result.value.exitCode, 0);
  };
  await git("init", "--initial-branch=footer-test");
  assert.deepEqual(await runtime.repository(session), {
    state: "repository",
    branch: "footer-test",
    revision: null,
  });
  await git(
    "-c",
    "user.name=Pi",
    "-c",
    "user.email=pi@example.invalid",
    "commit",
    "--no-gpg-sign",
    "--allow-empty",
    "-m",
    "Initial",
  );
  const committed = await runtime.repository(session);
  assert.equal(committed.state, "repository");
  assert(committed.state === "repository" && committed.revision);
  await git("checkout", "--detach");
  assert.deepEqual(await runtime.repository(session), {
    state: "repository",
    branch: null,
    revision: committed.revision,
  });
  assert.equal(f.faux.state.callCount, 0);
  assert.equal((await session.harness.inspect(context)).scheduling, "paused");
  await f.reopen({ env: undefined, targets: async () => [] });
  assert.deepEqual(await runtime.repository(await f.sessions.get(session.id)), {
    state: "unavailable",
  });
});

await test("footer context uses the selected model and active context, not lifetime spend", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const status = async (conversation: Conversation = session.root) => {
    const watch = await conversation.watch(context);
    try {
      return runtime.contextStatus(session, watch.value);
    } finally {
      await watch.stop();
    }
  };
  assert.deepEqual(await status(), { window: 128000, autoCompact: true, lastResponse: null });
  assert.deepEqual((await f.sessions.catalog()).sessions[0].context, await status());
  f.faux.setResponses([fauxAssistantMessage("Measured response.")]);
  await session.root.submit({ type: "input", content: "Hello.", requestId: randomUUID() }, context);
  await session.root.waitForIdle(context);
  const history = await runtime.history(session);
  const entry = history.at(-1);
  const message = entry?.model?.[0];
  assert(entry && message?.role === "assistant");
  const measured = await status();
  assert.deepEqual((await f.sessions.catalog()).sessions[0].context, measured);
  assert.equal(measured.lastResponse?.tokens, message.usage.totalTokens);
  assert.equal(measured.lastResponse?.entry, entry.id);
  const promptTokens = message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
  assert.equal(measured.lastResponse?.cacheHit, (message.usage.cacheRead / promptTokens) * 100);
  const watch = await session.root.watch(context);
  try {
    // Switching back to an earlier model must not resurrect older measurements.
    assert.equal(
      runtime.contextStatus(session, {
        ...watch.value,
        entries: [
          { ...entry, id: watch.value.entries[0].id },
          { ...entry, model: [{ ...message, model: "other" }] },
        ],
      }).lastResponse,
      null,
    );
  } finally {
    await watch.stop();
  }
  const fork = await session.root.fork(entry.id, { ownership: { kind: "ownerless" } }, context);
  assert.deepEqual(await status(fork), measured);
  await fork.reset(undefined, context);
  assert.equal((await status(fork)).lastResponse, null);
  assert.deepEqual(await status(), measured);
  await session.root.configure({ model: { provider: "missing", modelId: "unknown" } }, context);
  assert.deepEqual(await status(), { window: null, autoCompact: true, lastResponse: null });
  assert.deepEqual((await f.sessions.catalog()).sessions[0].context, await status());
  await session.root.configure({ model }, context);
  // A context head invalidates older usage even if earlier entries are kept.
  await session.root.submit(
    { type: "write", entry: { kind: "pi.compaction", data: { reason: "manual" }, head: entry.id } },
    context,
  );
  assert.equal((await status()).lastResponse, null);
  assert.equal((await f.sessions.catalog()).sessions[0].context.lastResponse, null);
});

await test("path completion uses remote leases, bounds scanning and closes failed readers", async (t) => {
  const f = await fixture(t);
  const binding = { provider: "remote", target: "guest", cwd: "/remote/work" };
  let available = true;
  let fail = false;
  let pages = 0;
  let closes = 0;
  const env = new NodeExecutionEnv({ cwd: binding.cwd });
  env.openDirReader = async (path) => {
    assert.equal(path, "/remote/work/src/");
    return {
      ok: true,
      value: {
        async next(limit) {
          assert.equal(limit, 100);
          if (fail) throw new Error("Disconnected");
          const entries = Array.from({ length: limit }, (_, index) => ({
            name: `remote-${pages * 100 + index}.ts`,
            path: `${path}remote-${pages * 100 + index}.ts`,
            kind: "file" as const,
            size: 0,
            mtimeMs: 0,
          }));
          pages++;
          return { ok: true, value: { entries, done: false } };
        },
        async close() {
          closes++;
        },
      },
    };
  };
  await f.reopen({
    targets: async () => [{ ...binding, label: "Guest", available }],
    env: async () => {
      if (!available) throw new SessionError("unavailable", "Guest disconnected");
      return env;
    },
    close: () => env.cleanup(context),
  });
  const session = await f.sessions.create(randomUUID(), binding, model);
  const paths = await runtime.completePaths(session, "src/remote");
  assert.equal(paths.length, 50);
  assert(paths.every((path) => path.startsWith("src/remote-")));
  assert.equal(pages, 50);
  assert.equal(closes, 1);
  fail = true;
  await assert.rejects(runtime.completePaths(session, "src/"), /Disconnected/);
  assert.equal(closes, 2);
  available = false;
  await assert.rejects(runtime.completePaths(session, "src/"), code("unavailable"));
  assert.equal(closes, 2);
  assert.equal(f.faux.state.callCount, 0);
});

await test("thinking defaults follow Pi precedence and model capabilities, and persist per conversation", async (t) => {
  const f = await fixture(t);
  const initial = await f.create();
  assert.equal((await runtime.sessionInfo(initial)).thinkingLevel, "medium");
  await f.sessions.close();
  const sessions = await openCodingSessions({
    ...f.options,
    thinkingLevel: "low",
    modelThinkingLevels: { "faux/faux-1": "high" },
  });
  t.after(() => sessions.close());
  const catalog = await sessions.catalog();
  assert.equal(catalog.models[0].defaultThinkingLevel, "high");
  assert.deepEqual(catalog.models[0].thinkingLevels, ["off", "minimal", "low", "medium", "high"]);
  const perModel = await sessions.create(randomUUID(), f.binding, model);
  assert.equal((await runtime.sessionInfo(perModel)).thinkingLevel, "high");
  const explicit = await sessions.create(randomUUID(), f.binding, model, "off");
  assert.equal((await runtime.sessionInfo(explicit)).thinkingLevel, "off");
  const clamped = await sessions.create(randomUUID(), f.binding, model, "max");
  assert.equal((await runtime.sessionInfo(clamped)).thinkingLevel, "high");
  assert.equal((await runtime.sessionInfo(await sessions.get(initial.id))).thinkingLevel, "medium");
  await sessions.close();
  await f.reopen();
  assert.equal(
    (await runtime.sessionInfo(await f.sessions.get(perModel.id))).thinkingLevel,
    "high",
  );
  assert.equal((await runtime.sessionInfo(await f.sessions.get(explicit.id))).thinkingLevel, "off");
});

await test("thinking choices include max only when supported and non-reasoning models stay off", async (t) => {
  const f = await fixture(t);
  const available = f.options.models.getModel(model.provider, model.modelId);
  assert(available);
  available.thinkingLevelMap = { max: "max", xhigh: "xhigh", minimal: null };
  assert.deepEqual((await f.sessions.catalog()).models[0].thinkingLevels, [
    "off",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  assert.equal(f.sessions.resolveThinking(model, "minimal"), "low");
  const maximum = await f.sessions.create(randomUUID(), f.binding, model, "max");
  assert.equal((await runtime.sessionInfo(maximum)).thinkingLevel, "max");
  const plain = fauxProvider({ provider: "plain", models: [{ id: "plain", reasoning: false }] });
  f.options.models.setProvider(plain.provider);
  const ref = { provider: "plain", modelId: "plain" };
  const entry = (await f.sessions.catalog()).models.find((item) => item.provider === "plain");
  assert.deepEqual(entry?.thinkingLevels, ["off"]);
  assert.equal(entry.defaultThinkingLevel, "off");
  const session = await f.sessions.create(randomUUID(), f.binding, ref, "high");
  assert.equal((await runtime.sessionInfo(session)).thinkingLevel, "off");
});

await test("switching environments leaves a running command in its original environment", async (t) => {
  const f = await fixture(t);
  const next = join(f.workspace, "next");
  await mkdir(next);
  const session = await f.create();
  f.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("bash", {
        command:
          "touch started; while test ! -f release; do sleep 0.01; done; printf 1 > completed.json",
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Finished the original command."),
  ]);
  await session.root.submit({ type: "input", content: "Run until released." }, context);
  await waitFor(() => exists(join(f.workspace, "started")));
  await runtime.selectEnvironment(session, { provider: "local", target: next, cwd: next });
  await writeFile(join(f.workspace, "release"), "");
  await session.root.waitForIdle(context);
  assert.equal(JSON.parse(await readFile(join(f.workspace, "completed.json"), "utf8")), 1);
  assert.equal(await exists(join(next, "completed.json")), false);
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("write", { path: "next.json", content: "2" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("Used the selected environment."),
  ]);
  await session.root.submit({ type: "input", content: "Write in the new environment." }, context);
  await session.root.waitForIdle(context);
  assert.equal(JSON.parse(await readFile(join(next, "next.json"), "utf8")), 2);
  assert.equal(await exists(join(f.workspace, "next.json")), false);
});

await test("a submission enables eligible work in other conversations of the same recovered harness", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const marker = await session.root.submit({ type: "write", entry: { kind: "marker" } }, context);
  const at = (await marker.status(context)).entry;
  assert(at !== undefined);
  const branch = await session.root.fork(at, { ownership: { kind: "ownerless" } }, context);
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
  await session.root.submit({ type: "input", content: "Interrupted root work." }, context);
  await started.promise;
  await f.reopen();
  const restored = await f.sessions.get(session.id);
  assert.equal((await restored.harness.inspect(context)).scheduling, "paused");
  const other = await restored.harness.conversation(branch.id, context);
  assert(other);
  f.faux.setResponses([
    fauxAssistantMessage("One conversation."),
    fauxAssistantMessage("The other conversation."),
  ]);
  await other.submit({ type: "input", content: "New branch work." }, context);
  assert.equal((await restored.harness.inspect(context)).scheduling, "running");
  await restored.harness.waitForIdle(context);
  assert.equal(f.faux.state.callCount, 3);
  assert.equal((await restored.harness.inspect(context)).tasks.length, 0);
});

await test("legacy metadata and history remain intact until an environment is explicitly selected", async (t) => {
  const f = await fixture(t);
  const LegacyMetadata = defineDoc<{ binding: typeof f.binding | null; created: number }>({
    kind: "app.session",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "current",
    initial: () => ({ binding: null, created: 0 }),
  });
  const directory = join(f.directory, "legacy");
  let sessions = await Sessions.open({
    directory,
    models: f.options.models,
    async open(storage) {
      const harness = await Harness.open(
        storage,
        { models: f.options.models, registry: createRegistry() },
        context,
      );
      await harness.root(context, {
        agent: { model, cwd: f.workspace },
        init: async (tx, id) => {
          Object.assign(await tx.doc(LegacyMetadata, id), { binding: f.binding, created: 1 });
        },
      });
      return harness;
    },
  });
  t.after(() => sessions.close());
  const session = await sessions.create(randomUUID());
  await session.root.submit(
    { type: "write", entry: { kind: "marker", data: { retained: true } } },
    context,
  );
  const before = await runtime.history(session);
  await sessions.close();
  sessions = await openCodingSessions({ ...f.options, directory });
  const restored = await sessions.get(session.id);
  assert.deepEqual(await runtime.history(restored), before);
  assert.deepEqual(await restored.harness.snapshot(LegacyMetadata, restored.root.id, context), {
    binding: f.binding,
    created: 1,
  });
  assert.equal((await runtime.sessionInfo(restored)).binding, undefined);
  await assert.rejects(runtime.environment(restored), code("unavailable"));
  assert.equal((await restored.harness.inspect(context)).scheduling, "paused");
  await runtime.selectEnvironment(restored, f.binding);
  assert.equal((await runtime.environment(restored)).cwd, f.workspace);
  assert.deepEqual(await runtime.history(restored), before);
  assert.equal(f.faux.state.callCount, 0);
});
