import { command } from "./testing.ts";
import { Sessions } from "../sessions.ts";
import * as runtime from "../sessions.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { BACKGROUND_CONTEXT, awaitWithContext, type Context } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { readHistory, fixture, model } from "./sessions-testing.ts";
import { checkCLI, chromiumExecutable, directoryFixture, serve, post } from "./testing.ts";
import { GlobalSettingsStore, httpServer } from "../server.ts";
import { conversationURL } from "../presentation.ts";
import { modelKey, targetKey } from "./testing.ts";
import { benchmarkFixture, benchmarkOptions } from "../benchmark.ts";
import { buildAssets } from "../build.ts";

import type { Catalog } from "../sessions.ts";
import { settingFields } from "../settings.ts";

const context = BACKGROUND_CONTEXT;

await test("HTTP fixtures and benchmark inputs load without Playwright", async () => {
  // A fresh module graph catches eager transitive imports, including cached
  // dependencies that the other tests in this process have already loaded.
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import assert from "node:assert/strict";
       import { registerHooks } from "node:module";
       registerHooks({
         resolve(specifier, context, nextResolve) {
           assert(!["playwright", "playwright-core"].some(
             (name) => specifier === name || specifier.startsWith(name + "/"),
           ), "Browser-free imports must not load Playwright");
           return nextResolve(specifier, context);
         },
       });
       await import(${JSON.stringify(new URL("./testing.ts", import.meta.url).href)});
       const { benchmarkOptions, benchmarkFixture } =
         await import(${JSON.stringify(new URL("../benchmark.ts", import.meta.url).href)});
       assert.equal(benchmarkOptions(["--turns", "2"]).turns, 2);
       assert.equal(benchmarkFixture(2).view.entries.length, 6);`,
    ],
    { stdio: "inherit" },
  );
  assert.deepEqual(await once(child, "exit"), [0, null]);
});

await test("browser executable lookup follows PATH and rejects unusable candidates", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "serve-browser-path-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const missing = join(directory, "missing");
  const blocked = join(directory, "non-executable");
  const folder = join(directory, "directory");
  const first = join(directory, "first executable");
  const second = join(directory, "second");
  for (const path of [blocked, folder, first, second]) await mkdir(path);
  await writeFile(join(blocked, "chromium"), "", { mode: 0o600 });
  await mkdir(join(folder, "chromium"));
  for (const path of [first, second])
    await writeFile(join(path, "chromium"), "#!/bin/sh\n", { mode: 0o700 });
  const notDirectory = join(first, "chromium");
  const unusable = [missing, blocked, folder, notDirectory];
  assert.equal(
    chromiumExecutable([...unusable, first, second].join(delimiter)),
    join(first, "chromium"),
  );
  assert.equal(chromiumExecutable([second, first].join(delimiter)), join(second, "chromium"));
  assert.throws(() => chromiumExecutable(unusable.join(delimiter)));
});

await test("CLI harness preserves startup and assertion failures while reaping children", async (t) => {
  for (const scenario of [
    "retry",
    "exit",
    "signal",
    "stall",
    "body",
    "assertion",
    "shutdown",
  ] as const) {
    await t.test(scenario, async (t) => {
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
        import { createServer } from "node:http";
        const scenario = ${JSON.stringify(scenario)};
        let requests = 0;
        const server = createServer((request, response) => {
          if (scenario === "exit") process.exit(23);
          if (scenario === "signal") { process.kill(process.pid, "SIGTERM"); return; }
          if (scenario === "stall") return;
          if (scenario === "retry" && ++requests === 1) {
            response.writeHead(503).end();
            return;
          }
          response.setHeader("Content-Type", "application/json");
          if (scenario === "body") { response.write("{"); return; }
          response.end(JSON.stringify({ sessions: [], targets: [], models: [] }));
        });
        if (scenario !== "signal") process.on("SIGTERM", () => {
          server.close();
          server.closeAllConnections();
          process.disconnect();
          process.exitCode = scenario === "shutdown" ? 7 : 0;
        });
        server.listen(0, "127.0.0.1", () => process.send(server.address().port));
      `,
        ],
        { stdio: ["ignore", "ignore", "pipe", "ipc"] },
      );
      t.after(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      });
      const [port] = await once(child, "message");
      assert.equal(typeof port, "number");
      const original = new Error("Catalog assertion failed");
      let checked = false;
      const result = checkCLI(
        child,
        `http://127.0.0.1:${port}`,
        (response) => response.json() as Promise<Catalog>,
        (catalog) => {
          checked = true;
          assert.deepEqual(catalog, { sessions: [], targets: [], models: [] });
          if (scenario === "assertion") throw original;
        },
        scenario === "stall" || scenario === "body" ? 250 : 30_000,
      );
      if (scenario === "retry") {
        await result;
        assert.equal(checked, true);
        assert.equal(child.exitCode, 0);
      } else if (scenario === "assertion") {
        await assert.rejects(result, (error) => error === original);
        assert.equal(checked, true);
        assert.equal(child.signalCode, "SIGKILL");
      } else if (scenario === "shutdown") {
        await assert.rejects(result, (error) => {
          assert(error instanceof assert.AssertionError);
          assert.deepEqual(error.actual, [7, null]);
          return true;
        });
        assert.equal(checked, true);
      } else {
        await assert.rejects(result, (error) => {
          assert(error instanceof Error);
          assert(error.cause instanceof Error);
          if (scenario === "stall" || scenario === "body") {
            assert(error.cause instanceof DOMException);
            assert.equal(error.cause.name, "TimeoutError");
          } else {
            assert.deepEqual(error.cause.cause, {
              code: scenario === "exit" ? 23 : null,
              signal: scenario === "signal" ? "SIGTERM" : null,
            });
          }
          return true;
        });
        assert.equal(checked, false);
        assert.equal(child.exitCode, scenario === "exit" ? 23 : null);
        assert.equal(
          child.signalCode,
          scenario === "signal"
            ? "SIGTERM"
            : scenario === "stall" || scenario === "body"
              ? "SIGKILL"
              : null,
        );
      }
    });
  }
});

