import { openCodingSessions } from "../../pi-runtime/coding.ts";
import * as runtime from "../../pi-runtime/index.ts";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { GlobalSettingsStore } from "../server.ts";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { EntryDraft } from "@earendil-works/pi-durable";
import { chromium } from "playwright";
import { fixture, model } from "../../pi-runtime/testing.ts";
import { chromiumExecutable, serve, snapshot, post } from "./testing.ts";
import { buildAssets } from "../build.ts";

const context = BACKGROUND_CONTEXT;
const text = (tokens: number) => "x".repeat(Math.floor(tokens * 3.5));
const user = (tokens: number): Message => ({ role: "user", content: text(tokens), timestamp: 1 });

await test("mobile browser Context follows the approved mock, isolates late events and renders labels safely", async (t) => {
  const f = await fixture(t);
  const faux = fauxProvider({ models: [{ id: "faux-1", contextWindow: 200000 }] });
  f.options.models.setProvider(faux.provider);
  let opens = 0;
  const store = new GlobalSettingsStore(SettingsManager.inMemory());
  const sessions = await openCodingSessions(
    store.bind({
      ...f.options,
      directory: join(f.directory, "inspected"),
      env: async () => {
        opens++;
        throw new Error("No execution allowed");
      },
    }),
  );
  t.after(() => sessions.close());
  const session = await sessions.create(randomUUID(), f.binding, model);
  const append = (entry: EntryDraft) =>
    session.root.commit((tx) => tx.appendEntry(session.root.id, entry), context);
  // Real committed messages, not fabricated HTTP estimates. The mock's abbreviated
  // contents cannot produce its illustrative counts; this fixture has real size.
  await append({ kind: "pi.user", model: [user(10000)] });
  await append({ kind: "pi.compaction", head: "self", model: [user(2560)] });
  await append({
    kind: "pi.system",
    model: [
      {
        role: "system",
        content: "",
        timestamp: 1,
        sections: {
          codemode: text(640),
          preamble: text(200),
          cwd: "<cwd>\n/workspace/drv.run\n</cwd>",
          context: JSON.stringify({
            files: [
              { level: "system", path: "/etc/xdg/llms.txt", content: text(960) },
              { level: "user", path: "/root/.config/llms.txt", content: text(320) },
              { level: "repo", path: "/workspace/drv.run/README.md", content: text(1360) },
              { level: "repo", path: "/workspace/drv.run/CONTRIBUTING.md", content: text(336) },
            ],
          }),
        },
        toolsAdded: ["read", "write", "edit", "bash", "codemode", "ask_user"].map((name) => ({
          name,
          description: text(450),
          parameters: { type: "object", properties: {} },
        })),
      },
    ],
  });
  await append({
    kind: "pi.user",
    model: [
      {
        role: "user",
        content: [
          { type: "text", text: text(3040) },
          { type: "image", data: "", mimeType: "image/png" },
        ],
        timestamp: 1,
      },
    ],
  });
  for (const [index, [name, path, result]] of (
    [
      ["read", "packages/pi-runtime/default.nix", 2800],
      ["read", "packages/pi-runtime/index.ts", 12400],
      ["read", "packages/pi-runtime/runtime.test.ts", 10800],
      ["edit", "packages/pi-runtime/context.ts", 20],
      ["codemode", "", 7120],
    ] as const
  ).entries()) {
    if (index === 1) await append({ kind: "pi.user", model: [user(1600)] });
    const call = {
      ...fauxToolCall(
        name,
        path
          ? {
              path,
              ...(name === "edit" ? { edits: [{ oldText: text(3000), newText: text(3200) }] } : {}),
            }
          : { code: "await tools.bash({ command: 'just check' });" },
      ),
      id: `call-${index}`,
    };
    await append({
      kind: "pi.assistant",
      model: [
        fauxAssistantMessage(
          [
            ...(index === 1
              ? [
                  { type: "thinking" as const, thinking: text(4480) },
                  { type: "text" as const, text: text(3680) },
                ]
              : []),
            ...(index === 2 ? [{ type: "text" as const, text: text(2880) }] : []),
            call,
          ],
          { stopReason: "toolUse" },
        ),
      ],
    });
    await append({
      kind: "pi.tool-result",
      model: [
        {
          role: "toolResult",
          toolName: name,
          toolCallId: call.id,
          content: [{ type: "text", text: text(result) }],
          isError: false,
          timestamp: 1,
        },
      ],
    });
  }
  const last = await append({
    kind: "pi.assistant",
    model: [
      fauxAssistantMessage([
        { type: "thinking", thinking: text(2400) },
        { type: "text", text: text(160) },
      ]),
    ],
  });
  const empty = await session.root.fork(last.id, { ownership: { kind: "ownerless" } }, context);
  await empty.reset(undefined, context);
  const history = await runtime.history(session);
  const assets = join(f.directory, "assets");
  await buildAssets(fileURLToPath(new URL("..", import.meta.url)), assets);
  const base = await serve(t, sessions, assets, "127.0.0.1", undefined, store);
  const initial = await snapshot(`${base}/api/harness/${session.id}/watch`);
  assert(initial.inspection.state === "available");
  const browser = await chromium.launch({
    executablePath: chromiumExecutable(),
  });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1180, height: 1100 } });
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));
  await page.addInitScript(() => {
    const Native = window.EventSource;
    const sources: EventSource[] = [];
    Object.assign(window, { contextTestSources: sources });
    window.EventSource = class extends Native {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        sources.push(this);
      }
    };
  });
  await page.goto(`${base}/?session=${session.id}`);
  await page.waitForSelector("#footer-context");
  await page.click("#footer-context");
  const pane = page.locator("#context-view");
  await page.waitForSelector("#context-view:not([hidden])");
  assert.equal(Number(await pane.getAttribute("data-tokens")), initial.inspection.tokens);
  assert.equal(await page.locator("#view-title").textContent(), "Context");
  assert.equal(await pane.locator(".ctx-big span").textContent(), "/ 200k");
  assert.equal(await page.locator("#app-footer").isVisible(), false);
  assert.equal(await pane.locator("button, input, select, textarea, details, hr").count(), 0);
  assert.deepEqual(
    await pane
      .locator(".ctx-message")
      .evaluateAll((nodes) =>
        nodes.map((node) => [
          (node as HTMLElement).dataset.role,
          Number((node as HTMLElement).dataset.tokens),
        ]),
      ),
    initial.inspection.messages.map((message) => [message.role, message.tokens]),
  );
  const screenshots = process.env.PI_SCREENSHOT_DIR;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  const shot = async (name: string) => {
    if (screenshots)
      await page.screenshot({ path: join(screenshots, `${name}.png`), fullPage: true });
  };
  for (const width of [1180, 820, 650, 390, 320]) {
    await page.setViewportSize({ width, height: width === 1180 ? 1100 : 844 });
    const layout = await pane.evaluate((node) => {
      const marker = node.querySelector(".ctx-threshold")!.getBoundingClientRect();
      const label = node.querySelector(".ctx-auto")!;
      const box = label.getBoundingClientRect();
      return {
        width: node.clientWidth,
        scroll: node.scrollWidth,
        marker: marker.left,
        label: box.left + box.width / 2,
        color: getComputedStyle(label).color,
        muted: getComputedStyle(node.querySelector(".ctx-remaining")!).color,
        separators: Array.from(node.querySelectorAll(".ctx-message, .ctx-field")).filter(
          (item) => getComputedStyle(item).borderBottomWidth !== "0px",
        ).length,
      };
    });
    assert(layout.scroll <= layout.width);
    assert(Math.abs(layout.marker - layout.label) < 1);
    assert.equal(layout.color, layout.muted);
    assert.equal(layout.separators, 0);
    if (width === 1180 || width === 390) {
      const size = width === 1180 ? "desktop" : "mobile";
      await shot(`context-${size}`);
      const height = await pane.evaluate(
        (node) => node.scrollHeight + document.querySelector("#app-header")!.clientHeight,
      );
      await page.setViewportSize({ width, height });
      await shot(`context-${size}-full`);
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await pane.evaluate((node) => {
    node.scrollTop = 530;
  });
  await shot("context-mobile-inventory");
  assert.deepEqual(await runtime.history(session), history);
  assert.equal(opens, 0);
  assert.equal(faux.state.callCount, 0);

  // Real context updates repaint the open inspector, safely, without previewing
  // raw content. Long paths wrap; the tag-shaped path must remain a text node.
  const malicious = `<img src=x onerror=alert(1)>/${"long".repeat(80)}/SPEC.md`;
  const update = await append({
    kind: "pi.system",
    model: [
      {
        role: "system",
        content: "",
        sections: {
          context: JSON.stringify({
            files: [{ level: "repo", path: malicious, content: "not a preview" }],
          }),
        },
        timestamp: 1,
      },
    ],
  });
  await page.waitForFunction(
    (tail) => document.querySelector<HTMLElement>("#context-view")?.dataset.tail === String(tail),
    update.id,
  );
  assert.equal(await pane.locator(".ctx-files .ctx-field-value").last().textContent(), malicious);
  assert.equal(await pane.locator("img, script").count(), 0);
  assert(await pane.evaluate((node) => node.scrollWidth <= node.clientWidth));
  await pane.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await shot("context-mobile-long-path");
  await page.click("#close-view");
  await page.fill("#prompt", "/fork");
  await page.press("#prompt", "Control+Enter");
  await page.locator(`#branches button[data-conversation="${empty.id}"]`).click();
  await page.waitForFunction(
    (id) => new URL(location.href).searchParams.get("conversation") === String(id),
    empty.id,
  );
  await page.click("#footer-context");
  await page.waitForFunction(
    (id) =>
      document.querySelector<HTMLElement>("#context-view")?.dataset.conversation === String(id),
    empty.id,
  );
  assert.equal(await pane.locator(".ctx-message").count(), 0);
  await shot("context-mobile-empty");
  await page.evaluate((old) => {
    const sources = (window as unknown as { contextTestSources: EventSource[] }).contextTestSources;
    sources[0]!.onmessage?.call(sources[0]!, new MessageEvent("message", { data: old }));
  }, JSON.stringify(initial));
  assert.equal(Number(await pane.getAttribute("data-conversation")), empty.id);
  assert.equal(await pane.locator(".ctx-message").count(), 0);
  await page.reload();
  await page.click("#footer-context");
  await page.waitForFunction(
    (id) =>
      document.querySelector<HTMLElement>("#context-view")?.dataset.conversation === String(id),
    empty.id,
  );
  assert.equal(await pane.locator(".ctx-message").count(), 0);
  // Shared policy updates must refresh an already-open inspector, even without
  // a new transcript entry (including updates from another browser).
  assert.equal(
    (await post(`${base}/api/settings`, { values: { "compaction.enabled": false } })).status,
    200,
  );
  await page.waitForSelector(".ctx-threshold", { state: "detached" });
  assert.equal(await pane.locator(".ctx-reserved, .ctx-reserve-caption").count(), 0);
  await shot("context-mobile-disabled");

  await empty.configure({ model: { provider: "missing", modelId: "missing" } }, context);
  await page.waitForSelector(".ctx-window", { state: "detached" });
  assert.equal(await pane.locator(".ctx-percent").textContent(), "—");
  await shot("context-mobile-unknown");

  // A failed inspection clears the preceding inventory; recovery does not
  // require a new browser or a durable inspector document.
  await page.route("**/inspection*", (route) =>
    route.fulfill({ json: { state: "unavailable", conversation: empty.id } }),
  );
  await empty.configure({ model }, context);
  await page.waitForFunction(
    () => document.querySelector("#context-view")?.textContent === "Context unavailable",
  );
  assert.equal(await pane.getAttribute("data-tokens"), null);
  await shot("context-mobile-unavailable");
  await page.unroute("**/inspection*");
  await empty.commit(async (tx) => {
    for (let index = 0; index < 600; index++)
      await tx.appendEntry(empty.id, { kind: "pi.user", model: [user(10)] });
  }, context);
  await page.waitForFunction(
    () => document.querySelectorAll("#context-view .ctx-message").length === 600,
  );
  assert.equal(Number(await pane.getAttribute("data-tokens")), 6000);
  assert(await pane.evaluate((node) => node.scrollWidth <= node.clientWidth));
  await pane.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await shot("context-mobile-large");
  assert.equal(opens, 0);
  assert.equal(faux.state.callCount, 0);
  assert.deepEqual(errors, []);
});
