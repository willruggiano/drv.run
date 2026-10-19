import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { chromium } from "playwright";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { fixture } from "../pi-runtime/testing.ts";
import { commandCompletions, completionToken, pathCompletion } from "./completions.ts";
import { buildAssets } from "./build.ts";
import { serve } from "./testing.ts";

await test("completion tokens respect boundaries, quoting and cursor position", () => {
  for (const text of [
    "email@example.com",
    "https://example.com",
    "explain /model",
    "hello",
    '@"done"',
    "/model ",
  ])
    assert.equal(completionToken(text, text.length), undefined, text);
  assert.deepEqual(completionToken("inspect @src/file.ts please", 12), {
    kind: "path",
    query: "src",
    start: 8,
    end: 20,
  });
  assert.deepEqual(completionToken("/model", 3), {
    kind: "command",
    query: "mo",
    start: 0,
    end: 6,
  });
  const text = 'read @"a b/c';
  assert.deepEqual(completionToken(text, text.length), {
    kind: "path",
    query: "a b/c",
    start: 5,
    end: text.length,
  });
  const unfinished = '@"a trailing\\';
  assert.deepEqual(completionToken(unfinished, 3), {
    kind: "path",
    query: "a",
    start: 0,
    end: unfinished.length,
  });
  assert.equal(pathCompletion("a b/").value, '@"a b/');
  assert.equal(pathCompletion('a"b.txt').value, '@"a\\"b.txt" ');
  assert.equal(pathCompletion("src/").value, "@src/");
  assert.equal(pathCompletion("src/file.ts").value, "@src/file.ts ");
  assert.deepEqual(
    commandCompletions("MO").map((item) => item.value),
    ["/model "],
  );
  assert.deepEqual(commandCompletions("unknown"), []);
});

await test("HTTP path completion uses the session workspace and validates paths", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.workspace, "src"));
  await writeFile(join(f.workspace, "src", "example.ts"), "example");
  await writeFile(join(f.workspace, "space name.txt"), "example");
  await writeFile(join(f.workspace, ".hidden"), "hidden");
  const session = await f.create();
  const base = await serve(t, f.sessions);
  const complete = (query: string) =>
    fetch(`${base}/api/sessions/${session.id}/completions?query=${encodeURIComponent(query)}`);
  assert.deepEqual(await (await complete("")).json(), ["space name.txt", "src/"]);
  assert.deepEqual(await (await complete("SRC/e")).json(), []);
  assert.deepEqual(await (await complete("src/E")).json(), ["src/example.ts"]);
  assert.deepEqual(await (await complete(".")).json(), [".hidden"]);
  assert.deepEqual(await (await complete("absent/")).json(), []);
  for (const query of ["../", "src/../../", "/etc/", "\0", "x".repeat(4097)])
    assert.equal((await complete(query)).status, 400, query);
  assert.equal(f.faux.state.callCount, 0);
  await f.reopen([]);
  // A missing integration must not fall back to reading the web server's cwd.
  const unavailableBase = await serve(t, f.sessions);
  assert.equal(
    (await fetch(`${unavailableBase}/api/sessions/${session.id}/completions`)).status,
    409,
  );
});

async function browser(t: TestContext) {
  const instance = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  t.after(() => instance.close());
  return instance.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
}