await test("HTTP disconnect does not abort work; reconnect includes history and deduplicates prompts", async (t) => {
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  t.after(() => finish.resolve());
  const f = await fixture(t);
  f.faux.setResponses([
    async () => {
      started.resolve();
      await finish.promise;
      return fauxAssistantMessage("Done.");
    },
  ]);
  const base = await serve(t, f.sessions);
  const id = randomUUID();
  assert.equal(
    (await post(base + "/", { id, target: targetKey(f.binding), model: modelKey(model) })).status,
    200,
  );
  const session = await f.sessions.get(id);
  const url = base + conversationURL(session);
  const data = { content: "Work", requestId: "retryable-input", whenBusy: "reject" };
  assert.equal((await command(url, "submit", data)).status, 200);
  await started.promise;
  const views: Awaited<ReturnType<typeof session.root.watch>>[] = [];
  const conversation = session.harness.conversation.bind(session.harness);
  t.mock.method(
    session.harness,
    "conversation",
    async (...args: Parameters<typeof conversation>) => {
      const selected = await conversation(...args);
      if (selected) {
        const watch = selected.watch.bind(selected);
        t.mock.method(selected, "watch", async (context: Context) => {
          const result = await watch(context);
          views.push(result);
          return result;
        });
      }
      return selected;
    },
  );
  const subscriptions: { closed: boolean }[] = [];
  const subscribe = session.harness.subscribeCommits.bind(session.harness);
  t.mock.method(
    session.harness,
    "subscribeCommits",
    (listener: Parameters<typeof subscribe>[0]) => {
      const state = { closed: false };
      subscriptions.push(state);
      const stop = subscribe(listener);
      return () => {
        state.closed = true;
        stop();
      };
    },
  );
  const response = await fetch(url + "/events");
  assert.equal(response.status, 200);
  assert(response.body);
  await response.body.cancel();
  assert(views.length > 0);
  const view = views[0];
  assert(view);
  assert.deepEqual(await view.closed, { reason: "cancelled" });
  assert(subscriptions.length > 0);
  assert(subscriptions.every((subscription) => subscription.closed));
  assert.equal((await command(url, "submit", data)).status, 200);
  finish.resolve();
  await session.root.waitForIdle(context);
  const reconnected = await fetch(url + "/export");
  assert.equal(reconnected.status, 200);
  assert.deepEqual(await reconnected.json(), await readHistory(session.root));
  assert.equal(
    (await readHistory(session.root))
      .flatMap((entry) => entry.model ?? [])
      .filter((message) => message.role === "user").length,
    1,
  );
  assert.equal(f.faux.state.callCount, 1);
  assert.equal((await session.harness.inspect(context)).tasks.length, 0);
});

await test("HTML HTTP validates origins, IDs, methods, malformed forms and request size", async (t) => {
  const f = await fixture(t);
  const base = await serve(t, f.sessions);
  assert.equal(
    (
      await fetch(base + "/", {
        headers: { Origin: "https://untrusted.example" },
      })
    ).status,
    403,
  );
  const rebinding = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(base + "/", { headers: { Host: "untrusted.example" } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    req.once("error", reject);
    req.end();
  });
  assert.equal(rebinding, 403);
  assert.equal(
    (
      await fetch(base + "/", {
        headers: { "Sec-Fetch-Site": "cross-site" },
      })
    ).status,
    403,
  );
  assert.equal((await fetch(base + "/")).status, 200);
  assert.equal((await fetch(base + "/sessions/" + randomUUID())).status, 404);
  const malformed = await fetch(base + "/", {
    method: "POST",
    headers: { Origin: base, "Content-Type": "multipart/form-data" },
    body: "missing boundary",
  });
  assert.equal(malformed.status, 400);
  const session = await f.sessions.create(randomUUID(), f.binding, model);
  const settings = base + conversationURL(session) + "/settings";
  const send = (body: BodyInit, contentType?: string) =>
    fetch(settings, {
      method: "POST",
      headers: { Origin: base, ...(contentType ? { "Content-Type": contentType } : {}) },
      body,
      redirect: "manual",
    });
  assert.equal((await send(new URLSearchParams())).status, 400);
  assert.equal((await send("{}", "application/json")).status, 415);
  assert.equal((await send(new URLSearchParams({ name: "a".repeat(129 * 1024) }))).status, 413);
  assert.equal((await fetch(base + conversationURL(session) + "/command")).status, 405);
  assert.equal((await fetch(base + "/manifest.webmanifest")).status, 200);
  const icon = await fetch(base + "/icon.svg");
  assert.equal(icon.status, 200);
  assert.equal((await f.sessions.catalog()).sessions.length, 1);
});

