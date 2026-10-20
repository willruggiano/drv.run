import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { chromium, type Page } from "playwright";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { fixture, waitFor } from "../pi-runtime/testing.ts";
import type { ManagedSession } from "../pi-runtime/index.ts";
import { commandCompletions } from "./completions.ts";
import { buildAssets } from "./build.ts";
import { chromiumExecutable, serve } from "./testing.ts";

async function landingFixture(t: TestContext) {
  const f = await fixture(t);
  const assets = join(f.workspace, "assets");
  await buildAssets(fileURLToPath(new URL(".", import.meta.url)), assets);
  const base = await serve(t, f.sessions, assets);
  const page = await browser(t);
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));
  t.after(() => assert.deepEqual(errors, []));
  const open = async () => {
    await page.goto(base);
    await page.locator("#recent-empty:not([hidden]), #recent-sessions button").first().waitFor();
    await page.click("#new-options-toggle");
    await page.selectOption("#models", "0");
  };
  const currentSession = async () => {
    await page.waitForFunction(() => new URL(location.href).searchParams.has("session"));
    return f.sessions.get(new URL(page.url()).searchParams.get("session")!);
  };
  return { ...f, page, base, open, currentSession };
}

async function userMessages(session: ManagedSession) {
  return (await session.history())
    .flatMap((entry) => entry.model ?? [])
    .filter((message) => message.role === "user")
    .map((message) => message.content);
}

async function attachImage(page: Page) {
  await page.locator("#images").setInputFiles({
    name: "image.png",
    mimeType: "image/png",
    buffer: await readFile(new URL("./icon-192.png", import.meta.url)),
  });
  await page.locator("#attachments button").waitFor();
}

async function browser(t: TestContext) {
  const instance = await chromium.launch({
    executablePath: chromiumExecutable(),
  });
  t.after(() => instance.close());
  return instance.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
}

