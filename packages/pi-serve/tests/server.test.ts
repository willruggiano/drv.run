import { openCodingSessions } from "../../pi-runtime/coding.ts";
import { openApplication } from "../application.ts";
import * as runtime from "../../pi-runtime/index.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT, awaitWithContext, type Context } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { readHistory, fixture, model } from "../../pi-runtime/testing.ts";
import { chromiumExecutable, directoryFixture, serve, snapshot, post } from "./testing.ts";
import { GlobalSettingsStore, parseOptions } from "../server.ts";
import { benchmarkFixture, benchmarkOptions } from "../benchmark.ts";
import { buildAssets } from "../build.ts";

import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { Catalog } from "../../pi-runtime/index.ts";
import type { GlobalSettings } from "../settings.ts";

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
  const directory = await mkdtemp(join(tmpdir(), "pi-serve-browser-path-"));
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

async function checkCLI(
  child: ChildProcess,
  url: string,
  check: (catalog: Catalog) => void | Promise<void>,
  startupTimeout = 30_000,
): Promise<void> {
  assert(child.stderr, "CLI stderr must be piped for startup diagnostics.");
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (text: string) => {
    stderr += text;
  });
  const startup = new AbortController();
  const ended = new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
    child.once("close", (code, signal) => resolve([code, signal]));
  });
  child.once("error", (error) => startup.abort(error));
  child.once("exit", (code, signal) => {
    startup.abort(new Error("CLI exited before readiness", { cause: { code, signal } }));
  });
  const timeout = setTimeout(() => {
    startup.abort(new DOMException("CLI startup timed out", "TimeoutError"));
  }, startupTimeout);
  const cleanup = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await ended;
  };
  try {
    let catalog: Catalog;
    try {
      for (;;) {
        startup.signal.throwIfAborted();
        const response = await fetch(url, { signal: startup.signal }).catch(() => undefined);
        startup.signal.throwIfAborted();
        if (response?.ok) {
          catalog = await response.json();
          break;
        }
        await response?.body?.cancel();
        await delay(10, undefined, { signal: startup.signal });
      }
    } catch (error) {
      // Drain stderr and reap the child before reporting the original startup failure.
      const cause = startup.signal.aborted ? startup.signal.reason : error;
      await cleanup();
      throw new Error(`CLI startup failed. Stderr:\n${stderr || "(empty)"}`, {
        cause,
      });
    }
    clearTimeout(timeout);
    await check(catalog);
    child.kill("SIGTERM");
    const forceKill = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      assert.deepEqual(await ended, [0, null]);
    } finally {
      clearTimeout(forceKill);
    }
  } finally {
    clearTimeout(timeout);
    // Cleanup must not assert graceful shutdown or replace an earlier test failure.
    await cleanup();
  }
}

await test("server starts standalone without host commands", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-serve-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  {
    const reservation = createServer();
    await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const port = (reservation.address() as AddressInfo).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("../server.ts", import.meta.url)),
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--state",
        join(directory, "state"),
        "--cwd",
        directory,
      ],
      {
        env: {
          ...process.env,
          PATH: "",
          PI_OFFLINE: "1",
          PI_CODING_AGENT_DIR: join(directory, "agent"),
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    await checkCLI(child, `http://127.0.0.1:${port}/api/catalog`, (catalog) => {
      assert.deepEqual(catalog.sessions, []);
      assert.deepEqual(catalog.targets, [
        {
          provider: "local",
          target: directory,
          cwd: directory,
          label: `Local · ${directory}`,
          available: true,
        },
      ]);
    });
  }
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
  const f = await fixture(t);
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  f.faux.setResponses([
    async () => {
      started.resolve();
      await finish.promise;
      return fauxAssistantMessage("Done.");
    },
  ]);
  t.after(() => finish.resolve());
  const base = await serve(t, f.sessions);
  const id = randomUUID();
  assert.equal((await post(base + "/api/sessions", { id, binding: f.binding, model })).status, 201);
  const url = `${base}/api/harness/${id}`;
  const data = { type: "input", content: "Work", requestId: "retryable-input" };
  assert.equal((await post(url + "/submit", data)).status, 200);
  await started.promise;
  const session = await f.sessions.get(id);
  const views = t.mock.method(session.root, "watch");
  assert.equal((await snapshot(url + "/watch")).session.id, id);
  const view = await views.mock.calls[0].result;
  assert(view);
  assert.deepEqual(await view.closed, { reason: "cancelled" });
  const documents = t.mock.method(session.harness, "watchDoc");
  const response = await fetch(url + "/watchDoc?kind=pi.agent");
  assert.equal(response.status, 200);
  assert(response.body);
  await response.body.cancel();
  const document = await documents.mock.calls[0].result;
  assert(document);
  assert.deepEqual(await document.closed, { reason: "cancelled" });
  assert.equal((await post(url + "/submit", data)).status, 200);
  finish.resolve();
  await session.root.waitForIdle(context);
  const reconnected = await snapshot(url + "/watch");
  assert.equal(
    reconnected.history
      ?.flatMap((entry) => entry.model ?? [])
      .filter((message) => message.role === "user").length,
    1,
  );
  assert.equal(f.faux.state.callCount, 1);
  assert.equal((await session.harness.inspect(context)).tasks.length, 0);
});

