import { Sessions } from "../sessions.ts";
import * as runtime from "../sessions.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { BACKGROUND_CONTEXT, awaitWithContext, type Context } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { readHistory, fixture, model } from "./sessions-testing.ts";
import { checkCLI, chromiumExecutable, directoryFixture, serve, post } from "./testing.ts";
import { GlobalSettingsStore, httpServer } from "../server.ts";
import { conversationURL } from "../hypermedia.ts";
import { modelKey, targetKey } from "../hypermedia-forms.ts";
import { benchmarkFixture, benchmarkOptions } from "../benchmark.ts";
import { buildAssets } from "../build.ts";

import { SettingsManager } from "@earendil-works/pi-coding-agent";
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
    (await post(base + "/sessions", { id, target: targetKey(f.binding), model: modelKey(model) }))
      .status,
    303,
  );
  const session = await f.sessions.get(id);
  const url = base + conversationURL(session);
  const data = { content: "Work", requestId: "retryable-input", whenBusy: "reject" };
  assert.equal((await post(url + "/submit", data)).status, 303);
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
  assert.equal((await post(url + "/submit", data)).status, 303);
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
      await fetch(base + "/sessions", {
        headers: { Origin: "https://untrusted.example" },
      })
    ).status,
    403,
  );
  const rebinding = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(
      base + "/sessions",
      { headers: { Host: "untrusted.example" } },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    req.once("error", reject);
    req.end();
  });
  assert.equal(rebinding, 403);
  assert.equal(
    (
      await fetch(base + "/sessions", {
        headers: { "Sec-Fetch-Site": "cross-site" },
      })
    ).status,
    403,
  );
  assert.equal((await fetch(base + "/sessions")).status, 200);
  assert.equal((await fetch(base + "/sessions/" + randomUUID())).status, 404);
  const malformed = await fetch(base + "/sessions", {
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
  assert.equal((await fetch(base + conversationURL(session) + "/abort")).status, 405);
  assert.equal((await fetch(base + "/sessions/manifest.webmanifest")).status, 200);
  const icon = await fetch(base + "/icon.svg");
  assert.equal(icon.status, 200);
  assert.equal((await f.sessions.catalog()).sessions.length, 1);
});

