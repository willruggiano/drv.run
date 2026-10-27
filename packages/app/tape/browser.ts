import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { LiveState } from "@earendil-works/pi-durable";
import { httpServer, GlobalSettingsStore } from "serve/server";
import { conversationURL } from "serve/presentation";
import { Page, launch, record } from "./cdp.ts";
import { apply, openState } from "./state.ts";
import { digest, PresentationDoc, viewer, type Tape, type Presentation } from "./model.ts";

export const profiles = {
  mobile: {
    width: 390,
    height: 844,
    mobile: true,
    deviceScaleFactor: 1,
    insets: { top: 47, bottom: 34, left: 0, right: 0 },
  },
  desktop: {
    width: 1440,
    height: 900,
    mobile: false,
    deviceScaleFactor: 1,
    insets: { top: 0, bottom: 0, left: 0, right: 0 },
  },
};
export type Profile = keyof typeof profiles;

// All DOM knowledge lives in this adapter, not in the tape or CDP transport.
class AppPage {
  readonly page: Page;
  readonly base: string;
  readonly path: string;
  readonly profile: Profile;
  readonly errors: string[] = [];
  private readonly unlisten: () => void;
  private draft = "";
  private selected: Presentation["panel"] = "conversation";
  constructor(page: Page, base: string, path: string, profile: Profile) {
    this.page = page;
    this.base = base;
    this.path = path;
    this.profile = profile;
    this.unlisten = page.cdp.on((method, params, session) => {
      if (session !== page.session || !record(params)) return;
      if (method === "Runtime.exceptionThrown") this.errors.push(JSON.stringify(params));
      if (method === "Runtime.consoleAPICalled" && params.type === "error")
        this.errors.push(JSON.stringify(params));
      if (
        method === "Network.responseReceived" &&
        record(params.response) &&
        typeof params.response.status === "number" &&
        params.response.status >= 400
      )
        this.errors.push(`HTTP ${params.response.status}: ${String(params.response.url)}`);
      if (method === "Network.loadingFailed" && params.canceled !== true)
        this.errors.push(JSON.stringify(params));
      if (method === "Fetch.requestPaused") {
        assert(
          typeof params.requestId === "string" &&
            record(params.request) &&
            typeof params.request.url === "string",
        );
        const allowed =
          new URL(params.request.url).origin === base && params.request.method === "GET";
        if (!allowed)
          this.errors.push(
            `Blocked replay request: ${String(params.request.method)} ${params.request.url}`,
          );
        const sent = allowed
          ? page.send("Fetch.continueRequest", { requestId: params.requestId })
          : page.send("Fetch.failRequest", {
              requestId: params.requestId,
              errorReason: "BlockedByClient",
            });
        void sent.catch((error: unknown) => this.errors.push(String(error)));
      }
    });
  }
  check() {
    assert.deepEqual(this.errors, [], "Browser replay failed");
  }
  close() {
    this.unlisten();
  }
  async initialize() {
    const { insets, ...metrics } = profiles[this.profile];
    await this.page.send("Page.enable", {});
    await this.page.send("Runtime.enable", {});
    await this.page.send("Network.enable", {});
    await this.page.send("Network.setCacheDisabled", { cacheDisabled: true });
    await this.page.send("Network.setBypassServiceWorker", { bypass: true });
    await this.page.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
    await this.page.send("Emulation.setDeviceMetricsOverride", metrics);
    await this.page.send("Emulation.setTouchEmulationEnabled", { enabled: metrics.mobile });
    await this.page.send("Emulation.setSafeAreaInsetsOverride", { insets });
    await this.page.send("Emulation.setLocaleOverride", { locale: "en-US" });
    await this.page.send("Emulation.setTimezoneOverride", { timezoneId: "UTC" });
    await this.page.send("Emulation.setEmulatedMedia", {
      features: [
        { name: "prefers-color-scheme", value: "dark" },
        { name: "prefers-reduced-motion", value: "reduce" },
      ],
    });
    await this.page.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `
      document.addEventListener("DOMContentLoaded", () => {
        const style = document.createElement("style");
        style.textContent = "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; -webkit-tap-highlight-color: transparent !important; }";
        document.head.append(style);
      });
    `,
    });
    const navigation = await this.page.send("Page.navigate", { url: this.base + this.path });
    assert(!navigation.errorText, navigation.errorText);
    await this.ready("conversation");
  }
  private async ready(panel: Presentation["panel"]) {
    const selector = {
      conversation: "#conversation-scroll",
      settings: '#settings[data-layout="stacked"] form[data-autosave]',
      context: "#context-view",
      defaults: '#settings:not([data-layout="stacked"]) form[data-autosave]',
    }[panel];
    await this.page.wait(
      `!!document.querySelector(${JSON.stringify(selector)})?.checkVisibility()${panel === "defaults" ? "" : " && document.querySelector('#connection')?.textContent === 'Connected'"}`,
      panel,
    );
    this.check();
  }
  private async click(selector: string) {
    await this.page.wait(
      `!!document.querySelector(${JSON.stringify(selector)})?.checkVisibility()`,
      selector,
    );
    const box = await this.page.evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      node.scrollIntoView({ block: 'nearest' });
      const r = node.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    assert(record(box) && typeof box.x === "number" && typeof box.y === "number");
    if (profiles[this.profile].mobile) {
      await this.page.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: box.x, y: box.y }],
      });
      await this.page.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } else {
      await this.page.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: box.x,
        y: box.y,
        button: "left",
        clickCount: 1,
      });
      await this.page.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: box.x,
        y: box.y,
        button: "left",
        clickCount: 1,
      });
    }
  }
  async present(value: Presentation) {
    // Context and standalone defaults have no composer. Return before editing
    // a draft, including changes committed together with navigation.
    if (
      this.selected !== "conversation" &&
      (this.selected !== value.panel ||
        (["context", "defaults"].includes(this.selected) && value.draft !== this.draft))
    ) {
      if (this.selected === "defaults") {
        const navigation = await this.page.send("Page.navigate", { url: this.base + this.path });
        assert(!navigation.errorText, navigation.errorText);
      } else await this.click("#close-view");
      await this.ready("conversation");
      this.selected = "conversation";
    }
    if (value.draft !== this.draft) {
      await this.page.evaluate(
        "document.querySelector('#prompt').focus(); document.querySelector('#prompt').select()",
      );
      if (value.draft) await this.page.send("Input.insertText", { text: value.draft });
      else
        for (const type of ["keyDown", "keyUp"] as const)
          await this.page.send("Input.dispatchKeyEvent", {
            type,
            key: "Backspace",
            code: "Backspace",
            windowsVirtualKeyCode: 8,
          });
      await this.page.wait(
        `document.querySelector('#prompt')?.value === ${JSON.stringify(value.draft)}`,
        "draft input",
      );
      this.draft = value.draft;
    }
    if (this.selected !== value.panel) {
      if (value.panel === "settings") await this.click("#footer-model");
      else if (value.panel === "context") await this.click("#footer-context");
      else if (value.panel === "defaults") {
        // The mobile conversation has no global-settings control. Use the
        // standalone page URL rather than activating a hidden control.
        const navigation = await this.page.send("Page.navigate", {
          url: `${this.base}/settings`,
        });
        assert(!navigation.errorText, navigation.errorText);
      }
      await this.ready(value.panel);
      this.selected = value.panel;
    }
    if (value.panel !== "context" && value.panel !== "defaults")
      await this.page.wait(
        `document.querySelector('#prompt')?.value === ${JSON.stringify(value.draft)}`,
        "preserved draft",
      );
    this.check();
  }
  async capture(path: string, output: LiveState) {
    if (this.selected === "conversation") {
      const expected =
        output.generation?.message?.content.flatMap((part) =>
          part.type === "text" ? [part.text] : [],
        ) ?? [];
      await this.page.wait(
        `JSON.stringify(Array.from(document.querySelectorAll('#live .text'), node => node.getAttribute('data-source'))) === ${JSON.stringify(JSON.stringify(expected))}`,
        "live document rendered",
      );
    }
    await this.page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 0, y: 0 });
    await this.page.evaluate(`(async () => {
      await document.fonts.ready;
      await Promise.all(Array.from(document.images, image => image.decode()));
      document.activeElement?.blur();
      const scroll = document.querySelector('#conversation-scroll');
      if (scroll) scroll.scrollTop = scroll.scrollHeight;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    })()`);
    this.check();
    const { data } = await this.page.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    const png = Buffer.from(data, "base64");
    await writeFile(path, png, { flag: "wx" });
    return digest(png);
  }
}