await test("mobile browser completions navigate, replace at cursor, dismiss and ignore stale results", async (t) => {
  const page = await browser(t);
  await page.setContent(
    '<textarea id="prompt" maxlength="100000"></textarea><div id="completions" role="listbox" hidden></div>',
  );
  const source = stripTypeScriptTypes(
    await readFile(new URL("./completions.ts", import.meta.url), "utf8"),
  );
  await page.addScriptTag({
    content:
      source.replace(/export /g, "") +
      `
    let scope = 'one';
    window.pending = [];
    window.controller = installCompletions(document.querySelector('textarea'), document.querySelector('#completions'),
      () => scope, (query) => new Promise(resolve => window.pending.push({ query, resolve })));
  `,
  });
  await page.fill("#prompt", "/");
  assert.equal(await page.locator("[role=option]").count(), commandCompletions("").length);
  await page.keyboard.press("ArrowDown");
  assert.equal(
    await page.locator("[aria-selected=true]").textContent(),
    "/newCreate a session with the selected target/model",
  );
  await page.keyboard.press("Control+k");
  await page.keyboard.press("Tab");
  assert.equal(await page.inputValue("#prompt"), "/sessions ");
  assert.equal(await page.locator("#completions").isHidden(), true);
  await page.fill("#prompt", "/mod");
  await page.keyboard.press("Enter");
  assert.equal(await page.inputValue("#prompt"), "/model ");
  await page.fill("#prompt", "/");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#completions").isHidden(), true);
  await page.fill("#prompt", "read @src/file.ts please");
  await page.locator("#prompt").evaluate((node) => {
    (node as HTMLTextAreaElement).setSelectionRange(9, 9);
    node.dispatchEvent(new Event("click"));
  });
  await page.waitForFunction("window.pending.some(p => p.query === 'src')");
  await page.evaluate("window.pending.find(p => p.query === 'src').resolve(['src/other.ts'])");
  await page.locator("[role=option]").click();
  assert.equal(await page.inputValue("#prompt"), "read @src/other.ts  please");
  assert.equal(
    await page.locator("#prompt").evaluate((node) => node === document.activeElement),
    true,
  );
  await page.fill("#prompt", "@old");
  await page.waitForFunction("window.pending.some(p => p.query === 'old')");
  await page.fill("#prompt", "@new");
  await page.waitForFunction("window.pending.some(p => p.query === 'new')");
  await page.evaluate("window.pending.find(p => p.query === 'new').resolve(['new.txt'])");
  await page.waitForSelector("[role=option]");
  await page.evaluate("window.pending.find(p => p.query === 'old').resolve(['old.txt'])");
  assert.equal(await page.locator("[role=option]").textContent(), "@new.txt");
  await page.fill("#prompt", "@switch");
  await page.waitForFunction("window.pending.some(p => p.query === 'switch')");
  await page.evaluate(
    "scope = 'two'; window.controller.close(); window.pending.find(p => p.query === 'switch').resolve(['wrong.txt'])",
  );
  assert.equal(await page.locator("#completions").isHidden(), true);
  await page.fill("#prompt", "@escape");
  await page.waitForFunction("window.pending.some(p => p.query === 'escape')");
  await page.keyboard.press("Escape");
  await page.evaluate("window.pending.find(p => p.query === 'escape').resolve(['wrong.txt'])");
  assert.equal(await page.locator("#completions").isHidden(), true);
  await page.fill("#prompt", "/mod");
  await page.locator("#prompt").dispatchEvent("keydown", { key: "Enter", isComposing: true });
  assert.equal(await page.inputValue("#prompt"), "/mod");
  await page.locator("[role=option]").tap();
  assert.equal(await page.inputValue("#prompt"), "/model ");
});