await test("wildcard binding accepts each destination but rejects spoofed hosts and cross-site requests", async (t) => {
  const f = await fixture(t);
  const base = await serve(t, f.sessions, undefined, "0.0.0.0");
  const port = new URL(base).port;
  for (const address of ["127.0.0.1", "127.0.0.2"]) {
    const url = `http://${address}:${port}/sessions`;
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
  assert.equal((await fetch(`http://localhost:${port}/sessions`)).status, 200);
});

await test("built highlighter preserves selected languages and is served as a static module", async (t) => {
  const assets = await mkdtemp(join(tmpdir(), "serve-build-"));
  t.after(() => rm(assets, { recursive: true, force: true }));
  await buildAssets(dirname(dirname(fileURLToPath(import.meta.url))), assets);
  const { default: highlighter }: { default: typeof import("highlight.js") } = await import(
    pathToFileURL(join(assets, "highlight.js")).href
  );
  assert.deepEqual(highlighter.listLanguages().sort(), [
    "bash",
    "css",
    "diff",
    "go",
    "javascript",
    "json",
    "nix",
    "python",
    "rust",
    "sql",
    "typescript",
    "xml",
  ]);
  for (const [alias, name] of [
    ["js", "javascript"],
    ["ts", "typescript"],
    ["html", "xml"],
  ])
    assert.equal(highlighter.getLanguage(alias), highlighter.getLanguage(name));
  const f = await fixture(t);
  const base = await serve(t, f.sessions, assets);
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
  assert.equal(options.frontend, "hypermedia");
  assert.equal(benchmarkOptions(["--frontend", "hypermedia"]).frontend, "hypermedia");
  assert.equal(options.runs, 3);
  assert.equal(options.turns, 200);
  assert.equal(options.cpuRate, 1);
  assert.equal(options.entries, 600);
  assert.equal(options.memory, false);
  const exact = benchmarkOptions(["--frontend", "hypermedia", "--entries", "2000", "--memory"]);
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
    ["--frontend", "hypermedia", "--entries", "0"],
    ["--frontend", "hypermedia", "--entries", "30001"],
    ["--frontend", "hypermedia", "--entries", "1.5"],
    ["--frontend", "hypermedia", "--entries", "NaN"],
    ["--frontend", "hypermedia", "--entries", "2000", "--turns", "200"],
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
    ["submit", { content: "No", whenBusy: "reject" }],
    ["settings", { ...settings, thinkingLevel: "invalid" }],
    ["cancel", { id: "wrong" }],
    ["fork", { at: "-1" }],
  ] as const)
    assert.equal((await post(`${url}/${action}`, data)).status, 400);
  assert.equal((await post(`${url}/settings`, settings)).status, 303);
  assert.equal((await session.root.agent(context)).instructions, "Keep configured instructions.");
  for (const name of ["a".repeat(121), "line\nbreak"])
    assert.equal((await post(`${url}/settings`, { ...settings, name })).status, 400);
  const renamed = await post(`${url}/settings`, { ...settings, name: "  Counter cleanup  " });
  assert.equal(renamed.status, 303);
  assert.equal((await runtime.sessionInfo(session)).name, "Counter cleanup");
  assert.equal((await f.sessions.catalog()).sessions[0].name, "Counter cleanup");
  assert.deepEqual(await readHistory(session.root), history);
  assert.equal((await fetch(base + `/sessions/${session.id}/conversations/not-an-id`)).status, 404);
  assert.equal((await fetch(base + `/sessions/${session.id}/conversations/9999999`)).status, 404);
  const forkResponse = await post(`${url}/fork`, { at: String(history.at(-1)!.id) });
  assert.equal(forkResponse.status, 303);
  const forkPath = forkResponse.headers.get("location");
  assert(forkPath);
  const branch = await runtime.getConversation(session, Number(forkPath.split("/").at(-1)));
  assert.deepEqual(await readHistory(branch), history);
  assert.equal((await fetch(`${url}/branches`)).status, 200);
  assert.equal(
    (await post(base + forkPath + "/reset", { argument: "Carry this forward." })).status,
    303,
  );
  assert.equal((await branch.context(context)).messages.length, 1);
  assert.deepEqual(await readHistory(session.root), history);
  const exported = await (await fetch(base + forkPath + "/export")).json();
  assert.equal(exported.length, history.length + 1);
  assert.equal((await post(base + forkPath + "/compact", {})).status, 303);
  await session.harness.waitForIdle(context);
  assert.equal((await session.harness.inspect(context)).tasks.length, 0);
  const manifest = await (await fetch(base + "/sessions/manifest.webmanifest")).json();
  assert.equal(manifest.display, "standalone");
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
        base + path + (submit ? "/submit" : ""),
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
      req.end(submit ? new URLSearchParams(data).toString() : undefined);
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
  assert.equal(await send(headers, true), 303);
  await session.root.waitForIdle(context);
  const history = await readHistory(session.root);
  assert(history.some((entry) => entry.kind === "pi.user"));
  assert.equal(await send(headers, true), 303);
  assert.deepEqual(await readHistory(session.root), history);
  assert.equal(f.faux.state.callCount, 1);
});

