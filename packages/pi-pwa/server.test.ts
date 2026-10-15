import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { Connection, localDaemon, RemoteExecutionEnv } from "@earendil-works/pi-env";
import { chromium } from "playwright";
import { httpServer, RequestError, Sessions, type Instance, type Snapshot } from "./server.ts";

const context = BACKGROUND_CONTEXT;
const model = { provider: "faux", modelId: "faux-1" };

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "pi-pwa-state-"));
  const workspace = await mkdtemp(join(tmpdir(), "pi-pwa-guest-"));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const instances: Instance[] = [{ id: "test1", reference: "path:/test", running: true }];
  const options = {
    directory,
    models,
    instances: async () => instances,
    connect: () => {
      const connection = new Connection({ command: [localDaemon()] });
      return {
        env: new RemoteExecutionEnv({ connection, id: workspace, cwd: workspace }),
        close: () => connection.close(),
      };
    },
  };
  let sessions = await Sessions.open(options);
  t.after(async () => {
    await sessions.close();
    await rm(directory, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  });
  return {
    directory,
    workspace,
    faux,
    instances,
    options,
    get sessions() {
      return sessions;
    },
    async reopen() {
      await sessions.close();
      sessions = await Sessions.open(options);
    },
  };
}
function status(code: number) {
  return (error: unknown) => error instanceof RequestError && error.status === code;
}
async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const end = Date.now() + 5000;
  while (!(await predicate())) {
    assert(Date.now() < end, "State transition timed out");
    await delay(10);
  }
}
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
async function serve(t: TestContext, sessions: Sessions, assets?: string) {
  const server = httpServer(sessions, "127.0.0.1", assets);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function snapshot(url: string): Promise<Snapshot> {
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal });
  assert.equal(response.status, 200);
  assert(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (!text.includes("\n\n")) {
      const part = await reader.read();
      assert.equal(part.done, false);
      text += decoder.decode(part.value, { stream: true });
    }
    return JSON.parse(text.slice(6, text.indexOf("\n\n"))) as Snapshot;
  } finally {
    controller.abort();
    reader.releaseLock();
  }
}
function post(url: string, data: unknown) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

await test("session creation requires a running instance and an available model", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.sessions.create(randomUUID(), "missing", model), status(409));
  f.instances[0].running = false;
  await assert.rejects(f.sessions.create(randomUUID(), "test1", model), status(409));
  f.instances[0].running = true;
  await assert.rejects(
    f.sessions.create(randomUUID(), "test1", { provider: "missing", modelId: "missing" }),
    status(400),
  );
  assert.equal((await f.sessions.catalog()).sessions.length, 0);
  assert.equal(f.faux.state.callCount, 0);
});

await test("one writer owns the store; concurrent creation is idempotent", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    Sessions.open(f.options),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ELOCKED",
  );
  const id = randomUUID();
  const results = await Promise.all(
    Array.from({ length: 8 }, () => f.sessions.create(id, "test1", model)),
  );
  for (const result of results) assert.equal(result, results[0]);
  assert.equal((await f.sessions.catalog()).sessions.length, 1);
  const before = await results[0].info();
  await f.reopen();
  assert.deepEqual(await (await f.sessions.get(id)).info(), before);
});

await test("coding tools use the pi-env daemon, never the server's working directory", async (t) => {
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
  const session = await f.sessions.create(randomUUID(), "test1", model);
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
  assert.equal((await post(base + "/api/sessions", { id, instance: "test1", model })).status, 201);
  const url = `${base}/api/sessions/${id}`;
  const data = { text: "Work", requestId: randomUUID() };
  assert.equal((await post(url + "/prompt", data)).status, 200);
  await started.promise;
  assert.equal((await snapshot(url + "/events")).session.id, id);
  assert.equal((await post(url + "/prompt", data)).status, 200);
  finish.resolve();
  const session = await f.sessions.get(id);
  await session.root.waitForIdle(context);
  const reconnected = await snapshot(url + "/events");
  assert.equal(
    reconnected.history
      ?.flatMap((entry) => entry.model ?? [])
      .filter((message) => message.role === "user").length,
    1,
  );
  assert.equal(f.faux.state.callCount, 1);
  assert.equal((await session.harness.inspect(context)).tasks.length, 0);
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
  const session = await f.sessions.create(randomUUID(), "test1", model);
  await session.prompt("Work until interrupted.", randomUUID());
  await started.promise;
  await f.reopen();
  const restored = await f.sessions.get(session.id);
  assert.equal(restored.needsResume, true);
  await restored.history();
  await f.sessions.catalog();
  assert.equal(f.faux.state.callCount, 1);
  await assert.rejects(restored.prompt("New work", randomUUID()), status(409));
  await assert.rejects(restored.stop(), status(409));
  f.faux.setResponses([fauxAssistantMessage("Other session."), fauxAssistantMessage("Resumed.")]);
  const other = await f.sessions.create(randomUUID(), "test1", model);
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

await test("stop aborts a running guest process group", async (t) => {
  const f = await fixture(t);
  f.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("bash", { command: "touch started; sleep 30; touch finished" }),
      { stopReason: "toolUse" },
    ),
  ]);
  const session = await f.sessions.create(randomUUID(), "test1", model);
  await session.prompt("Run a long command.", randomUUID());
  await waitFor(() => exists(join(f.workspace, "started")));
  await session.stop();
  assert.equal((await session.harness.inspect(context)).tasks.length, 0);
  assert.equal(await exists(join(f.workspace, "finished")), false);
});