export async function replay(
  tape: Tape,
  profile: Profile,
  assets: string,
  output: string,
  signal: AbortSignal,
) {
  const directory = await mkdtemp(join(tmpdir(), "app-tape-replay-"));
  try {
    const state = await openState(directory, tape.initial);
    try {
      const settings = new GlobalSettingsStore();
      const server = httpServer(state.sessions, "127.0.0.1", assets, settings);
      const [handler] = server.listeners("request");
      assert(handler && server.listeners("request").length === 1);
      server.removeAllListeners("request");
      server.on("request", (request, response) => {
        if (request.method !== "GET") {
          response.writeHead(405);
          response.end("Read-only tape replay");
          return;
        }
        handler(request, response);
      });
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        });
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const browser = await launch(join(directory, "browser"), signal);
        try {
          const page = await Page.create(browser.cdp, signal);
          const app = new AppPage(page, base, conversationURL(state.session), profile);
          try {
            await app.initialize();
            await app.present(tape.initial.presentation);
            await mkdir(output, { recursive: true });
            let outputState: LiveState = {};
            const captures: { name: string; sha256: string; stateHash: string }[] = [];
            for (const frame of tape.frames) {
              signal.throwIfAborted();
              if (frame.type === "commit") {
                await apply(state.session, frame);
                for (const change of frame.changes) {
                  if (change.kind === "app.presentation") await app.present(change.value);
                  else outputState = change.value;
                }
              } else {
                const sha256 = await app.capture(join(output, `${frame.name}.png`), outputState);
                const stateHash = digest(
                  JSON.stringify({
                    presentation: await state.session.harness.snapshot(
                      PresentationDoc,
                      viewer,
                      context,
                    ),
                    live: outputState,
                  }),
                );
                captures.push({ name: frame.name, sha256, stateHash });
              }
              await state.check();
            }
            app.check();
            return {
              profile,
              configuration: profiles[profile],
              browser: await browser.cdp.send("Browser.getVersion", {}),
              captures,
            };
          } finally {
            app.close();
          }
        } finally {
          await browser.close();
        }
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    } finally {
      await state.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