await test("HTTP validates origins, IDs, methods, JSON and request size", async (t) => {
  const f = await fixture(t);
  const base = await serve(t, f.sessions);
  assert.equal(
    (
      await fetch(base + "/api/catalog", {
        headers: { Origin: "https://untrusted.example" },
      })
    ).status,
    403,
  );
  const rebinding = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(
      base + "/api/catalog",
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
      await fetch(base + "/api/catalog", {
        headers: { "Sec-Fetch-Site": "cross-site" },
      })
    ).status,
    403,
  );
  assert.equal((await fetch(base + "/api/catalog")).status, 200);
  assert.equal((await fetch(base + "/api/harness/bad/watch")).status, 404);
  assert.equal((await post(base + "/api/sessions", {})).status, 400);
  assert.equal(
    (
      await fetch(base + "/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      })
    ).status,
    400,
  );
  assert.equal((await post(base + "/api/sessions", { data: "a".repeat(129 * 1024) })).status, 413);
  const session = await f.sessions.create(randomUUID(), f.binding, model);
  assert.equal((await fetch(base + `/api/harness/${session.id}/abort`)).status, 405);
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
    const url = `http://${address}:${port}/api/catalog`;
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
  assert.equal((await fetch(`http://localhost:${port}/api/catalog`)).status, 200);
});

await test("CLI defaults to local execution and accepts explicit integration composition", () => {
  const defaults = parseOptions([]);
  assert.equal(defaults.host, "0.0.0.0");
  assert.equal(defaults.port, 8080);
  assert.equal(defaults.local, true);
  assert.equal(defaults.cwd, process.cwd());
  assert.equal(defaults.drvRun, false);
  const custom = parseOptions([
    "--no-local",
    "--drv-run",
    "--port",
    "9000",
    "--cwd",
    "/work",
    "--state",
    "/state",
  ]);
  assert.equal(custom.local, false);
  assert.equal(custom.drvRun, true);
  assert.equal(custom.cwd, "/work");
  assert.equal(custom.directory, "/state");
  assert.equal(custom.port, 9000);
  for (const args of [
    ["--no-local"],
    ["--port", "0"],
    ["--host", "::"],
    ["--cwd"],
    ["--unknown", "x"],
  ])
    assert.throws(() => parseOptions(args), Error);
});