await test("wildcard binding accepts each destination but rejects spoofed hosts and cross-site requests", async (t) => {
  const f = await fixture(t);
  const base = await serve(t, f.sessions, undefined, "0.0.0.0");
  const port = new URL(base).port;
  for (const address of ["127.0.0.1", "127.0.0.2"]) {
    const url = `http://${address}:${port}/`;
    assert.equal(
      (await fetch(url, { headers: { Origin: `http://${address}:${port}` } })).status,
      200,
    );
    assert.equal(
      (await fetch(url, { headers: { Origin: "https://untrusted.example" } })).status,
      403,
    );
    assert.equal((await fetch(url, { headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
    for (const host of [
      `untrusted.example:${port}`,
      `0.0.0.0:${port}`,
      `192.0.2.1:${port}`,
      `${address}:1`,
      `${address === "127.0.0.1" ? "127.0.0.2" : "127.0.0.1"}:${port}`,
    ]) {
      const code = await new Promise<number | undefined>((resolve, reject) => {
        const req = request(url, { headers: { Host: host } }, (response) => {
          response.resume();
          resolve(response.statusCode);
        });
        req.once("error", reject);
        req.end();
      });
      assert.equal(code, 403);
    }
  }
  assert.equal((await fetch(`http://localhost:${port}/`)).status, 200);
});

await test("built browser assets preserve module formats and tokenize without a DOM", async (t) => {
  const assets = await mkdtemp(join(tmpdir(), "serve-build-"));
  t.after(() => rm(assets, { recursive: true, force: true }));
  // Production builds inside a package with type=module; Elm still loads as a classic script.
  await writeFile(join(assets, "package.json"), JSON.stringify({ type: "module" }));
  await buildAssets(dirname(dirname(fileURLToPath(import.meta.url))), assets);
  assert.deepEqual(
    (await readdir(assets, { recursive: true })).filter((file) => file.endsWith(".css")),
    ["styles.css"],
  );
  const scope: { Elm?: { Main?: { init?: unknown } } } = {};
  runInNewContext(await readFile(join(assets, "main.js"), "utf8"), scope);
  assert.equal(typeof scope.Elm?.Main?.init, "function");
  const { tokenize }: typeof import("../highlight.ts") = await import(
    pathToFileURL(join(assets, "highlight.js")).href
  );
  for (const [language, source] of [
    ["ts", "export const value: string = '<script>alert(1)</script>';"],
    ["html", "<style>body { color: red; }</style><script>const x = /foo/;</script>"],
    ["diff", "-old\n+new\n"],
  ]) {
    const [result] = tokenize([{ id: 7, language, source }]);
    assert.equal(result.id, 7);
    assert.equal(result.tokens.map((token) => token.text).join(""), source);
    assert(result.tokens.some((token) => token.kind !== ""));
  }
  for (const language of ["nix", "elm", "unknown", "constructor"]) {
    const [result] = tokenize([{ id: 8, language, source: "unchanged" }]);
    assert.deepEqual(result.tokens, [{ text: "unchanged", kind: "" }]);
  }
  const f = await fixture(t);
  const base = await serve(t, f.sessions, assets);
  for (const file of ["main.js", "client.js", "site.js", "file.js", "sw.js"]) {
    const asset = await fetch(`${base}/${file}`);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.equal(asset.headers.get("service-worker-allowed"), null);
    assert.deepEqual(Buffer.from(await asset.arrayBuffer()), await readFile(join(assets, file)));
  }
  const response = await fetch(`${base}/highlight.js`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.deepEqual(
    Buffer.from(await response.arrayBuffer()),
    await readFile(join(assets, "highlight.js")),
  );
});

await test("renderer benchmark validates options and builds deterministic paired history", () => {
  const options = benchmarkOptions([]);
  assert.equal(options.runs, 3);
  assert.equal(options.turns, 200);
  assert.equal(options.cpuRate, 1);
  assert.equal(options.entries, 600);
  assert.equal(options.memory, false);
  const exact = benchmarkOptions(["--entries", "2000", "--memory"]);
  assert.equal(exact.entries, 2000);
  assert.equal(exact.turns, 667);
  assert.equal(exact.memory, true);
  assert.equal(options.profile, false);
  assert.equal(benchmarkOptions(["--profile"]).profile, true);
  assert.equal(
    benchmarkOptions(["--profile", "--profile-dir", "profiles"]).profileDir,
    resolve("profiles"),
  );
  assert.equal(benchmarkOptions(["--cpu-rate", "2.5"]).cpuRate, 2.5);
  for (const args of [
    ["--frontend", "unknown"],
    ["--frontend", "original"],
    ["--frontend"],
    ["--runs", "0"],
    ["--runs", "1.5"],
    ["--runs", "101"],
    ["--turns", "-1"],
    ["--turns", "10001"],
    ["--turns", "NaN"],
    ["--entries", "0"],
    ["--entries", "30001"],
    ["--entries", "1.5"],
    ["--entries", "NaN"],
    ["--entries", "2000", "--turns", "200"],
    ["--cpu-rate", "0.5"],
    ["--cpu-rate", "Infinity"],
    ["--profile-dir", "profiles"],
    ["--profile", "--profile-dir"],
    ["--runs"],
    ["--unknown"],
    ["unexpected"],
  ])
    assert.throws(() => benchmarkOptions(args));
  const fixture = benchmarkFixture(2);
  assert.deepEqual(fixture, benchmarkFixture(2));
  assert.deepEqual(
    fixture.view.entries.map((entry) => entry.id),
    [1, 2, 3, 4, 5, 6],
  );
  for (let i = 0; i < 2; i++) {
    const assistant = fixture.view.entries[3 * i + 1].model?.[0];
    const result = fixture.view.entries[3 * i + 2].model?.[0];
    assert(assistant?.role === "assistant");
    assert(result?.role === "toolResult");
    const call = assistant.content.find((block) => block.type === "toolCall");
    assert(call);
    assert.equal(result.toolCallId, call.id);
  }
});

await test("exact-size benchmark history retains complete tool pairs and text-only remainder entries", () => {
  for (const count of [1, 2, 3, 4, 5, 6, 2000]) {
    const { view } = benchmarkFixture(Math.ceil(count / 3), count);
    assert.equal(view.entries.length, count);
    const messages = view.entries.flatMap((entry) => entry.model ?? []);
    const calls = messages.flatMap((message) =>
      message.role === "assistant"
        ? message.content.filter((part) => part.type === "toolCall")
        : [],
    );
    const results = messages.filter((message) => message.role === "toolResult");
    assert.equal(calls.length, Math.floor(count / 3));
    assert.deepEqual(
      results.map((result) => result.toolCallId),
      calls.map((call) => call.id),
    );
    if (count % 3 === 2) {
      const last = messages.at(-1);
      assert(last?.role === "assistant");
      assert.equal(last.stopReason, "stop");
      assert(last.content.every((part) => part.type === "text"));
    }
  }
  assert.throws(() => benchmarkFixture(2, 3));
  assert.throws(() => benchmarkFixture(2, 7));
  assert.throws(() => benchmarkFixture(2, 5.5));
});

await test("rename commands update session metadata from a branch without model input", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const other = await f.create();
  await session.root.submit({ type: "write", entry: { kind: "test", data: {} } }, context);
  const history = await readHistory(session.root);
  const branch = await session.root.fork(
    history.at(-1)!.id,
    { ownership: { kind: "ownerless" } },
    context,
  );
  const info = await runtime.sessionInfo(session, branch);
  const base = await serve(t, f.sessions);
  const path = conversationURL(session, branch.id);
  const submit = (fields: Record<string, string>) =>
    post(base + path + "/command", {
      command: "rename",
      requestId: randomUUID(),
      revision: randomUUID(),
      ...fields,
    });
  const success = 200;
  assert.equal((await submit({ argument: "  Counter cleanup  " })).status, success);
  assert.equal((await runtime.sessionInfo(session)).name, "Counter cleanup");
  assert.equal((await runtime.sessionInfo(session, branch)).name, "Counter cleanup");
  for (const argument of ["a".repeat(121), "line\nbreak", "null\0byte", "delete\x7f"]) {
    assert.equal((await submit({ argument })).status, 400);
    assert.equal((await runtime.sessionInfo(session)).name, "Counter cleanup");
  }
  const empty: Record<string, string>[] = [{ argument: "" }, { argument: "   " }, {}];
  for (const fields of empty) {
    assert.equal((await submit(fields)).status, success);
    assert.equal((await runtime.sessionInfo(session)).name, "");
  }
  const name = "x".repeat(120);
  assert.equal((await submit({ argument: `  ${name}  ` })).status, success);
  assert.equal((await runtime.sessionInfo(session)).name, name);
  assert.equal((await runtime.sessionInfo(other)).name, "");
  assert.deepEqual(await runtime.sessionInfo(session, branch), { ...info, name });
  assert.deepEqual(await readHistory(session.root), history);
  assert.deepEqual(await readHistory(branch), history);
  assert.equal(f.faux.state.callCount, 0);
  await f.reopen();
  const restored = await f.sessions.get(session.id);
  assert.equal((await runtime.sessionInfo(restored)).name, name);
  assert.equal(
    (await f.sessions.catalog()).sessions.find((item) => item.id === session.id)?.name,
    name,
  );
});

await test("conversation controls validate input and keep forks scoped to their session", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const base = await serve(t, f.sessions);
  const url = base + conversationURL(session);
  f.faux.setResponses([fauxAssistantMessage("A completed turn.")]);
  await session.root.submit({ type: "input", content: "Begin.", requestId: randomUUID() }, context);
  await session.root.waitForIdle(context);
  const history = await readHistory(session.root);
  await session.root.configure({ instructions: "Keep configured instructions." }, context);
  const settings = {
    name: "",
    target: targetKey(f.binding),
    model: modelKey(model),
  };
  for (const [action, data] of [
    ["submit", { content: "No", requestId: randomUUID(), whenBusy: "invalid" }],
    ["submit", { content: "No", requestId: "", whenBusy: "reject" }],
    ["settings", { ...settings, thinkingLevel: "invalid" }],
    ["cancel", { argument: "wrong" }],
  ] as const)
    assert.equal(
      (await (action === "settings" ? post(`${url}/settings`, data) : command(url, action, data)))
        .status,
      400,
    );
  assert.equal((await post(`${url}/settings`, settings)).status, 200);
  assert.equal((await session.root.agent(context)).instructions, "Keep configured instructions.");
  for (const name of ["a".repeat(121), "line\nbreak"])
    assert.equal((await post(`${url}/settings`, { ...settings, name })).status, 400);
  const renamed = await post(`${url}/settings`, { ...settings, name: "  Counter cleanup  " });
  assert.equal(renamed.status, 200);
  assert.equal((await runtime.sessionInfo(session)).name, "Counter cleanup");
  assert.equal((await f.sessions.catalog()).sessions[0].name, "Counter cleanup");
  assert.deepEqual(await readHistory(session.root), history);
  assert.equal((await fetch(base + `/sessions/${session.id}/conversations/not-an-id`)).status, 404);
  assert.equal((await fetch(base + `/sessions/${session.id}/conversations/9999999`)).status, 404);
  const branch = await session.root.fork(
    history.at(-1)!.id,
    { ownership: { kind: "ownerless" } },
    context,
  );
  const forkPath = conversationURL(session, branch.id);
  assert.deepEqual(await readHistory(branch), history);
  assert.equal((await fetch(`${url}/branches`)).status, 200);
  assert.equal(
    (await command(base + forkPath, "reset", { argument: "Carry this forward." })).status,
    200,
  );
  assert.equal((await branch.context(context)).messages.length, 1);
  assert.deepEqual(await readHistory(session.root), history);
  const exported = await (await fetch(base + forkPath + "/export")).json();
  assert.equal(exported.length, history.length + 1);
  assert.equal((await command(base + forkPath, "compact", {})).status, 200);
  await session.harness.waitForIdle(context);
  assert.equal((await session.harness.inspect(context)).tasks.length, 0);
  const manifest = await (await fetch(base + "/manifest.webmanifest")).json();
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.id, "/");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.start_url, "/");
  for (const path of ["/elm", "/elm/", "/elm/main.js", "/elm/manifest.webmanifest"])
    assert.equal((await fetch(base + path, { redirect: "manual" })).status, 404);
  assert.deepEqual(
    manifest.icons.map((icon: { sizes: string }) => icon.sizes),
    ["192x192", "512x512"],
  );
});

await test("external origins require canonical HTTPS and loopback binding", async (t) => {
  const f = await fixture(t);
  for (const origin of [
    "",
    "not a URL",
    "http://pi.example",
    "https://pi.example/",
    "https://pi.example/path",
    "https://pi.example?query",
    "https://pi.example#fragment",
    "https://user:password@pi.example",
    "https://pi.example:443",
  ])
    assert.throws(() => httpServer(f.sessions, "127.0.0.1", undefined, undefined, origin));
  for (const host of ["0.0.0.0", "::", "192.0.2.1"])
    assert.throws(() => httpServer(f.sessions, host, undefined, undefined, "https://pi.example"));
  for (const host of ["127.0.0.1", "::1"])
    httpServer(f.sessions, host, undefined, undefined, "https://pi.example").close();
});

await test("external origin validates preserved Host and browser Origin without trusting forwarded headers", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const path = conversationURL(session);
  const origin = "https://pi.example:8443";
  const base = await serve(t, f.sessions, undefined, "127.0.0.1", undefined, origin);
  const data = { content: "Through HTTPS", requestId: randomUUID(), whenBusy: "reject" };
  const send = (headers: Record<string, string>, submit = false) =>
    new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        base + path + (submit ? "/command" : ""),
        {
          method: submit ? "POST" : "GET",
          headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      req.once("error", reject);
      req.end(
        submit
          ? new URLSearchParams({ command: "submit", revision: "revision", ...data }).toString()
          : undefined,
      );
    });
  const headers = { Host: new URL(origin).host, Origin: origin };
  assert.equal(await send({ Host: headers.Host }), 200);
  assert.equal(await send(headers), 200);
  assert.equal(
    await send({ ...headers, "X-Forwarded-Host": "evil.example", "X-Forwarded-Proto": "http" }),
    200,
  );
  const invalidHeaders: Record<string, string>[] = [
    { ...headers, Host: "evil.example" },
    { ...headers, Host: "pi.example" },
    { ...headers, Host: new URL(base).host },
    { ...headers, Origin: "https://evil.example" },
    { ...headers, Origin: "https://pi.example" },
    { ...headers, Origin: "http://pi.example:8443" },
    { ...headers, Origin: base },
    { ...headers, Origin: "null" },
    { ...headers, "Sec-Fetch-Site": "cross-site" },
    { Host: "evil.example", Origin: origin, "X-Forwarded-Host": headers.Host },
    { ...headers, Origin: base, "X-Forwarded-Proto": "https" },
    { ...headers, Origin: base, Forwarded: `host=${headers.Host};proto=https` },
  ];
  for (const invalid of invalidHeaders) {
    assert.equal(await send(invalid), 403);
    assert.equal(await send(invalid, true), 403);
  }
  assert.equal(await send({ Host: headers.Host }, true), 403);
  assert.deepEqual(await readHistory(session.root), []);
  f.faux.setResponses([fauxAssistantMessage("Done.")]);
  assert.equal(await send(headers, true), 200);
  await session.root.waitForIdle(context);
  const history = await readHistory(session.root);
  assert(history.some((entry) => entry.kind === "pi.user"));
  assert.equal(await send(headers, true), 200);
  assert.deepEqual(await readHistory(session.root), history);
  assert.equal(f.faux.state.callCount, 1);
});

