import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { chromium } from "playwright";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { localIntegration, SessionError, type Integration } from "../pi-runtime/index.ts";
import { fixture, model } from "../pi-runtime/testing.ts";
import { buildAssets } from "./build.ts";
import { post, serve } from "./testing.ts";

const context = BACKGROUND_CONTEXT;

// Frontend contract fixture. The drv.run suite separately exercises the real pi-env daemon.
async function directoryFixture(t: TestContext, root?: string) {
  const f = await fixture(t);
  const binding = { provider: "test", target: "guest", cwd: root ?? f.workspace };
  let available = true;
  let connections = 0;
  const integration: Integration = {
    id: "test",
    directoryRoot: binding.cwd,
    async targets() {
      return [{ ...binding, label: "Guest", available }];
    },
    async validate(value) {
      assert.deepEqual(value, binding);
      if (!available) throw new SessionError("unavailable", "Guest stopped.");
    },
    open() {
      connections++;
      const env = new NodeExecutionEnv({ cwd: binding.cwd });
      return {
        env,
        atDirectory: (cwd) => new NodeExecutionEnv({ cwd }),
        close: () => env.cleanup(context),
      };
    },
  };
  await f.reopen([integration]);
  return {
    ...f,
    get sessions() {
      return f.sessions;
    },
    binding,
    integration,
    stop() {
      available = false;
    },
    get connections() {
      return connections;
    },
  };
}

await test("HTTP base directory is stored in Durable cwd, validates input, and defaults to /workspace", async (t) => {
  const f = await directoryFixture(t, "/workspace");
  const base = await serve(t, f.sessions);
  const create = (baseDirectory?: unknown) =>
    post(base + "/api/sessions", {
      id: randomUUID(),
      binding: f.binding,
      model,
      baseDirectory,
    });
  for (const input of [undefined, "", "foo", "/foo", "/foo/"]) {
    const response = await create(input);
    assert.equal(response.status, 201);
    const info = await response.json();
    const session = await f.sessions.get(info.id);
    assert.equal(info.cwd, input ? "/workspace/foo" : "/workspace");
    assert.equal((await session.root.agent(context)).cwd, info.cwd);
  }
  for (const input of [null, 1, {}, "../etc", "a\nb", "x".repeat(4097)])
    assert.equal((await create(input)).status, 400);
  const info = await (await create("one")).json();
  const configure = (baseDirectory?: unknown) =>
    post(`${base}/api/sessions/${info.id}/configure`, {
      model,
      thinkingLevel: "off",
      instructions: "",
      baseDirectory,
    });
  const session = await f.sessions.get(info.id);
  assert.equal((await configure()).status, 200);
  assert.equal(
    (await session.root.agent(context)).cwd,
    "/workspace/one",
    "old clients preserve cwd",
  );
  assert.equal((await configure("/two")).status, 200);
  assert.equal((await session.root.agent(context)).cwd, "/workspace/two");
  assert.equal((await configure("../outside")).status, 400);
  assert.equal((await configure(null)).status, 400);
  assert.equal((await session.root.agent(context)).cwd, "/workspace/two");
  assert.equal((await configure("")).status, 200);
  assert.equal((await session.root.agent(context)).cwd, "/workspace");
  assert.deepEqual(session.binding, f.binding);
  for (const query of [null, 3, "../", "/../", "\0", "x".repeat(4097)])
    assert.equal(
      (await post(base + "/api/directories", { binding: f.binding, query })).status,
      400,
    );
  f.stop();
  assert.equal(
    (await post(base + "/api/directories", { binding: f.binding, query: "" })).status,
    409,
  );
  assert.equal(f.connections, 0, "validation does not connect or execute tools");
});

await test("mobile browser exposes remote directory suggestions for new sessions and conversation settings", async (t) => {
  const f = await directoryFixture(t);
  await f.reopen([f.integration, localIntegration(f.workspace)]);
  await mkdir(join(f.workspace, "one"));
  await mkdir(join(f.workspace, "two"));
  await writeFile(join(f.workspace, "only-file.txt"), "file");
  const assets = join(f.directory, "assets");
  await buildAssets(fileURLToPath(new URL(".", import.meta.url)), assets);
  const base = await serve(t, f.sessions, assets);
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));
  await page.goto(base);
  await page.waitForSelector("#picker[open]");
  const remote = JSON.stringify([f.binding.provider, f.binding.target, f.binding.cwd]);
  await page.selectOption("#targets", remote);
  await page.waitForSelector("#new-directory-field", { state: "visible" });
  await page.fill("#new-directory", "/o");
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLDataListElement>("#new-directories")?.options[0]?.value ===
      "/one/",
  );
  assert.deepEqual(
    await page
      .locator("#new-directories option")
      .evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).value)),
    ["/one/"],
  );
  await page.fill("#new-directory", "/one/");
  await page.click("#create");
  await page.waitForSelector("#picker[open]", { state: "hidden" });
  const id = new URL(page.url()).searchParams.get("session");
  assert(id);
  const session = await f.sessions.get(id);
  assert.equal((await session.root.agent(context)).cwd, join(f.workspace, "one"));
  await page.fill("#prompt", "/settings");
  await page.keyboard.press("Control+Enter");
  await page.waitForSelector("#preferences[open]");
  assert.equal(await page.inputValue("#session-directory"), "one");
  await page.fill("#session-directory", "t");
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLDataListElement>("#session-directories")?.options[0]?.value ===
      "two/",
  );
  await page.fill("#session-directory", "/two");
  await page.click("#save-settings");
  await page.waitForSelector("#preferences[open]", { state: "hidden" });
  assert.equal((await session.root.agent(context)).cwd, join(f.workspace, "two"));
  await page.reload();
  await page.waitForFunction(
    () => !document.querySelector<HTMLButtonElement>("#settings")?.disabled,
  );
  await page.fill("#prompt", "/settings");
  await page.keyboard.press("Control+Enter");
  await page.waitForSelector("#preferences[open]");
  assert.equal(await page.inputValue("#session-directory"), "two");
  await page.fill("#session-directory", "");
  await page.click("#save-settings");
  await page.waitForSelector("#preferences[open]", { state: "hidden" });
  assert.equal((await session.root.agent(context)).cwd, f.workspace);
  await page.fill("#prompt", "/sessions");
  await page.keyboard.press("Control+Enter");
  await page.waitForSelector("#picker[open]");
  await page.selectOption("#targets", JSON.stringify(["local", f.workspace, f.workspace]));
  assert.equal(await page.locator("#new-directory-field").isVisible(), false);
  assert.deepEqual(errors, []);
  assert.equal(f.faux.state.callCount, 0);
});
