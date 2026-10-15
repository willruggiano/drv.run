import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { chromium } from "playwright";
import type { Sessions, Snapshot, ExecutionBinding } from "../pi-runtime/index.ts";
import { exists, waitFor } from "../pi-runtime/testing.ts";
import { httpServer } from "./server.ts";

const context = BACKGROUND_CONTEXT;

export async function serve(
  t: TestContext,
  sessions: Sessions,
  assets?: string,
  host = "127.0.0.1",
) {
  const server = httpServer(sessions, host, assets);
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
export async function snapshot(url: string): Promise<Snapshot> {
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
export function post(url: string, data: unknown) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function browserFlow(
  t: TestContext,
  f: {
    sessions: Sessions;
    workspace: string;
    binding: ExecutionBinding;
    faux: ReturnType<typeof fauxProvider>;
    filePath?: string;
  },
) {
  const assets = await mkdtemp(join(tmpdir(), "pi-serve-assets-"));
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
    fauxAssistantMessage(
      fauxToolCall("write", { path: f.filePath ?? "browser.json", content: '{"value":31}' }),
      {
        stopReason: "toolUse",
      },
    ),
    fauxAssistantMessage('<img src=x onerror="document.body.dataset.injected=1">'),
  ]);
  await page.goto(base);
  await page.waitForFunction(
    () => document.querySelector<HTMLSelectElement>("#models")?.options.length === 2,
  );
  await page.selectOption(
    "#targets",
    JSON.stringify([f.binding.provider, f.binding.target, f.binding.cwd]),
  );
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
}