await test("landing composer creates sessions with the first draft, options and attachments", async (t) => {
  const f = await landingFixture(t);
  const { page } = f;
  for (const [width, action] of [
    [390, "button"],
    [1440, "keyboard"],
    [390, "sessions"],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await f.open();
    await page.selectOption("#new-thinking", "high");
    const target = await page.inputValue("#targets");
    await page.click("#title");
    await page.locator("#picker:not([hidden])").waitFor();
    assert.equal(await page.locator("#session-actions #create").isVisible(), true);
    assert.equal(await page.inputValue("#new-thinking"), "high");
    assert.equal(await page.inputValue("#targets"), target);
    await page.click("#close-view");
    assert.equal(await page.locator("#composer-actions #create").isVisible(), true);
    assert.equal(await page.inputValue("#models"), "0");
    assert.equal(await page.inputValue("#new-thinking"), "high");
    let sourceKey = "pi.draft:new:main";
    let previousId: string | undefined;
    if (action === "sessions") {
      const previous = await f.create();
      previousId = previous.id;
      sourceKey = `pi.draft:${previous.id}:main`;
      await page.click("#title");
      await page.locator(`#sessions [data-session="${previous.id}"]`).click();
      await page.locator("#status[data-state=ready]").waitFor();
    }
    const text = `  First message from ${action}\nwith whitespace.  `;
    await page.fill("#prompt", text);
    await attachImage(page);
    f.faux.setResponses([fauxAssistantMessage("Received.")]);
    // The initial prompt must not wait for an SSE connection.
    await page.route("**/events", (route) => route.abort());
    if (action === "sessions") {
      await page.click("#title");
      await page.fill("#session-filter", "This is only a filter");
      await page.click("#create");
    } else if (action === "keyboard") await page.press("#prompt", "Control+Enter");
    else await page.click("#create");
    await page.waitForFunction((id) => {
      const selected = new URL(location.href).searchParams.get("session");
      return selected && selected !== id;
    }, previousId);
    const session = await f.currentSession();
    await waitFor(async () => (await userMessages(session)).length === 1);
    await page.waitForFunction(
      () => document.querySelector<HTMLTextAreaElement>("#prompt")?.value === "",
    );
    const messages = await userMessages(session);
    const content = messages[0];
    assert(Array.isArray(content));
    assert.deepEqual(content[0], { type: "text", text });
    assert.equal(content[1].type, "image");
    assert.equal((await session.info()).thinkingLevel, "high");
    assert.equal(await page.locator("#attachments button").count(), 0);
    assert.equal(await page.evaluate((key) => sessionStorage.getItem(key), sourceKey), "");
    assert.equal(await page.locator("#landing").isVisible(), false);
    await page.unroute("**/events");
    await session.root.waitForIdle(BACKGROUND_CONTEXT);
  }
  for (const text of ["", "  \n ", "/new"]) {
    await f.open();
    await page.fill("#prompt", text);
    if (text === "/new") await page.press("#prompt", "Control+Enter");
    else await page.click("#create");
    const session = await f.currentSession();
    await page.locator("#status[data-state=ready]").waitFor();
    assert.deepEqual(await userMessages(session), []);
  }
});

await test("landing composer preserves creation failures and retries a lost prompt acknowledgement", async (t) => {
  const f = await landingFixture(t);
  const { page } = f;
  await f.open();
  await page.fill("#prompt", "Keep this draft.");
  await attachImage(page);
  await page.route("**/api/sessions", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Creation failed" }),
    }),
  );
  await page.click("#create");
  await page.locator("#notice:not([hidden])").waitFor();
  assert.equal(await page.inputValue("#prompt"), "Keep this draft.");
  assert.equal(await page.locator("#attachments button").count(), 1);
  assert.equal(await page.locator("#create").isEnabled(), true);
  assert.equal((await f.sessions.catalog()).sessions.length, 0);
  await page.unroute("**/api/sessions");

  const requests: { requestId: string; text: string; mode: string }[] = [];
  await page.route("**/prompt", async (route) => {
    requests.push(route.request().postDataJSON());
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Acknowledgement lost" }),
    });
  });
  f.faux.setResponses([fauxAssistantMessage("Only one message.")]);
  await page.click("#create");
  const session = await f.currentSession();
  await page.locator("#notice:not([hidden])").waitFor();
  assert.equal(await page.inputValue("#prompt"), "Keep this draft.");
  assert.equal(await page.locator("#attachments button").count(), 1);
  await waitFor(async () => (await userMessages(session)).length === 1);
  await session.root.waitForIdle(BACKGROUND_CONTEXT);
  await page.locator("#status[data-state=ready]").waitFor();
  await page.unroute("**/prompt");
  await page.route("**/prompt", async (route) => {
    requests.push(route.request().postDataJSON());
    await route.continue();
  });
  await page.click("#send");
  await page.waitForFunction(
    () => document.querySelector<HTMLTextAreaElement>("#prompt")?.value === "",
  );
  assert.equal(requests.length, 2);
  assert.equal(requests[0].requestId, requests[1].requestId);
  assert.equal(requests[0].mode, "followUp");
  assert.equal((await f.sessions.catalog()).sessions.length, 1);
  assert.equal((await userMessages(session)).length, 1);
  assert.equal(f.faux.state.callCount, 1);
  assert.equal(await page.locator("#attachments button").count(), 0);
  assert.equal(await page.evaluate(() => sessionStorage.getItem("pi.draft:new:main")), "");
});

await test("landing creation captures options once and preserves edits during creation and submission", async (t) => {
  const f = await landingFixture(t);
  const { page } = f;
  await f.open();
  await page.selectOption("#new-thinking", "high");
  await page.fill("#prompt", "Original draft");
  const creating = Promise.withResolvers<void>();
  const releaseCreation = Promise.withResolvers<void>();
  const submitting = Promise.withResolvers<void>();
  const releasePrompt = Promise.withResolvers<void>();
  t.after(() => {
    releaseCreation.resolve();
    releasePrompt.resolve();
  });
  let creations = 0;
  await page.route("**/api/sessions", async (route) => {
    creations++;
    creating.resolve();
    await releaseCreation.promise;
    await route.continue();
  });
  await page.route("**/prompt", async (route) => {
    submitting.resolve();
    await releasePrompt.promise;
    await route.continue();
  });
  f.faux.setResponses([fauxAssistantMessage("Captured draft received.")]);
  await page.click("#create");
  await creating.promise;
  assert.equal(await page.locator("#create").isDisabled(), true);
  await page.locator("#create").dispatchEvent("click");
  await page.press("#prompt", "Control+Enter");
  await page.fill("#prompt", "Edited during creation");
  await page.selectOption("#new-thinking", "low");
  releaseCreation.resolve();
  await submitting.promise;
  const session = await f.currentSession();
  assert.equal(await page.inputValue("#prompt"), "Edited during creation");
  assert.equal((await session.info()).thinkingLevel, "high");
  await page.fill("#prompt", "Edited during submission");
  await attachImage(page);
  releasePrompt.resolve();
  await waitFor(async () => (await userMessages(session)).length === 1);
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>("#send")?.disabled);
  assert.equal(creations, 1);
  assert.deepEqual(await userMessages(session), ["Original draft"]);
  assert.equal(await page.inputValue("#prompt"), "Edited during submission");
  assert.equal(await page.locator("#attachments button").count(), 1);
  await page.reload();
  await page.locator("#status[data-state=ready]").waitFor();
  assert.equal(await page.inputValue("#prompt"), "Edited during submission");
});