await test("forwarded headers cannot bypass origin checks", async (t) => {
  const f = await fixture(t);
  const base = await serve(t, f.sessions);
  const status = (headers: Record<string, string>) =>
    new Promise<number | undefined>((resolve, reject) => {
      const req = request(base + "/sessions", { headers }, (response) => {
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
    const exec = env.exec.bind(env);
    t.mock.method(env, "exec", async (...args: Parameters<typeof exec>) => {
      const context = args[2];
      entered.resolve(context);
      try {
        await awaitWithContext(release.promise, context);
        return await exec(...args);
      } finally {
        finished.resolve(context);
      }
    });
    await f.reopen({ ...f.execution, env: () => env, directoryEnv: () => env });
    const session = await f.sessions.create(randomUUID(), f.binding, model);
    const base = await serve(t, f.sessions);
    for (const operation of ["directories", "completions", "repository"]) {
      entered = Promise.withResolvers<Context>();
      finished = Promise.withResolvers<Context>();
      release = Promise.withResolvers<void>();
      const controller = new AbortController();
      t.after(() => controller.abort());
      const resource =
        operation === "directories"
          ? "/sessions/directories?" +
            new URLSearchParams({ target: targetKey(f.binding), baseDirectory: "" })
          : conversationURL(session) +
            (operation === "completions" ? "/completions?kind=path" : "/repository");
      const pending = fetch(base + resource, { signal: controller.signal });
      const rejected = assert.rejects(pending, { name: "AbortError" });
      const running = await entered.promise;
      assert(running.abortSignal);
      controller.abort();
      await rejected;
      const completed = await finished.promise;
      assert.equal(running.abortSignal.aborted, true);
      if (operation !== "repository") assert.equal(completed.abortSignal, undefined);
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

await test("global settings persist through Pi, preserve unrelated keys, and drive live Durable policy", async (t) => {
  const f = await fixture(t);
  await f.sessions.close();
  const agentDir = join(f.workspace, "agent");
  const path = join(agentDir, "settings.json");
  await mkdir(agentDir);
  await mkdir(join(f.workspace, ".pi"));
  await writeFile(
    join(f.workspace, ".pi", "settings.json"),
    JSON.stringify({ defaultThinkingLevel: "off", shellPath: "/untrusted" }),
  );
  await writeFile(
    path,
    JSON.stringify({
      defaultProvider: model.provider,
      defaultModel: model.modelId,
      theme: "light",
      shellPath: "/trusted",
      compaction: {
        reserveTokens: 12345,
        modelOverrides: { "faux/faux-1": { reserveTokens: 1 } },
      },
      retry: { maxRetries: 7, provider: { maxRetries: 0 } },
    }),
  );
  const store = new GlobalSettingsStore(
    SettingsManager.create(f.workspace, agentDir, { projectTrusted: false }),
  );
  const options = store.bind(f.options);
  const sessions = await Sessions.open(options);
  assert.equal(sessions.options.defaults, options.defaults);
  t.after(() => sessions.close());
  const base = await serve(t, sessions, undefined, "127.0.0.1", store);
  const current = await sessions.create(randomUUID(), f.binding, model);
  assert.equal((await runtime.sessionInfo(current)).thinkingLevel, "medium");
  assert.equal(options.settings?.compaction?.reserveTokens, 12345);
  assert.equal(options.settings?.stream?.maxRetries, 0);
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
    ["retry.enabled", "not-a-boolean"],
    ["model", "missing"],
  ]) {
    assert.equal(
      (await post(base + "/sessions/settings", { ...globalForm(), [key]: value })).status,
      400,
    );
    assert.deepEqual(get(), before);
  }
  const result = await post(base + "/sessions/settings", {
    ...globalForm(),
    model: modelKey(model),
    modelThinkingLevel: "high",
    defaultThinkingLevel: "low",
    "compaction.enabled": "false",
    "retry.enabled": "false",
    steeringMode: "all",
    followUpMode: "all",
    transport: "sse",
    hideThinkingBlock: "true",
    "terminal.showImages": "false",
  });
  assert.equal(result.status, 303);
  const persisted = SettingsManager.create(f.workspace, agentDir, {
    projectTrusted: false,
  });
  assert.equal(persisted.getDefaultThinkingLevel(), "low");
  assert.equal(persisted.getModelThinkingLevel(model.provider, model.modelId), "high");
  assert.equal(persisted.getTheme(), "light");
  assert.equal(persisted.getShellPath(), "/trusted");
  assert.equal(persisted.getCompactionReserveTokens(), 12345);
  assert.equal(
    persisted.getCompactionReserveTokens({
      provider: model.provider,
      id: model.modelId,
    }),
    1,
  );
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
    const response = await post(base + "/sessions", {
      id,
      target: targetKey(f.binding),
      model: modelKey(model),
      ...(thinkingLevel ? { thinkingLevel } : {}),
    });
    return { id, response };
  };
  const created = await create();
  assert.equal(created.response.status, 303);
  assert.equal((await runtime.sessionInfo(await sessions.get(created.id))).thinkingLevel, "high");
  const override = await create("off");
  assert.equal(override.response.status, 303);
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
  assert.equal(configured.status, 303);
  assert.equal((await runtime.sessionInfo(current)).thinkingLevel, "high");
  assert.equal(
    (
      await post(base + "/sessions/settings", {
        ...globalForm(),
        model: modelKey(model),
        modelThinkingLevel: "",
      })
    ).status,
    303,
  );
  assert.equal((await sessions.catalog()).models[0].defaultThinkingLevel, "low");
  // Verify the actual generation receives the policy, not only our settings object.
  f.faux.setResponses([
    (_context, stream) => {
      assert.equal(stream?.transport, "sse");
      assert.equal(stream?.maxRetries, 0);
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

await test("settings persistence failures are reported and never silently acknowledged", async (t) => {
  const f = await fixture(t);
  let raw = "{}";
  const manager = SettingsManager.fromStorage(
    {
      withLock(scope, change) {
        const next = change(scope === "global" ? raw : undefined);
        if (next !== undefined) throw new Error("Read-only settings");
      },
    },
    { projectTrusted: false },
  );
  const store = new GlobalSettingsStore(manager);
  await assert.rejects(store.update({ values: { hideThinkingBlock: true } }, f.sessions));
  assert.equal(store.read().values.hideThinkingBlock, false);
  assert.deepEqual(JSON.parse(raw), {});
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