await test("unavailable instances retain readable history but cannot run new work", async (t) => {
  const f = await fixture(t);
  const session = await f.sessions.create(randomUUID(), "test1", model);
  f.instances.length = 0;
  assert.equal((await f.sessions.catalog()).sessions.length, 1);
  assert.equal((await session.history()).length, 0);
  await assert.rejects(session.prompt("Work", randomUUID()), status(409));
  await assert.rejects(session.resume(), status(409));
  assert.equal(f.faux.state.callCount, 0);
});

await test("HTTP validates origins, IDs, methods, JSON and request size", async (t) => {
  const f = await fixture(t);
  const base = await serve(t, f.sessions);
  assert.equal(
    (await fetch(base + "/api/catalog", { headers: { Origin: "https://untrusted.example" } }))
      .status,
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
    (await fetch(base + "/api/catalog", { headers: { "Sec-Fetch-Site": "cross-site" } })).status,
    403,
  );
  assert.equal((await fetch(base + "/api/catalog")).status, 200);
  assert.equal((await fetch(base + "/api/sessions/bad/events")).status, 404);
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
  const session = await f.sessions.create(randomUUID(), "test1", model);
  assert.equal((await fetch(base + `/api/sessions/${session.id}/stop`)).status, 405);
  assert.equal((await fetch(base + "/manifest.webmanifest")).status, 200);
  const icon = await fetch(base + "/icon.svg");
  assert.equal(icon.status, 200);
  assert.equal((await f.sessions.catalog()).sessions.length, 1);
});

await test("mobile browser creates a session, runs tools, reconnects and renders untrusted text safely", async (t) => {
  const f = await fixture(t);
  const assets = await mkdtemp(join(tmpdir(), "pi-pwa-assets-"));
  t.after(() => rm(assets, { recursive: true, force: true }));
  const source = dirname(fileURLToPath(import.meta.url));
  await writeFile(
    join(assets, "client.js"),
    stripTypeScriptTypes(await readFile(join(source, "client.ts"), "utf8")),
  );
  await writeFile(join(assets, "index.html"), await readFile(join(source, "index.html")));
  const base = await serve(t, f.sessions, assets);
  const executablePath =
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
    (process.env.PATH ?? "")
      .split(delimiter)
      .map((path) => join(path, "chromium"))
      .find(existsSync);
  assert(executablePath, "Chromium is required for browser tests; use nix develop.");
  const browser = await chromium.launch({ executablePath });
  t.after(() => browser.close());
  const browserContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await browserContext.newPage();
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("write", { path: "browser.json", content: '{"value":31}' }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage('<img src=x onerror="document.body.dataset.injected=1">'),
  ]);
  await page.goto(base);
  await page.waitForFunction(
    () => document.querySelector<HTMLSelectElement>("#models")?.options.length === 2,
  );
  await page.selectOption("#instances", "test1");
  await page.selectOption("#models", "0");
  await page.click("#create");
  await page.waitForFunction(() => new URL(location.href).searchParams.has("session"));
  const url = page.url();
  const id = new URL(url).searchParams.get("session");
  assert(id);
  await page.fill("#prompt", "Run the browser integration test.");
  await page.click("#send");
  const session = await f.sessions.get(id);
  await waitFor(() => exists(join(f.workspace, "browser.json")));
  await session.root.waitForIdle(context);
  assert.deepEqual(JSON.parse(await readFile(join(f.workspace, "browser.json"), "utf8")), {
    value: 31,
  });
  await page.waitForFunction(() => document.querySelectorAll("#transcript article").length === 4);
  assert.equal(await page.locator("#transcript img").count(), 0);
  assert.equal(await page.evaluate(() => document.body.dataset.injected), undefined);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.close();
  const reconnected = await browserContext.newPage();
  reconnected.on("pageerror", (error) => errors.push(error));
  await reconnected.goto(url);
  await reconnected.waitForFunction(
    () => document.querySelectorAll("#transcript article").length === 4,
  );
  assert.equal((await f.sessions.catalog()).sessions.length, 1);
  assert.equal(f.faux.state.callCount, 2);
  assert.equal(errors.length, 0);
});