await test("mobile browser composer runs commands without sending prompts and preserves failures", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.workspace, "a folder"));
  await writeFile(join(f.workspace, "a folder", "file.txt"), "hello");
  const session = await f.create();
  const assets = await mkdtemp(join(tmpdir(), "pi-completions-assets-"));
  t.after(() => rm(assets, { recursive: true, force: true }));
  await buildAssets(fileURLToPath(new URL(".", import.meta.url)), assets);
  const base = await serve(t, f.sessions, assets);
  const page = await browser(t);
  let prompts = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith("/prompt")) prompts++;
  });
  await page.goto(`${base}/?session=${session.id}`);
  await page.waitForSelector("#status[data-state=ready]");
  await page.fill("#prompt", "@a");
  await page.getByRole("option", { name: "@a folder/", exact: true }).waitFor();
  const bounds = await page.locator("#completions").evaluate((node) => {
    const box = node.getBoundingClientRect();
    return {
      left: box.left,
      right: box.right,
      bottom: box.bottom,
      top: box.top,
      promptTop: document.querySelector("#prompt")!.getBoundingClientRect().top,
    };
  });
  assert(bounds.left >= 0 && bounds.right <= 390 && bounds.top >= 0);
  assert(bounds.bottom <= bounds.promptTop);
  await page.getByRole("option", { name: "@a folder/", exact: true }).tap();
  assert.equal(await page.inputValue("#prompt"), '@"a folder/');
  await page.getByRole("option", { name: "@a folder/file.txt", exact: true }).tap();
  assert.equal(await page.inputValue("#prompt"), '@"a folder/file.txt" ');
  const run = async (command: string) => {
    await page.fill("#prompt", command);
    await page.keyboard.press("Control+Enter");
  };
  await run("/settings");
  await page.waitForSelector("#preferences[open]");
  await page.click("#close-settings");
  await run("/model");
  await page.waitForSelector("#preferences[open]");
  assert.equal(
    await page.locator("#session-model").evaluate((node) => node === document.activeElement),
    true,
  );
  await page.click("#close-settings");
  await run("/search");
  await page.waitForSelector("#search-bar", { state: "visible" });
  await page.click("#search-close");
  const download = page.waitForEvent("download");
  await run("/export");
  assert.match((await download).suggestedFilename(), /\.json$/);
  await run("/sessions");
  await page.waitForSelector("#picker[open]");
  await page.click("#close-picker");
  for (const [command, message] of [
    ["/stop", "no running response"],
    ["/resume", "does not need to be resumed"],
  ]) {
    await run(command);
    await page.waitForFunction(
      (message) => document.querySelector("#notice")!.textContent.includes(message),
      message,
    );
    assert.equal(await page.inputValue("#prompt"), command);
  }
  await run("/unknown");
  await page.waitForFunction(() =>
    document.querySelector("#notice")!.textContent.includes("Unknown command"),
  );
  assert.equal(await page.inputValue("#prompt"), "/unknown");
  await run("/model extra");
  await page.waitForFunction(() =>
    document.querySelector("#notice")!.textContent.includes("does not accept arguments"),
  );
  assert.equal(await page.inputValue("#prompt"), "/model extra");
  page.once("dialog", (dialog) => dialog.dismiss());
  await run("/reset handoff");
  await page.waitForFunction(
    () => !(document.querySelector("#send") as HTMLButtonElement).disabled,
  );
  assert.equal(await page.inputValue("#prompt"), "/reset handoff");
  let payload: unknown;
  await page.route("**/compact", (route) => {
    payload = route.request().postDataJSON();
    return route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: "Test failure" }),
    });
  });
  await run("/compact keep the tests");
  await page.waitForFunction(() =>
    document.querySelector("#notice")!.textContent.includes("Test failure"),
  );
  assert.deepEqual(payload, { instructions: "keep the tests" });
  assert.equal(await page.inputValue("#prompt"), "/compact keep the tests");
  await page.unroute("**/compact");
  page.once("dialog", (dialog) => dialog.accept());
  await run("/reset New context");
  await page.waitForFunction(
    () => (document.querySelector("#prompt") as HTMLTextAreaElement).value === "",
  );
  await run("/help");
  await page.waitForFunction(() =>
    document.querySelector("#notice")!.textContent.includes("workspace paths"),
  );
  assert.equal(prompts, 0);
  assert.equal(f.faux.state.callCount, 0);
  await run("/new");
  await page.waitForFunction(
    (id) => new URL(location.href).searchParams.get("session") !== id,
    session.id,
  );
  assert.equal(await page.inputValue("#prompt"), "");
  assert.equal(
    await page.evaluate((id) => sessionStorage.getItem(`pi.draft:${id}:main`), session.id),
    "",
  );
  await page.waitForSelector("#status[data-state=ready]");
  f.faux.setResponses([fauxAssistantMessage("Mention received.")]);
  const request = page.waitForRequest((request) =>
    new URL(request.url()).pathname.endsWith("/prompt"),
  );
  await run('Read @"a folder/file.txt"');
  assert.equal((await request).postDataJSON().text, 'Read @"a folder/file.txt"');
  await page.getByText("Mention received.", { exact: true }).waitFor();
  assert.equal(prompts, 1);
});