await test("landing creation cannot replace an explicitly selected session or view", async (t) => {
  const f = await landingFixture(t);
  const { page } = f;
  const existing = await f.create();
  for (const destination of ["session", "view"]) {
    await f.open();
    await page.fill("#prompt", "Do not redirect me");
    const creating = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    t.after(() => release.resolve());
    await page.route("**/api/sessions", async (route) => {
      creating.resolve();
      await release.promise;
      await route.fulfill({ response: await route.fetch() });
      finished.resolve();
    });
    await page.click("#create");
    await creating.promise;
    if (destination === "session") {
      await page.locator(`#recent-sessions [data-session="${existing.id}"]`).click();
      await page.locator("#status[data-state=ready]").waitFor();
      await page.fill("#prompt", "Other session draft");
    } else {
      await page.click("#menu-toggle");
      await page.locator("#global-preferences:not([hidden])").waitFor();
    }
    release.resolve();
    await finished.promise;
    // Wait for the creation guard to be released before checking the view.
    await page.waitForFunction(
      () => !document.querySelector<HTMLButtonElement>("#create")?.disabled,
    );
    if (destination === "session") {
      assert.equal(new URL(page.url()).searchParams.get("session"), existing.id);
      assert.equal(await page.inputValue("#prompt"), "Other session draft");
    } else {
      assert.equal(await page.locator("#global-preferences").isVisible(), true);
      assert.equal(await page.inputValue("#prompt"), "Do not redirect me");
    }
    assert.deepEqual(await userMessages(existing), []);
    await page.unroute("**/api/sessions");
  }
  assert.equal(f.faux.state.callCount, 0);
  await f.open();
  await page.fill("#prompt", "Captured before navigation");
  const submitting = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  t.after(() => release.resolve());
  await page.route("**/prompt", async (route) => {
    submitting.resolve();
    await release.promise;
    await route.continue();
  });
  f.faux.setResponses([fauxAssistantMessage("Sent to the new session.")]);
  await page.click("#create");
  await submitting.promise;
  const created = await f.currentSession();
  await page.click("#title");
  await page.locator(`#sessions [data-session="${existing.id}"]`).click();
  await page.fill("#prompt", "New unrelated draft");
  release.resolve();
  await waitFor(async () => (await userMessages(created)).length === 1);
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>("#send")?.disabled);
  assert.equal(new URL(page.url()).searchParams.get("session"), existing.id);
  assert.equal(await page.inputValue("#prompt"), "New unrelated draft");
  assert.deepEqual(await userMessages(existing), []);
  assert.deepEqual(await userMessages(created), ["Captured before navigation"]);
  assert.equal(
    await page.evaluate((id) => sessionStorage.getItem(`pi.draft:${id}:main`), created.id),
    "",
  );
});

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
  await page.waitForSelector("#preferences:not([hidden])");
  await page.click("#close-view");
  await run("/model");
  await page.waitForSelector("#preferences:not([hidden])");
  assert.equal(
    await page.locator("#session-model").evaluate((node) => node === document.activeElement),
    false,
  );
  await page.click("#close-view");
  await run("/search");
  await page.waitForSelector("#search-bar", { state: "visible" });
  await page.click("#close-view");
  const download = page.waitForEvent("download");
  await run("/export");
  assert.match((await download).suggestedFilename(), /\.json$/);
  await run("/sessions");
  await page.waitForSelector("#picker:not([hidden])");
  await page.click("#close-view");
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