await test("built highlighter preserves selected languages and is served as a static module", async (t) => {
  const assets = await mkdtemp(join(tmpdir(), "pi-serve-build-"));
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
  assert.equal(options.runs, 3);
  assert.equal(options.turns, 200);
  assert.equal(options.cpuRate, 1);
  assert.equal(options.profile, false);
  assert.equal(benchmarkOptions(["--profile"]).profile, true);
  assert.equal(
    benchmarkOptions(["--profile", "--profile-dir", "profiles"]).profileDir,
    resolve("profiles"),
  );
  assert.equal(benchmarkOptions(["--cpu-rate", "2.5"]).cpuRate, 2.5);
  for (const args of [
    ["--runs", "0"],
    ["--runs", "1.5"],
    ["--runs", "101"],
    ["--turns", "-1"],
    ["--turns", "10001"],
    ["--turns", "NaN"],
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

await test("conversation controls validate input and keep forks scoped to their session", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const base = await serve(t, f.sessions);
  const url = `${base}/api/harness/${session.id}`;
  f.faux.setResponses([fauxAssistantMessage("A completed turn.")]);
  await session.root.submit({ type: "input", content: "Begin.", requestId: randomUUID() }, context);
  await session.root.waitForIdle(context);
  const history = await readHistory(session.root);
  for (const [action, data] of [
    ["submit", { type: "input", content: "No", whenBusy: "invalid" }],
    ["submit", { type: "input", content: 123 }],
    ["configure", { thinkingLevel: "invalid" }],
    ["abortSubmission", { id: "wrong" }],
    ["fork", { at: -1 }],
  ] as const)
    assert.equal((await post(`${url}/${action}`, data)).status, 400);
  assert.equal(
    (
      await post(`${url}/configure`, {
        instructions: null,
        tools: { remove: [{ name: "not-installed" }] },
      })
    ).status,
    200,
  );
  assert.equal((await session.root.agent(context)).instructions, undefined);
  for (const name of [null, 123, "a".repeat(121), "line\nbreak"]) {
    assert.equal((await post(`${base}/api/sessions/${session.id}/rename`, { name })).status, 400);
  }
  const renamed = await post(`${base}/api/sessions/${session.id}/rename`, {
    name: "  Counter cleanup  ",
  });
  assert.equal(renamed.status, 200);
  assert.equal((await renamed.json()).name, "Counter cleanup");
  assert.equal(
    (await (await fetch(base + "/api/catalog")).json()).sessions[0].name,
    "Counter cleanup",
  );
  assert.deepEqual(await readHistory(session.root), history);
  assert.equal((await fetch(`${url}/watch?conversation=-1`)).status, 400);
  assert.equal((await fetch(`${url}/watch?conversation=9999999`)).status, 404);
  const forkResponse = await post(`${url}/fork`, {
    at: history.at(-1)?.id,
    options: { ownership: { kind: "ownerless" } },
  });
  assert.equal(forkResponse.status, 200);
  const fork = await forkResponse.json();
  const branch = await runtime.getConversation(session, fork.id);
  assert.deepEqual(await readHistory(branch), history);
  assert.equal((await fetch(`${url}/scanConversations`)).status, 200);
  const reset = await post(`${url}/reset?conversation=${fork.id}`, {
    handoff: "Carry this forward.",
  });
  assert.equal(reset.status, 200);
  assert.equal((await branch.context(context)).messages.length, 1);
  assert.deepEqual(await readHistory(session.root), history);
  const exported = await (await fetch(`${url}/entries?conversation=${fork.id}`)).json();
  assert.equal(exported.items.length, history.length + 1);
  assert.equal((await post(`${url}/compact?conversation=${fork.id}`, {})).status, 200);
  await session.harness.waitForIdle(context);
  assert.equal((await session.harness.inspect(context)).tasks.length, 0);
  const manifest = await (await fetch(base + "/manifest.webmanifest")).json();
  assert.equal(manifest.display, "standalone");
  assert.deepEqual(
    manifest.icons.map((icon: { sizes: string }) => icon.sizes),
    ["192x192", "512x512"],
  );
});

await test("HTTPS proxy origin is explicit and forwarded headers cannot bypass origin checks", async (t) => {
  const f = await fixture(t);
  const base = await serve(t, f.sessions, undefined, "127.0.0.1", "https://pi.example");
  const status = (headers: Record<string, string>) =>
    new Promise<number | undefined>((resolve, reject) => {
      const req = request(base + "/api/catalog", { headers }, (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      req.once("error", reject);
      req.end();
    });
  assert.equal(await status({ Host: "pi.example", Origin: "https://pi.example" }), 200);
  assert.equal(await status({ Host: "pi.example", Origin: "https://evil.example" }), 403);
  assert.equal(
    await status({
      Host: "evil.example",
      "X-Forwarded-Host": "pi.example",
      "X-Forwarded-Proto": "https",
    }),
    403,
  );
  for (const value of [
    "http://pi.example",
    "https://pi.example/path",
    "https://user:pass@pi.example",
    "https://pi.example?query",
    "https://pi.example#fragment",
  ])
    assert.throws(() => parseOptions(["--origin", value]));
  assert.equal(
    parseOptions(["--origin", "https://pi.example/"]).publicOrigin,
    "https://pi.example",
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
      const pending =
        operation === "directories"
          ? fetch(base + "/api/directories", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ binding: f.binding, query: "" }),
              signal: controller.signal,
            })
          : fetch(`${base}/api/sessions/${session.id}/${operation}`, { signal: controller.signal });
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
  const options = store.bind({
    directory: f.directory,
    models: f.options.models,
    cwd: f.workspace,
  });
  const sessions = await openApplication(options);
  assert.equal(sessions.options.defaults, options.defaults);
  t.after(() => sessions.close());
  const base = await serve(t, sessions, undefined, "127.0.0.1", undefined, store);
  const current = await sessions.create(randomUUID(), f.binding, model);
  assert.equal((await runtime.sessionInfo(current)).thinkingLevel, "medium");
  assert.equal(options.settings?.compaction?.reserveTokens, 12345);
  assert.equal(options.settings?.stream?.maxRetries, 0);
  const get = () =>
    fetch(base + "/api/settings").then((response) => response.json()) as Promise<GlobalSettings>;
  assert.equal((await get()).values.defaultThinkingLevel, "medium");
  const before = await get();
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
    assert.equal((await post(base + "/api/settings", data)).status, 400);
    assert.deepEqual(await get(), before);
  }
  const result = await post(base + "/api/settings", {
    model,
    modelThinkingLevel: "high",
    values: {
      defaultThinkingLevel: "low",
      "compaction.enabled": false,
      "retry.enabled": false,
      steeringMode: "all",
      followUpMode: "all",
      transport: "sse",
      hideThinkingBlock: true,
      "terminal.showImages": false,
    },
  });
  assert.equal(result.status, 200);
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
  const view = await snapshot(base + "/api/harness/" + current.id + "/watch");
  assert.equal(view.context.autoCompact, false);
  assert(view.inspection.state === "available");
  assert.equal(view.inspection.policy.enabled, false);
  assert.equal(view.inspection.policy.reserveTokens, 12345);
  assert.equal((await runtime.sessionInfo(current)).thinkingLevel, "medium");
  const created = await post(base + "/api/sessions", {
    id: randomUUID(),
    binding: f.binding,
    model,
  });
  assert.equal(created.status, 201);
  assert.equal((await created.json()).thinkingLevel, "high");
  const override = await post(base + "/api/sessions", {
    id: randomUUID(),
    binding: f.binding,
    model,
    thinkingLevel: "off",
  });
  assert.equal((await override.json()).thinkingLevel, "off");
  const invalid = await post(base + "/api/sessions", {
    id: randomUUID(),
    binding: f.binding,
    model,
    thinkingLevel: "invalid",
  });
  assert.equal(invalid.status, 400);
  const configured = await post(base + "/api/harness/" + current.id + "/configure", {
    model,
    thinkingLevel: "max",
    instructions: "",
  });
  assert.equal(configured.status, 200);
  assert.equal((await runtime.sessionInfo(current)).thinkingLevel, "max");
  assert.equal(
    (await post(base + "/api/settings", { model, modelThinkingLevel: null })).status,
    200,
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
  const sessions = await openCodingSessions({
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
      await fetch(`${base}/api/harness/${session.id}/entries?conversation=${conversation.id}`)
    ).json();
    assert(history.items.some((item: { id: number }) => item.id === entry.id));
    const task = await (
      await fetch(`${base}/api/harness/${session.id}/getTask?id=${taskId}`)
    ).json();
    assert.equal(task.endedAt - task.startedAt, duration);
    const submission = await (
      await fetch(
        `${base}/api/harness/${session.id}/submission/status?id=${task.state.outcome.result.submissionId}`,
      )
    ).json();
    assert.equal(submission.entry, entry.id);
  }
});

await test("HTTP preserves upstream scan filters, pages, and cursor ordering defaults", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  for (let n = 0; n < 5; n++)
    await session.root.submit({ type: "write", entry: { kind: "marker", data: { n } } }, context);
  const base = await serve(t, f.sessions);
  const url = `${base}/api/harness/${session.id}/entries`;
  for (const method of ["entries", "scanTasks", "scanConversations"]) {
    const resource = `${base}/api/harness/${session.id}/${method}`;
    for (const parameter of ["query", "cursor"])
      for (const invalid of ["not-json", "[]", "null"])
        assert.equal((await fetch(`${resource}?${parameter}=${invalid}`)).status, 400);
    assert.equal((await fetch(resource)).status, 200);
  }
  const first = await (
    await fetch(
      url + "?limit=2&query=" + encodeURIComponent(JSON.stringify({ order: "ascending" })),
    )
  ).json();
  const expected = await session.root.entries({ order: "ascending" }, 2, undefined, context);
  assert.deepEqual(
    first.items.map((entry: { id: number }) => entry.id),
    expected.items.map((entry) => entry.id),
  );
  assert.deepEqual(first.next, expected.next);
  const second = await (
    await fetch(url + "?limit=2&cursor=" + encodeURIComponent(JSON.stringify(first.next)))
  ).json();
  const next = await session.root.entries({}, 2, expected.next, context);
  assert.deepEqual(
    second.items.map((entry: { id: number }) => entry.id),
    next.items.map((entry) => entry.id),
  );
  const query = {
    minEntryId: first.items[1].id,
    maxEntryId: second.items[0].id,
    order: "ascending",
  };
  const bounded = await (
    await fetch(url + "?query=" + encodeURIComponent(JSON.stringify(query)))
  ).json();
  assert.deepEqual(
    bounded.items.map((entry: { id: number }) => entry.id),
    [query.minEntryId, query.maxEntryId],
  );
});