await test("forwarded headers cannot bypass origin checks", async (t) => {
  const f = await fixture(t);
  const base = await serve(t, f.sessions);
  const status = (headers: Record<string, string>) =>
    new Promise<number | undefined>((resolve, reject) => {
      const req = request(base + "/", { headers }, (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      req.once("error", reject);
      req.end();
    });
  assert.equal(await status({ Host: "pi.example", Origin: "https://pi.example" }), 403);
  assert.equal(await status({ Host: "pi.example", Origin: "https://evil.example" }), 403);
  assert.equal(
    await status({
      Host: "evil.example",
      "X-Forwarded-Host": "pi.example",
      "X-Forwarded-Proto": "https",
    }),
    403,
  );
});

await test(
  "HTTP disconnect cancels application IO and closes readers without closing the environment",
  { timeout: 10000 },
  async (t) => {
    let release = Promise.withResolvers<void>();
    t.after(() => release.resolve());
    const f = await directoryFixture(t);
    const env = new NodeExecutionEnv({ cwd: f.workspace });
    t.after(() => env.cleanup(context));
    const cleanup = t.mock.method(env, "cleanup");
    let entered = Promise.withResolvers<Context>();
    let finished = Promise.withResolvers<Context>();
    env.openDirReader = async () => ({
      ok: true,
      value: {
        async next(_limit, context) {
          entered.resolve(context);
          await awaitWithContext(release.promise, context);
          return { ok: true, value: { entries: [], done: true } };
        },
        async close(context) {
          finished.resolve(context);
        },
      },
    });
    await f.reopen({ ...f.execution, env: () => env, directoryEnv: () => env });
    const session = await f.sessions.create(randomUUID(), f.binding, model);
    const base = await serve(t, f.sessions);
    for (const operation of ["directories", "completions"]) {
      entered = Promise.withResolvers<Context>();
      finished = Promise.withResolvers<Context>();
      release = Promise.withResolvers<void>();
      const controller = new AbortController();
      t.after(() => controller.abort());
      const resource =
        operation === "directories"
          ? "/directories?" + new URLSearchParams({ target: targetKey(f.binding), directory: "" })
          : conversationURL(session) + "/completions?text=@&caret=1";
      const pending = fetch(base + resource, { signal: controller.signal });
      const rejected = assert.rejects(pending, { name: "AbortError" });
      const running = await entered.promise;
      assert(running.abortSignal);
      controller.abort();
      await rejected;
      const completed = await finished.promise;
      assert.equal(running.abortSignal.aborted, true);
      assert.equal(completed.abortSignal, undefined);
      assert.equal(cleanup.mock.callCount(), 0);
      release.resolve();
    }
    const result = await env.exec("true", {}, context);
    assert(result.ok);
    assert.equal(result.value.exitCode, 0);
    assert.equal((await session.harness.inspect(context)).scheduling, "paused");
    assert.equal(f.faux.state.callCount, 0);
  },
);

await test("app settings persist and drive live Durable policy", async (t) => {
  const f = await fixture(t);
  await f.sessions.close();
  const path = join(f.workspace, "settings.json");
  const initial = new GlobalSettingsStore({ model }).read();
  initial.values["compaction.reserveTokens"] = 12345;
  initial.values["retry.maxRetries"] = 7;
  const { defaultDeliveryMode, ...values } = initial.values;
  assert.equal(defaultDeliveryMode, "follow-up");
  await writeFile(path, JSON.stringify({ ...initial, values }));
  const store = await GlobalSettingsStore.open(path);
  assert.equal(store.read().values.defaultDeliveryMode, "follow-up");
  const options = store.bind(f.options);
  const sessions = await Sessions.open(options);
  assert.equal(sessions.options.defaults, options.defaults);
  t.after(() => sessions.close());
  const base = await serve(t, sessions, undefined, "127.0.0.1", store);
  const current = await sessions.create(randomUUID(), f.binding, model);
  assert.equal((await runtime.sessionInfo(current)).thinkingLevel, "medium");
  assert.equal(options.settings?.compaction?.reserveTokens, 12345);
  const get = () => store.read();
  const globalForm = () =>
    Object.fromEntries(
      settingFields
        .filter((field) => !("readonly" in field))
        .map((field) => [field.key, String(get().values[field.key])]),
    );
  assert.equal(get().values.defaultThinkingLevel, "medium");
  const before = get();
  for (const data of [
    { values: { defaultThinkingLevel: "wrong" } },
    { values: { defaultDeliveryMode: "wrong" } },
    { values: { "retry.enabled": "false" } },
    { values: { "retry.maxRetries": -1 } },
    { values: { shellPath: "/not-allowed" } },
    {
      values: { hideThinkingBlock: true },
      model: { provider: "missing", modelId: "missing" },
    },
    { modelThinkingLevel: "high" },
    { unknown: true },
  ]) {
    await assert.rejects(store.update(data, sessions), { status: 400 });
    assert.deepEqual(get(), before);
  }
  for (const [key, value] of [
    ["defaultThinkingLevel", "wrong"],
    ["defaultDeliveryMode", "wrong"],
    ["retry.enabled", "not-a-boolean"],
    ["model", "missing"],
  ]) {
    assert.equal((await post(base + "/settings", { ...globalForm(), [key]: value })).status, 400);
    assert.deepEqual(get(), before);
  }
  const result = await post(base + "/settings", {
    ...globalForm(),
    model: modelKey(model),
    modelThinkingLevel: "high",
    defaultThinkingLevel: "low",
    "compaction.enabled": "false",
    "retry.enabled": "false",
    defaultDeliveryMode: "steering",
    steeringMode: "all",
    followUpMode: "all",
    transport: "sse",
    hideThinkingBlock: "true",
    "terminal.showImages": "false",
  });
  assert.equal(result.status, 200);
  const persisted = (await GlobalSettingsStore.open(path)).read();
  assert.equal(persisted.values.defaultThinkingLevel, "low");
  assert.equal(persisted.values.defaultDeliveryMode, "steering");
  assert.equal(persisted.modelThinkingLevels[`${model.provider}/${model.modelId}`], "high");
  assert.equal(persisted.values["compaction.reserveTokens"], 12345);
  assert.equal(options.settings?.retry?.enabled, false);
  assert.equal(options.settings?.retry?.maxRetries, 7);
  assert.equal(options.settings?.steeringMode, "all");
  assert.equal(options.settings?.followUpMode, "all");
  assert.equal(options.settings?.stream?.transport, "sse");
  const watch = await current.root.watch(context);
  t.after(() => watch.stop());
  const view = {
    context: runtime.contextStatus(current, watch.value),
    inspection: await runtime.inspectContext(current, watch.value, context),
  };
  await watch.stop();
  assert.equal(view.context.autoCompact, false);
  assert(view.inspection.state === "available");
  assert.equal(view.inspection.policy.enabled, false);
  assert.equal(view.inspection.policy.reserveTokens, 12345);
  assert.equal((await runtime.sessionInfo(current)).thinkingLevel, "medium");
  const create = async (thinkingLevel?: string) => {
    const id = randomUUID();
    const response = await post(base + "/", {
      id,
      target: targetKey(f.binding),
      model: modelKey(model),
      ...(thinkingLevel ? { thinkingLevel } : {}),
    });
    return { id, response };
  };
  const created = await create();
  assert.equal(created.response.status, 200);
  assert.equal((await runtime.sessionInfo(await sessions.get(created.id))).thinkingLevel, "high");
  const override = await create("off");
  assert.equal(override.response.status, 200);
  assert.equal((await runtime.sessionInfo(await sessions.get(override.id))).thinkingLevel, "off");
  assert.equal((await create("invalid")).response.status, 400);
  // Durable stores the explicit value; forms constrain it to the selected model.
  await current.root.configure({ thinkingLevel: "max" }, context);
  assert.equal((await runtime.sessionInfo(current)).thinkingLevel, "max");
  const configured = await post(base + conversationURL(current) + "/settings", {
    name: "",
    target: targetKey(f.binding),
    model: modelKey(model),
    thinkingLevel: "high",
  });
  assert.equal(configured.status, 200);
  assert.equal((await runtime.sessionInfo(current)).thinkingLevel, "high");
  assert.equal(
    (
      await post(base + "/settings", {
        ...globalForm(),
        model: modelKey(model),
        modelThinkingLevel: "",
      })
    ).status,
    200,
  );
  assert.equal((await sessions.catalog()).models[0].defaultThinkingLevel, "low");
  // Verify the actual generation receives the policy, not only our settings object.
  f.faux.setResponses([
    (_context, stream) => {
      assert.equal(stream?.transport, "sse");
      return fauxAssistantMessage("Configured.");
    },
  ]);
  await current.root.submit(
    { type: "input", content: "Run with current policy.", requestId: randomUUID() },
    context,
  );
  await current.root.waitForIdle(context);
  assert.equal(f.faux.state.callCount, 1);
});

await test("settings publish only successful writes and serialize concurrent updates", async (t) => {
  const f = await fixture(t);
  const path = join(f.workspace, "settings.json");
  const store = await GlobalSettingsStore.open(path);
  const before = store.read();
  let notifications = 0;
  const unwatch = store.watch(() => {
    notifications++;
  });
  // Replacing a directory must fail even when the test runs as root.
  await mkdir(path);
  await assert.rejects(store.update({ values: { hideThinkingBlock: true } }, f.sessions));
  assert.deepEqual(store.read(), before);
  assert.equal(notifications, 0);
  await rm(path, { recursive: true });
  await Promise.all([
    store.update({ values: { hideThinkingBlock: true } }, f.sessions),
    store.update({ values: { "terminal.showImages": false } }, f.sessions),
  ]);
  assert.equal(notifications, 2);
  unwatch();
  const persisted = (await GlobalSettingsStore.open(path)).read();
  assert.equal(persisted.values.hideThinkingBlock, true);
  assert.equal(persisted.values["terminal.showImages"], false);
  const snapshot = store.read();
  snapshot.values.hideThinkingBlock = false;
  assert.equal(store.read().values.hideThinkingBlock, true);
});

await test("invalid persisted settings fail startup instead of silently resetting", async (t) => {
  const f = await fixture(t);
  const path = join(f.workspace, "settings.json");
  await writeFile(path, JSON.stringify({ values: { transport: "invalid" } }));
  await assert.rejects(GlobalSettingsStore.open(path));
});

await test("queued compaction duration resolves its submission, including after reset and fork", async (t) => {
  const f = await fixture(t);
  const sessions = await Sessions.open({
    ...f.options,
    directory: join(f.workspace, "state"),
    settings: { compaction: { keepRecentTokens: 1 } },
  });
  t.after(() => sessions.close());
  const session = await sessions.create(randomUUID(), f.binding, model);
  for (const entry of benchmarkFixture(2).view.entries)
    await session.root.submit(
      { type: "write", entry: { kind: entry.kind, model: entry.model } },
      context,
    );
  const generating = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  t.after(() => release.resolve());
  f.faux.setResponses([
    async () => {
      generating.resolve();
      await release.promise;
      return fauxAssistantMessage("Finished.");
    },
    fauxAssistantMessage("A checkpoint while generation is busy."),
  ]);
  await session.root.submit(
    { type: "input", content: "Continue.", requestId: randomUUID() },
    context,
  );
  await generating.promise;
  const taskId = await session.root.compact(undefined, context);
  const receipt = await session.harness.waitForTask(taskId, context);
  assert.equal(receipt.state.outcome.status, "completed");
  assert.equal(
    (await readHistory(session.root)).some((entry) => entry.kind === "pi.compaction"),
    false,
  );
  release.resolve();
  await session.root.waitForIdle(context);
  const entry = (await readHistory(session.root)).find((entry) => entry.kind === "pi.compaction");
  assert(entry);
  assert.notEqual(entry.byTaskId, taskId);
  const task = await session.harness.getTask(taskId, context);
  assert(task?.startedAt !== undefined && task.endedAt !== undefined);
  const duration = task.endedAt - task.startedAt;
  await session.root.reset(undefined, context);
  const last = (await readHistory(session.root)).at(-1);
  assert(last);
  const branch = await session.root.fork(last.id, { ownership: { kind: "ownerless" } }, context);
  const base = await serve(t, sessions);
  for (const conversation of [session.root, branch]) {
    const history = await (
      await fetch(base + conversationURL(session, conversation.id) + "/export")
    ).json();
    assert(history.some((item: { id: number }) => item.id === entry.id));
    const recorded = await session.harness.getTask(taskId, context);
    assert(recorded?.startedAt !== undefined && recorded.endedAt !== undefined);
    assert.equal(recorded.endedAt - recorded.startedAt, duration);
    assert.equal(recorded.state.outcome?.status, "completed");
    assert(recorded.state.outcome?.status === "completed");
    const result = recorded.state.outcome.result as {
      submissionId: import("@earendil-works/pi-durable").SubmissionId;
    };
    const handle = await session.harness.submission(result.submissionId, context);
    assert(handle);
    const submission = await handle.status(context);
    assert(submission);
    assert.equal(submission.entry, entry.id);
  }
});

await test("Durable scans preserve filters, pages, and cursor ordering defaults", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  for (let n = 0; n < 5; n++)
    await session.root.submit({ type: "write", entry: { kind: "marker", data: { n } } }, context);
  const history = await readHistory(session.root);
  const first = await session.root.entries({ order: "ascending" }, 2, undefined, context);
  assert.deepEqual(
    first.items.map((entry) => entry.id),
    history.slice(0, 2).map((entry) => entry.id),
  );
  assert(first.next);
  // The cursor carries the order; the next call need not repeat it.
  const second = await session.root.entries({}, 2, first.next, context);
  assert.deepEqual(
    second.items.map((entry) => entry.id),
    history.slice(2, 4).map((entry) => entry.id),
  );
  assert(second.next);
  const last = await session.root.entries({}, 2, second.next, context);
  assert.deepEqual(
    last.items.map((entry) => entry.id),
    history.slice(4).map((entry) => entry.id),
  );
  const query = {
    minEntryId: first.items[1].id,
    maxEntryId: second.items[0].id,
    order: "ascending" as const,
  };
  const bounded = await session.root.entries(query, 256, undefined, context);
  assert.deepEqual(
    bounded.items.map((entry) => entry.id),
    [query.minEntryId, query.maxEntryId],
  );
  const scans = await session.harness.commit(
    async (tx) => ({
      tasks: await tx.scanTasks({}, 256),
      conversations: await tx.scanConversations({}, 256),
    }),
    context,
  );
  assert.deepEqual(scans.tasks.items, []);
  assert.deepEqual(
    scans.conversations.items.map((conversation) => conversation.id),
    [session.root.id],
  );
});

await test("server registers built-in models from environment credentials without a local execution target", async (t) => {
  for (const host of [undefined, "127.0.0.2"]) {
    await t.test(host ?? "default host", async (t) => {
      const directory = await mkdtemp(join(tmpdir(), "serve-startup-"));
      t.after(() => rm(directory, { recursive: true, force: true }));
      const address = host ?? "127.0.0.1";
      const reservation = createServer();
      await new Promise<void>((resolve) => reservation.listen(0, address, resolve));
      const port = (reservation.address() as AddressInfo).port;
      await new Promise<void>((resolve) => reservation.close(() => resolve()));
      const child = spawn(
        process.execPath,
        [
          // The fixture has an empty inventory; use a fixed instance-owner identity.
          "--import",
          'data:text/javascript,import { mock } from "node:test"; mock.method(process, "getuid", () => 1000);',
          fileURLToPath(new URL("../server.ts", import.meta.url)),
        ],
        {
          env: {
            ...process.env,
            HOST: host,
            PORT: String(port),
            HOME: directory,
            XDG_STATE_HOME: join(directory, "state"),
            PATH: "",
            ANTHROPIC_API_KEY: "test-only-api-key",
          },
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
      await checkCLI(
        child,
        `http://${address}:${port}/?data=1`,
        (response) =>
          response.json() as Promise<{
            sessions: unknown[];
            targets: unknown[];
            models: { key: string }[];
            target: string;
          }>,
        async (catalog) => {
          assert.deepEqual(catalog.sessions, []);
          assert.deepEqual(catalog.targets, []);
          assert.equal(catalog.target, "");
          assert(catalog.models.some(({ key }) => JSON.parse(key)[0] === "anthropic"));
        },
      );
    });
  }
});

await test("conversation file previews read the bound environment without changing model context", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const base = await serve(t, f.sessions);
  const url = base + conversationURL(session);
  const image = await readFile(new URL("../icon-192.png", import.meta.url));
  await writeFile(join(f.workspace, "image.bin"), image);
  await writeFile(join(f.workspace, "source.ts"), "export const value = 1;\n");
  await writeFile(join(f.workspace, "unknown.constructor"), "plain text");
  await writeFile(
    join(f.workspace, "active.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  );
  await writeFile(join(f.workspace, "binary"), new Uint8Array([0, 255]));
  const largeImage = Buffer.concat([image, Buffer.alloc(10 * 1024 * 1024)]);
  await writeFile(join(f.workspace, "large-image.bin"), largeImage);
  await writeFile(join(f.workspace, "large-text"), "a".repeat(1024 * 1024 + 1));
  await writeFile(join(f.workspace, "many-lines"), "\n".repeat(20_000));
  const before = await readHistory(session.root);
  const modelContext = await session.root.context(context);
  for (const [path, expected] of [
    ["image.bin", image],
    [join(f.workspace, "image.bin"), image],
    ["large-image.bin", largeImage],
  ] as const) {
    const response = await fetch(`${url}/file?path=${encodeURIComponent(path)}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), "image/png");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
  }
  for (const path of [
    "source.ts",
    "active.svg",
    "large-text",
    "many-lines",
    "unknown.constructor",
  ]) {
    const source = await fetch(`${url}/file?path=${path}`);
    assert.equal(source.status, 200);
    assert.equal(source.headers.get("Content-Type"), "text/html; charset=utf-8");
    await source.arrayBuffer();
  }
  for (const [suffix, status] of [
    ["file?path=binary", 415],
    ["file?path=missing", 404],
    ["file?path=.", 400],
    ["file", 400],
    ["file?path=%00", 400],
    ["file?path=source.ts&path=image.bin", 400],
  ] as const) {
    assert.equal((await fetch(`${url}/${suffix}`)).status, status, suffix);
  }
  assert.equal(
    (await fetch(`${url}/file?path=image.bin`, { headers: { Origin: "https://other.example" } }))
      .status,
    403,
  );
  assert.deepEqual(await readHistory(session.root), before);
  assert.deepEqual(await session.root.context(context), modelContext);
});

await test("file previews revalidate actual response content across edits and cwd changes", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const base = await serve(t, f.sessions);
  const url = base + conversationURL(session) + "/file?path=";
  const image = await readFile(new URL("../icon-192.png", import.meta.url));
  await writeFile(join(f.workspace, "image.png"), image);
  const sourcePath = join(f.workspace, "source.ts");
  await writeFile(sourcePath, "one\n");
  await utimes(sourcePath, new Date(0), new Date(0));
  for (const path of ["image.png", "source.ts"]) {
    const first = await fetch(url + path);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("cache-control"), "private, no-cache");
    const etag = first.headers.get("etag");
    assert(etag);
    const bytes = await first.arrayBuffer();
    for (const condition of [etag, `W/${etag}`, `"other,tag", W/${etag}`, "*"]) {
      const cached = await fetch(url + path, { headers: { "If-None-Match": condition } });
      assert.equal(cached.status, 304);
      assert.equal(cached.headers.get("etag"), etag);
      assert.equal(cached.headers.get("cache-control"), "private, no-cache");
      assert.equal((await cached.arrayBuffer()).byteLength, 0);
    }
    const fresh = await fetch(url + path, { headers: { "If-None-Match": '"different"' } });
    assert.equal(fresh.status, 200);
    assert.equal(fresh.headers.get("etag"), etag);
    assert.deepEqual(await fresh.arrayBuffer(), bytes);
  }
  const original = await fetch(url + "source.ts");
  const originalTag = original.headers.get("etag");
  assert(originalTag);
  await original.arrayBuffer();
  // Source views include the displayed path: hash rendered HTML, not just file bytes.
  const alias = await fetch(url + encodeURIComponent(sourcePath));
  assert.equal(alias.status, 200);
  assert.notEqual(alias.headers.get("etag"), originalTag);
  await alias.arrayBuffer();
  const before = await stat(sourcePath);
  await writeFile(sourcePath, "two\n");
  await utimes(sourcePath, before.atime, before.mtime);
  const after = await stat(sourcePath);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
  const changed = await fetch(url + "source.ts", { headers: { "If-None-Match": originalTag } });
  assert.equal(changed.status, 200);
  const changedTag = changed.headers.get("etag");
  assert(changedTag);
  assert.notEqual(changedTag, originalTag);
  await changed.arrayBuffer();
  await mkdir(join(f.workspace, "nested"));
  await writeFile(join(f.workspace, "nested", "source.ts"), "new cwd\n");
  await runtime.changeDirectory(session, "nested", session.root, context);
  const moved = await fetch(url + "source.ts", { headers: { "If-None-Match": changedTag } });
  assert.equal(moved.status, 200);
  assert.notEqual(moved.headers.get("etag"), changedTag);
  await moved.arrayBuffer();
  await rm(join(f.workspace, "nested", "source.ts"));
  const missing = await fetch(url + "source.ts", { headers: { "If-None-Match": "*" } });
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("etag"), null);
  assert.equal(missing.headers.get("cache-control"), "no-store");
});
