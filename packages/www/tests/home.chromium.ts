import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { buildSchema, graphql, GraphQLError, Kind, parse } from "graphql";
import { chromium, type Browser, type Page } from "playwright";

const schema = buildSchema(
  await readFile(
    process.env.GRAPHQL_SCHEMA ??
      new URL("../../durable/api/graphql/schema.graphql", import.meta.url),
    "utf8",
  ),
);

type Catalog = "harnesses" | "models" | "instances";
type Fault = "http" | "network" | "malformed" | "denied" | "graphql";
const initialModels = [
  {
    id: "same/id",
    provider: "one",
    name: "Reasoning model",
    thinkingLevels: ["off", "low", "high"],
  },
  { id: "same/id", provider: "two", name: "Fast model", thinkingLevels: ["off"] },
];
const initialSessions = [
  {
    id: "global:a",
    externalId: "alpha",
    root: {
      agent: { cwd: "/workspace/one", model: { provider: "one", modelId: "same/id" } },
      env: { host: "guest-one" },
    },
  },
  { id: "global:z", externalId: "zeta", root: null },
];
const instance = {
  id: "instance:one",
  unit: "drv.run@one.service",
  connect: { host: "guest-one" },
};

async function fixture(t: TestContext, browser: Browser, width = 1280, height = 800) {
  const state = {
    models: structuredClone(initialModels),
    sessions: structuredClone(initialSessions),
    instances: [instance],
    next: null as null | { after: string },
    faults: {} as Partial<Record<Catalog, Fault>>,
    hold: {} as Partial<Record<Catalog, Promise<void>>>,
    partial: false,
  };
  const requests: { field: Catalog; cursor: unknown }[] = [];
  const errors: unknown[] = [];
  const rootValue = {
    harnesses() {
      if (state.faults.harnesses === "graphql") throw new GraphQLError("unavailable");
      return state.sessions;
    },
    models() {
      if (state.faults.models === "graphql") throw new GraphQLError("unavailable");
      return state.models;
    },
    instances({ cursor }: { cursor?: unknown }, record: { cursor: unknown }) {
      record.cursor = cursor;
      if (state.faults.instances === "graphql") throw new GraphQLError("unavailable");
      return {
        nodes: state.instances.map((item) => ({
          ...item,
          connect() {
            if (state.partial && item.id === instance.id)
              throw new GraphQLError("Connection data unavailable");
            return item.connect;
          },
        })),
        pageInfo: { next: state.next },
      };
    },
  };
  const assets: Record<string, string> = {
    "/": "index.html",
    "/main.js": "main.js",
    "/styles.css": "styles.css",
    "/bootstrap.js": "bootstrap.js",
  };
  const server = createServer((request, response) => {
    void (async () => {
      if (request.url === "/api/graphql") {
        assert.equal(request.method, "POST");
        assert.equal(request.headers["content-type"], "application/json");
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString()) as { query: string };
        const operation = parse(body.query).definitions[0];
        assert.equal(operation?.kind, Kind.OPERATION_DEFINITION);
        assert(operation?.kind === Kind.OPERATION_DEFINITION);
        assert.equal(operation.operation, "query");
        const selection = operation.selectionSet.selections[0];
        assert(selection?.kind === Kind.FIELD);
        const field = selection.name.value;
        assert(field === "harnesses" || field === "models" || field === "instances");
        const record: { field: Catalog; cursor: unknown } = { field, cursor: undefined };
        requests.push(record);
        await state.hold[field];
        const fault = state.faults[field];
        if (fault === "network") return request.socket.destroy();
        if (fault === "http" || fault === "denied") {
          response.writeHead(fault === "http" ? 503 : 403).end();
          return;
        }
        if (fault === "malformed") {
          response.writeHead(200, { "content-type": "application/json" }).end("{");
          return;
        }
        const result = await graphql({
          schema,
          source: body.query,
          rootValue,
          contextValue: record,
        });
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
        return;
      }
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      const name =
        assets[path] ?? (request.headers.accept?.includes("text/html") ? "index.html" : undefined);
      if (!name) {
        response.writeHead(404).end();
        return;
      }
      const bytes = await readFile(new URL(`../dist/${name}`, import.meta.url));
      response
        .writeHead(200, {
          "content-type": name.endsWith(".js")
            ? "text/javascript"
            : name.endsWith(".css")
              ? "text/css"
              : "text/html",
        })
        .end(bytes);
    })().catch((error) => {
      errors.push(error);
      response.writeHead(500).end();
    });
  });
  let activePage: Page | undefined;
  t.after(async () => {
    await activePage?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    assert.deepEqual(errors, []);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/`;
  const page = await browser.newPage({ viewport: { width, height } });
  activePage = page;
  page.on("pageerror", (error) => errors.push(error));

  return { page, state, requests, url };
}

async function ready(page: Page) {
  await page.locator("#models option").nth(2).waitFor({ state: "attached" });
  await page.locator("#targets option").nth(1).waitFor({ state: "attached" });
  await page.locator("#session-list .session").nth(1).waitFor();
  await page.locator(".read-status").waitFor({ state: "detached" });
}

async function refresh(page: Page, name: string) {
  await page.getByRole("button", { name: `Refresh ${name}`, exact: true }).click({ force: true });
}

await test("read-only home", async (suite) => {
  const executablePath =
    process.env.CHROMIUM_BINARY ??
    (process.env.PATH ?? "")
      .split(delimiter)
      .map((directory) => join(directory, "chromium"))
      .find(existsSync);
  assert(executablePath, "Set CHROMIUM_BINARY or put Chromium on PATH");
  const browser = await chromium.launch({
    executablePath,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  suite.after(() => browser.close());

  await suite.test(
    "home reads independent catalogs; draft controls stay local and never mutate",
    async (t) => {
      const { page, state, requests, url } = await fixture(t, browser);
      await page.goto(url);
      await ready(page);
      assert.deepEqual(await page.locator(".session-heading strong").allTextContents(), [
        "alpha",
        "zeta",
      ]);
      assert.equal(await page.getByLabel("Working directory", { exact: true }).inputValue(), "");
      assert.equal(await page.getByLabel("Environment", { exact: true }).inputValue(), "");
      assert.equal(await page.getByLabel("Model", { exact: true }).inputValue(), "");

      const modelKey = JSON.stringify(["one", "same/id"]);
      await page.getByLabel("Model", { exact: true }).selectOption(modelKey);
      await page.getByLabel("Thinking", { exact: true }).selectOption("high");
      await page
        .getByLabel("Environment", { exact: true })
        .selectOption(JSON.stringify(instance.id));
      await page.getByLabel("Working directory", { exact: true }).fill("~/literal/space here");
      await page.getByRole("textbox", { name: "Message" }).fill("  hello 🧑🏽‍💻\nsecond line  ");
      await page.getByRole("button", { name: "Archive session", exact: true }).first().click();
      await page.getByRole("button", { name: "Create session", exact: true }).click();
      await page.getByRole("textbox", { name: "Message" }).press("Control+Enter");
      await page.getByRole("textbox", { name: "Message" }).press("Meta+Enter");
      await page.getByRole("textbox", { name: "Message" }).press("Alt+Enter");
      assert.equal(await page.locator("#prompt").inputValue(), "  hello 🧑🏽‍💻\nsecond line  ");
      assert.equal(page.url(), url);
      assert.equal(
        await page.getByRole("link", { name: "Global settings" }).getAttribute("href"),
        "/settings",
      );
      assert.equal(await page.locator(".session").first().getAttribute("href"), "/sessions/alpha");
      assert.equal(requests.length, 3);
      assert.deepEqual(state.sessions, initialSessions);

      await page
        .getByLabel("Model", { exact: true })
        .selectOption(JSON.stringify(["two", "same/id"]));
      assert.equal(await page.getByLabel("Thinking", { exact: true }).inputValue(), "");
      assert.deepEqual(
        await page
          .locator("#thinking option")
          .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value)),
        ["", "off"],
      );
      assert.equal(
        await page.getByLabel("Working directory", { exact: true }).inputValue(),
        "~/literal/space here",
      );
      await page.getByLabel("Environment", { exact: true }).selectOption("");
      assert.equal(
        await page.getByLabel("Working directory", { exact: true }).inputValue(),
        "~/literal/space here",
      );
    },
  );

  await suite.test(
    "navigation owns page-local drafts and supports history and deep links",
    async (t) => {
      const { page, requests, url } = await fixture(t, browser);
      await page.goto(url);
      await ready(page);
      await page.locator("#prompt").fill("discard on leaving");
      await page.locator("#prompt").evaluate(() => {
        location.hash = "local";
      });
      await page.waitForURL(new URL("#local", url).href);
      assert.equal(await page.locator("#prompt").inputValue(), "discard on leaving");
      await page.getByRole("link", { name: "Global settings" }).click();
      await page.getByRole("heading", { name: "Settings unavailable" }).waitFor();
      assert.equal(page.url(), new URL("settings", url).href);
      assert.equal(requests.length, 3);
      await page.goBack();
      await ready(page);
      assert.equal(await page.locator("#prompt").inputValue(), "");
      await page.goForward();
      await page.getByRole("heading", { name: "Settings unavailable" }).waitFor();
      await page.reload();
      await page.getByRole("heading", { name: "Settings unavailable" }).waitFor();
      await page.getByRole("link", { name: "Home", exact: true }).click();
      await ready(page);
      await page.locator(".session").first().click();
      await page.getByRole("heading", { name: "Session unavailable" }).waitFor();
      assert.equal(page.url(), new URL("sessions/alpha", url).href);
      await page.goto(new URL("unknown", url).href);
      await page.getByRole("heading", { name: "Not found" }).waitFor();
      await page.getByRole("link", { name: "Home", exact: true }).click();
      await ready(page);
    },
  );

  await suite.test(
    "a response from a previous home visit cannot replace the current catalog",
    async (t) => {
      const { page, state, url } = await fixture(t, browser);
      await page.goto(url);
      await ready(page);
      const delayed = Promise.withResolvers<void>();
      t.after(() => delayed.resolve());
      state.hold.harnesses = delayed.promise;
      const requested = page.waitForRequest(
        (request) => new URL(request.url()).pathname === "/api/graphql",
      );
      await refresh(page, "sessions");
      const oldRequest = await requested;
      await page.getByRole("link", { name: "Global settings" }).click();
      await page.getByRole("heading", { name: "Settings unavailable" }).waitFor();
      delete state.hold.harnesses;
      await page.getByRole("link", { name: "Home", exact: true }).click();
      await ready(page);
      state.sessions = [];
      const received = page.waitForResponse((response) => response.request() === oldRequest);
      delayed.resolve();
      await (await received).finished();
      // Let Elm consume the obsolete response before inspecting the rendered state.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      assert.equal(await page.locator(".session").count(), 2);
    },
  );

  await suite.test(
    "refresh preserves edits, is single-flight, and keeps unavailable selections explicit",
    async (t) => {
      const { page, state, requests, url } = await fixture(t, browser);
      await page.goto(url);
      await ready(page);
      const modelKey = JSON.stringify(["one", "same/id"]);
      await page.locator("#models").selectOption(modelKey);
      await page.locator("#thinking").selectOption("high");
      await page.locator("#targets").selectOption(JSON.stringify(instance.id));
      const delayed = Promise.withResolvers<void>();
      state.hold.models = delayed.promise;
      await refresh(page, "models");
      await page
        .getByRole("button", { name: "Refresh models", exact: true })
        .dispatchEvent("click");
      await page.locator("#prompt").fill("newer draft");
      await page.locator("#base-directory").fill("/newer/path");
      state.models = [];
      delayed.resolve();
      await page.locator("#models option:checked:disabled").waitFor({ state: "attached" });
      assert.equal(requests.filter((request) => request.field === "models").length, 2);
      assert.equal(await page.locator("#models").inputValue(), modelKey);
      assert.equal(await page.locator("#thinking").inputValue(), "high");
      assert.equal(await page.locator("#prompt").inputValue(), "newer draft");
      assert.equal(await page.locator("#base-directory").inputValue(), "/newer/path");
      state.instances = [];
      await refresh(page, "environments");
      await page.locator("#targets option:checked:disabled").waitFor({ state: "attached" });
      assert.equal(await page.locator("#targets").inputValue(), JSON.stringify(instance.id));
      state.models = structuredClone(initialModels);
      await refresh(page, "models");
      await page.locator("#models option").nth(2).waitFor({ state: "attached" });
      assert.equal(
        await page
          .locator("#models option:checked")
          .evaluate((option) => (option as HTMLOptionElement).disabled),
        false,
      );
      assert.equal(await page.locator("#thinking").inputValue(), "high");
    },
  );

  await suite.test(
    "environment pagination preserves opaque cursors and partial GraphQL data",
    async (t) => {
      const { page, state, requests, url } = await fixture(t, browser);
      state.next = { after: "opaque-page-token" };
      state.partial = true;
      await page.goto(url);
      await page.locator("#targets option").nth(1).waitFor({ state: "attached" });
      assert.equal(
        await page
          .locator("#targets option")
          .nth(1)
          .evaluate((option) => (option as HTMLOptionElement).disabled),
        true,
      );
      assert.equal(
        await page.getByRole("alert").textContent(),
        "environments: The server could not complete this read. Partial data shown.Retry",
      );
      const second = {
        id: "instance:two",
        unit: "drv.run@two.service",
        connect: { host: "guest-two" },
      };
      state.instances = [instance, second];
      state.next = null;
      await page.getByRole("button", { name: "More environments" }).click();
      await page.locator("#targets option").nth(2).waitFor({ state: "attached" });
      assert.deepEqual(
        requests
          .filter((request) => request.field === "instances")
          .map((request) => structuredClone(request.cursor)),
        [undefined, { after: "opaque-page-token" }],
      );
      assert.equal(await page.locator("#targets option").count(), 3);
      assert.equal(await page.getByRole("button", { name: "More environments" }).count(), 0);
      await page.locator("#targets").selectOption(JSON.stringify(second.id));
      assert.equal(await page.locator("#targets").inputValue(), JSON.stringify(second.id));
    },
  );

  await suite.test(
    "a failed nullable inventory page keeps prior rows and the continuation cursor",
    async (t) => {
      const { page, state, requests, url } = await fixture(t, browser);
      state.next = { after: "page-two" };
      await page.goto(url);
      await ready(page);
      await page.locator("#targets").selectOption(JSON.stringify(instance.id));
      state.faults.instances = "graphql";
      await page.getByRole("button", { name: "More environments" }).click();
      await page.locator("#footer-instance [role=alert]").waitFor();
      assert.equal(await page.locator("#targets option").count(), 2);
      assert.equal(await page.locator("#targets").inputValue(), JSON.stringify(instance.id));
      assert.equal(
        await page.locator("#footer-instance [role=alert]").textContent(),
        "environments: The server could not complete this read. Previous data is stale.Retry",
      );
      delete state.faults.instances;
      state.next = null;
      await page.getByRole("button", { name: "More environments" }).click();
      await page.getByRole("button", { name: "More environments" }).waitFor({ state: "detached" });
      assert.deepEqual(
        requests
          .filter((request) => request.field === "instances")
          .map((request) => structuredClone(request.cursor)),
        [undefined, { after: "page-two" }, { after: "page-two" }],
      );
      assert.equal(await page.locator("#targets option").count(), 2);
    },
  );

  await suite.test(
    "empty, failed, denied, stale, and loading catalogs remain distinct",
    async (t) => {
      const { page, state, url } = await fixture(t, browser);
      state.sessions = [];
      state.models = [];
      state.instances = [];
      await page.goto(url);
      await page.locator("#sessions-empty").waitFor();
      assert.equal(await page.locator("#sessions-empty").textContent(), "No sessions");
      for (const [fault, expected] of [
        ["http", "HTTP 503."],
        ["network", "Could not reach the server."],
        ["malformed", "Invalid API response."],
        ["denied", "Access denied."],
        ["graphql", "The server could not complete this read."],
      ] as const) {
        state.faults.harnesses = fault;
        await refresh(page, "sessions");
        const alert = page.locator("#landing [role=alert]");
        await page.waitForFunction(
          (message) => document.querySelector("#landing [role=alert]")?.textContent === message,
          `sessions: ${expected} Previous data is stale.Retry`,
        );
        assert.equal(
          await alert.textContent(),
          `sessions: ${expected} Previous data is stale.Retry`,
        );
        assert.equal(await page.locator("#sessions-empty").count(), 0);
      }
      delete state.faults.harnesses;
      state.sessions = structuredClone(initialSessions);
      await page.locator("#landing").getByRole("button", { name: "Retry", exact: true }).click();
      await page.locator(".session").nth(1).waitFor();
      state.faults.harnesses = "http";
      await refresh(page, "sessions");
      await page.locator("#landing [role=alert]").waitFor();
      assert.equal(await page.locator(".session").count(), 2);

      const delayed = Promise.withResolvers<void>();
      state.hold.harnesses = delayed.promise;
      await page.reload();
      await page.locator("#landing [role=status]").waitFor();
      assert.equal(await page.locator("#landing [role=status]").textContent(), "Loading sessions…");
      assert.equal(await page.locator("#sessions-empty").count(), 0);
      delayed.resolve();
      await page.locator("#landing [role=alert]").waitFor();
      assert.equal(
        await page.locator("#landing [role=alert]").textContent(),
        "sessions: HTTP 503.Retry",
      );
    },
  );

  await suite.test(
    "attachments support selection, paste, drop, validation and removal without uploading",
    async (t) => {
      const { page, requests, url } = await fixture(t, browser);
      await page.goto(url);
      await ready(page);
      const chooser = page.waitForEvent("filechooser");
      await page.getByRole("button", { name: "Upload attachments" }).click();
      await (
        await chooser
      ).setFiles([
        { name: "note.txt", mimeType: "text/plain", buffer: Buffer.from("hello 🧑🏽‍💻\n") },
        {
          name: "binary.bin",
          mimeType: "application/octet-stream",
          buffer: Buffer.from([0, 1, 2]),
        },
        {
          name: "invalid-utf8.txt",
          mimeType: "text/plain",
          buffer: Buffer.from([0xed, 0xa0, 0x80]),
        },
      ]);
      await page.locator("#previews [role=alert]").nth(1).waitFor();
      assert.equal(await page.locator("#previews button").count(), 3);
      await page.getByRole("button", { name: "Remove note.txt", exact: true }).click();
      await page
        .getByRole("button", { name: "Remove note.txt", exact: true })
        .waitFor({ state: "detached" });
      assert.equal(await page.locator("#previews button").count(), 2);
      await page.locator("#prompt").evaluate((element) => {
        const clipboardData = new DataTransfer();
        clipboardData.items.add(new File(["pasted text"], "paste.txt", { type: "text/plain" }));
        element.dispatchEvent(
          new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }),
        );
      });
      await page.getByRole("button", { name: "Remove paste.txt", exact: true }).waitFor();
      await page.locator(".compose-box").evaluate((element) => {
        const dataTransfer = new DataTransfer();
        const png = Uint8Array.from(
          atob(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1kAAAAASUVORK5CYII=",
          ),
          (char) => char.charCodeAt(0),
        );
        dataTransfer.items.add(new File([png], "image.png", { type: "image/png" }));
        element.dispatchEvent(
          new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }),
        );
      });
      await page.getByRole("img", { name: "image.png" }).waitFor();
      await page.getByRole("button", { name: "Create session", exact: true }).click();
      assert.equal(await page.locator("#previews button").count(), 4);
      assert.equal(requests.length, 3);
      await page.reload();
      await ready(page);
      assert.equal(await page.locator("#previews button").count(), 0);
    },
  );

  await suite.test(
    "desktop and mobile retain the reference layout with keyboard-accessible controls",
    async (t) => {
      for (const width of [1440, 900, 390, 320]) {
        const { page, url } = await fixture(t, browser, width, 800);
        await page.goto(url);
        await ready(page);
        const geometry = await page.evaluate(() => {
          const box = (selector: string) => {
            const element = document.querySelector(selector);
            assertElement(element);
            const { x, y, width, height } = element.getBoundingClientRect();
            return { x, y, width, height };
          };
          function assertElement(element: Element | null): asserts element is Element {
            if (!element) throw new Error("Missing layout element");
          }
          return {
            viewport: innerWidth,
            scroll: document.documentElement.scrollWidth,
            composer: box(".compose-box"),
            environment: box("#footer-instance"),
            model: box("#footer-model"),
            settings: box(".landing-navigation .icon"),
            background: getComputedStyle(document.documentElement).backgroundColor,
          };
        });
        assert.equal(geometry.scroll, geometry.viewport);
        assert.equal(geometry.background, "rgb(21, 23, 25)");
        assert.equal(geometry.composer.width, width >= 860 ? 820 : width - 20);
        assert(geometry.environment.y + geometry.environment.height <= geometry.composer.y);
        assert(geometry.model.y >= geometry.composer.y + geometry.composer.height);
        assert(geometry.model.y + geometry.model.height <= 800);
        assert.equal(geometry.settings.width, 44);
        await page.locator("#models").focus();
        await page.locator("#models").press("ArrowDown");
        await page.locator("#models").press("Enter");
        assert.notEqual(await page.locator("#models").inputValue(), "");
        await page.locator("#prompt").fill("first");
        await page.locator("#prompt").press("End");
        await page.locator("#prompt").press("Enter");
        await page.locator("#prompt").pressSequentially("second");
        assert.equal(await page.locator("#prompt").inputValue(), "first\nsecond");
        await page
          .locator("#prompt")
          .dispatchEvent("keydown", { key: "Enter", isComposing: true, ctrlKey: true });
        assert.equal(await page.locator("#prompt").inputValue(), "first\nsecond");
      }
    },
  );

  await suite.test(
    "long choices and a reduced viewport keep the composer reachable without horizontal overflow",
    async (t) => {
      const { page, state, url } = await fixture(t, browser, 320, 400);
      state.models[0]!.name = "A very long model name ".repeat(10);
      state.instances[0] = {
        ...instance,
        unit: "drv.run@" + "long-environment-".repeat(20) + ".service",
      };
      await page.goto(url);
      await ready(page);
      await page.locator("#models").selectOption(JSON.stringify(["one", "same/id"]));
      await page.locator("#targets").selectOption(JSON.stringify(instance.id));
      await page.locator("#base-directory").fill("/workspace/" + "directory/".repeat(30));
      await page.locator("#prompt").fill("line\n".repeat(30));
      await page
        .getByRole("button", { name: "Create session", exact: true })
        .scrollIntoViewIfNeeded();
      const layout = await page.evaluate(() => {
        const submit = document.querySelector("#create")!.getBoundingClientRect();
        return {
          width: document.documentElement.scrollWidth,
          viewport: innerWidth,
          bottom: submit.bottom,
          height: innerHeight,
        };
      });
      assert.equal(layout.width, layout.viewport);
      assert(layout.bottom <= layout.height);
      assert.equal(await page.locator("#prompt").inputValue(), "line\n".repeat(30));
      assert.equal(page.url(), url);
    },
  );
});
