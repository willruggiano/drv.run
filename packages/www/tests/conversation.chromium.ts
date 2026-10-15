import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { chromium, type Page } from "playwright";
import { assistant, entry, fixture, snapshot, usage, user } from "./browser-testing.ts";

declare global {
  interface Window {
    testSources: EventSource[];
    testURLs: string[];
  }
}

async function connected(page: Page) {
  await page.locator("#connection.sr-only").waitFor({ state: "attached" });
  await page.locator("#entry-2").waitFor();
}
async function painted(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

// Give DOM tasks multiple frames to finish even on a fast host. Assertions
// must await the resulting geometry/selection, not a fixed number of paints.
async function deferDomFrames(page: Page) {
  await page.addInitScript(() => {
    const request = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) => request(() => request(() => request(callback)));
  });
}

async function entryVisible(page: Page, id: number) {
  await page.waitForFunction((id) => {
    const node = document.getElementById(`entry-${id}`);
    const scroll = document.getElementById("conversation-scroll");
    if (!node || !scroll || !node.checkVisibility()) return false;
    const entry = node.getBoundingClientRect();
    const viewport = scroll.getBoundingClientRect();
    return entry.top >= viewport.top && entry.bottom <= viewport.bottom;
  }, id);
}

await test("conversation observation", async (suite) => {
  const executablePath =
    process.env.CHROMIUM_BINARY ??
    (process.env.PATH ?? "")
      .split(delimiter)
      .map((directory) => join(directory, "chromium"))
      .find(existsSync);
  assert(executablePath);
  const browser = await chromium.launch({
    executablePath,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  suite.after(() => browser.close());

  await suite.test(
    "home resolves the passive root, deep links and existing branch links preserve resource identity",
    async (t) => {
      const { page, url, watchRequests, streams, state } = await fixture(t, browser);
      await page.goto(url);
      await page.locator(".session").first().click();
      await page.waitForURL(new URL("sessions/alpha/conversations/1", url).href);
      await connected(page);
      assert.deepEqual(watchRequests, [{ externalId: "alpha", conversationId: 1 }]);
      assert.equal(
        await page.locator("#footer-model .model-name .selector-value").textContent(),
        "same/id",
      );
      await page.locator("#prompt").fill("local draft");
      await page.getByLabel("Conversation branches", { exact: true }).first().click();
      await page.locator("#branch-2 a").click();
      await page.waitForURL(new URL("sessions/alpha/conversations/2", url).href);
      await connected(page);
      assert.equal(await page.locator("#prompt").inputValue(), "");
      assert.equal(watchRequests.at(-1)?.conversationId, 2);
      await page.goBack();
      await connected(page);
      assert.equal(await page.locator("#prompt").inputValue(), "");
      await page.reload();
      await connected(page);
      await page.goto(new URL("sessions/alpha/conversations/999", url).href);
      await page.getByRole("alert").waitFor();
      assert.equal(
        await page.getByRole("alert").textContent(),
        "Conversation not found or unavailable.Home",
      );
      await page.goto(new URL("sessions/zeta", url).href);
      await page.getByRole("button", { name: "Create root" }).waitFor();
      assert.equal(state.sessions[1]!.root, null);
      await painted(page);
      assert.equal(streams.size, 0);
      for (const invalid of ["-1", "1.5", "9007199254740992", "%FF"]) {
        await page.goto(new URL(`sessions/alpha/conversations/${invalid}`, url).href);
        await page.getByRole("heading", { name: "Not found" }).waitFor();
      }
    },
  );

  await suite.test(
    "atomic watch batches replace partial answers once and preserve history, disclosures, edits and usage",
    async (t) => {
      const { page, url, state, emit } = await fixture(t, browser);
      const call = {
        type: "toolCall",
        id: "call-1",
        name: "bash",
        arguments: { command: "printf test" },
      };
      state.snapshot.view.entries.push(entry(3, { ...assistant(""), content: [call] }));
      state.snapshot.view.docs["pi.live"] = {
        run: { taskId: 1, inputs: [], turns: 1 },
        generation: { attempt: 1, message: assistant("Streaming") },
        tools: [
          {
            callId: "call-1",
            name: "bash",
            status: "running",
            output: "progress",
            droppedBytes: 20,
            droppedLines: 1,
          },
        ],
        nestedTools: [
          {
            callId: "call-1/child",
            name: "read",
            status: "running",
            output: "nested",
            arguments: { path: "file.txt" },
          },
        ],
        compactions: [{ taskId: 4, trigger: "threshold", blocking: false, attempt: 1 }],
      };
      state.snapshot.view.docs["pi.usage"] = { models: { "one/same/id": usage }, tools: {} };
      await page.goto(new URL("sessions/alpha/conversations/1", url).href);
      await connected(page);
      await page.locator("#live article").waitFor();
      const tool = page.locator("#entry-3 details");
      await tool.locator("summary").click();
      assert.equal(await tool.evaluate((node) => (node as HTMLDetailsElement).open), true);
      assert.equal(await page.locator("#footer-cost").textContent(), "$0.037");
      assert.equal(await page.locator("#footer-input").textContent(), "↑1.2k");
      await page.locator("#prompt").fill("draft");
      emit([
        [
          "a",
          ["view", "docs", "pi.live", "generation", "message", "content", 0, "text"],
          " complete",
        ],
      ]);
      await page.waitForFunction(
        () => document.querySelector("#live article .text")?.textContent === "Streaming complete",
      );
      const committed = entry(4, assistant("Streaming complete"));
      emit([
        ["p", ["view", "entries"], 3, 0, [committed]],
        ["d", ["view", "docs", "pi.live", "generation"]],
      ]);
      await page.locator("#entry-4").waitFor();
      assert.equal(await page.locator("#live article").count(), 0);
      assert.equal(await page.locator("#entry-4").count(), 1);
      assert.equal(await tool.evaluate((node) => (node as HTMLDetailsElement).open), true);
      assert.equal(await page.locator("#prompt").inputValue(), "draft");
      const replacement = snapshot();
      replacement.view.entries = [committed];
      replacement.view.before = 3;
      emit([["r", replacement]]);
      await page.getByRole("button", { name: "Send", exact: true }).waitFor();
      assert.equal(await page.locator("#entry-1").count(), 1);
      assert.equal(await page.locator("#entry-4").count(), 1);
      assert.equal(await page.locator("#footer-cost").textContent(), "$—");
      assert.equal(await page.locator("#prompt").inputValue(), "draft");
    },
  );

  await suite.test(
    "watch interruption, invalid batches and mismatched baselines keep valid content stale until reconnect",
    async (t) => {
      const { page, url, emit, streams, state, watchRequests } = await fixture(t, browser);
      state.automaticBaseline = false;
      const initial = page.waitForResponse(
        (response) => new URL(response.url()).pathname === "/api/watch",
      );
      await page.goto(new URL("sessions/alpha/conversations/1", url).href);
      await initial;
      assert.equal(await page.locator("#connection.sr-only").count(), 0);
      emit([["r", state.snapshot]]);
      await connected(page);
      emit([
        ["s", ["view", "entries", 0, "model", 0, "content"], "must not commit"],
        ["unknown", []],
      ]);
      await page.getByRole("button", { name: "Reconnect" }).waitFor();
      assert.equal(await page.locator("#entry-1 .text").textContent(), "Hello");
      const reconnected = page.waitForResponse(
        (response) => new URL(response.url()).pathname === "/api/watch",
      );
      await page.getByRole("button", { name: "Reconnect" }).click();
      await reconnected;
      emit([["s", ["view", "entries"], []]]);
      await page.getByRole("button", { name: "Reconnect" }).waitFor();
      assert.equal(await page.locator("#entry-1 .text").textContent(), "Hello");
      state.automaticBaseline = true;
      await page.getByRole("button", { name: "Reconnect" }).click();
      await connected(page);
      emit([
        ["r", { ...state.snapshot, view: { ...state.snapshot.view, conversation: { id: 2 } } }],
      ]);
      await page.getByRole("button", { name: "Reconnect" }).waitFor();
      assert.equal(await page.locator("#entry-1 .text").textContent(), "Hello");
      await page.getByRole("button", { name: "Reconnect" }).click();
      await connected(page);
      for (const stream of streams.keys()) stream.end();
      await page.getByRole("button", { name: "Reconnect" }).waitFor();
      assert.equal(await page.locator("#entry-1 .text").textContent(), "Hello");
      assert(watchRequests.length >= 4);
    },
  );

  await suite.test(
    "history is explicitly paginated, survives reconnect and cannot overwrite live state",
    async (t) => {
      const { page, url, state, emit, requests } = await fixture(t, browser);
      state.snapshot.view.entries = [entry(101, user("recent")), entry(102, assistant("latest"))];
      state.snapshot.view.before = 100;
      state.history = [entry(100, user("older"))];
      state.historyNext = { after: 100 };
      await page.goto(new URL("sessions/alpha/conversations/1", url).href);
      await page.locator("#entry-102").waitFor();
      assert.equal(requests.filter((request) => request.query !== undefined).length, 0);
      await page.getByRole("button", { name: "Load older messages" }).click();
      await page.locator("#entry-100").waitFor();
      assert.deepEqual(
        requests
          .filter((request) => request.query !== undefined)
          .map((request) => ({ query: structuredClone(request.query), cursor: request.cursor })),
        [{ query: { maxEntryId: 100, order: "descending" }, cursor: undefined }],
      );
      const delayed = Promise.withResolvers<void>();
      t.after(() => delayed.resolve());
      state.hold.harness = delayed.promise;
      await page.getByRole("button", { name: "Load older messages" }).click();
      emit([
        [
          "s",
          ["view", "docs", "pi.live"],
          {
            run: { taskId: 4, inputs: [], turns: 0 },
            generation: { attempt: 1, message: assistant("Still live") },
          },
        ],
      ]);
      await page.locator("#live article").waitFor();
      state.history = [entry(1, user("oldest"))];
      state.historyNext = null;
      delayed.resolve();
      await page.locator("#entry-1").waitFor();
      assert.equal(await page.locator("#live article .text").textContent(), "Still live");
      assert.deepEqual(
        structuredClone(requests.filter((request) => request.query !== undefined).at(-1)?.cursor),
        {
          after: 100,
        },
      );
      assert.equal(await page.getByRole("button", { name: "Load older messages" }).count(), 0);
      emit([["r", state.snapshot]]);
      await painted(page);
      assert.equal(await page.locator("#entry-1").count(), 1);
      assert.equal(await page.locator("#entry-100").count(), 1);
    },
  );

  await suite.test(
    "search reveals folded history and tools; anchors, Latest, selection and scrollback remain local",
    async (t) => {
      const { page, url, state, emit } = await fixture(t, browser);
      state.snapshot.view.entries = [
        entry(1, user("needle in archived history")),
        { id: 2, conversationId: 1, kind: "pi.reset", head: 2 },
        entry(3, assistant("new context")),
      ];
      state.snapshot.head = state.snapshot.view.entries[1]!;
      await deferDomFrames(page);
      await page.goto(new URL("sessions/alpha/conversations/1?q=needle", url).href);
      await page.locator("#entry-1").waitFor();
      assert.equal(await page.locator("#search").inputValue(), "needle");
      assert.equal(await page.locator("#search-count").textContent(), "1/1");
      await page.locator("#search").click();
      await page.keyboard.press("Escape");
      await page.locator("#entry-1").waitFor({ state: "hidden" });
      await page.goto(new URL("sessions/alpha/conversations/1#entry-1", url).href);
      await page.locator("#entry-1").waitFor();
      await page.getByRole("button", { name: "Latest", exact: true }).click();
      await page.locator("#prompt").fill("preserved");
      emit([
        [
          "p",
          ["view", "entries"],
          3,
          0,
          Array.from({ length: 30 }, (_, index) =>
            entry(index + 4, user("A long message\n".repeat(5))),
          ),
        ],
      ]);
      await page.locator("#entry-33").waitFor();
      await page.getByRole("button", { name: "Top", exact: true }).click();
      await entryVisible(page, 1);
      const before = await page
        .locator("#conversation-scroll")
        .evaluate((element) => element.scrollTop);
      emit([["p", ["view", "entries"], 33, 0, [entry(34, assistant("new output"))]]]);
      await page.locator("#entry-34").waitFor({ state: "attached" });
      await painted(page);
      assert.equal(
        await page.locator("#conversation-scroll").evaluate((element) => element.scrollTop),
        before,
      );
      assert.equal(await page.locator("#prompt").inputValue(), "preserved");
    },
  );

  await suite.test(
    "untrusted content remains passive and desktop/mobile match the reference geometry",
    async (t) => {
      for (const width of [1440, 900, 390, 320]) {
        const { page, url, state, requests } = await fixture(t, browser, width, 800);
        state.snapshot.view.entries[1] = entry(
          2,
          assistant(
            "# Heading\n\n**bold** `inline` [safe](https://example.org) [bad](javascript:alert(1)) ![remote](https://example.org/private.png)\n\n<script>alert(1)</script>\n\n```js\nconst x = 1;\n```",
          ),
        );
        await page.goto(new URL("sessions/alpha/conversations/1", url).href);
        await connected(page);
        assert.equal(await page.locator("#transcript script").count(), 0);
        assert.equal(await page.locator("#transcript img").count(), 0);
        assert.equal(await page.locator("#transcript a").count(), 1);
        assert.equal(
          await page.locator("#transcript a").getAttribute("rel"),
          "noopener noreferrer",
        );
        await page.locator("#entry-2 .shj-syn-kwd").waitFor();
        const geometry = await page.evaluate(() => {
          const composer = document.querySelector(".compose-box")!.getBoundingClientRect();
          const navigation = document
            .querySelector("#conversation-navigation")!
            .getBoundingClientRect();
          return {
            width: document.documentElement.scrollWidth,
            viewport: innerWidth,
            composer: composer.width,
            bottom: composer.bottom,
            navigation: navigation.width,
            height: innerHeight,
          };
        });
        assert.equal(geometry.width, geometry.viewport);
        assert.equal(geometry.composer, width >= 860 ? 820 : width - 20);
        assert(geometry.bottom <= geometry.height);
        if (width <= 650) {
          await page.getByRole("button", { name: "Collapse composer" }).click();
          await page.locator("#prompt").waitFor({ state: "hidden" });
          await page.getByRole("button", { name: "Expand composer" }).click();
          await page.locator("#prompt").waitFor();
        }
        const count = requests.length;
        const chooser = page.waitForEvent("filechooser");
        await page.getByRole("button", { name: "Upload attachments" }).click();
        await (
          await chooser
        ).setFiles([
          { name: "note.txt", mimeType: "text/plain", buffer: Buffer.from("offline") },
          { name: "binary.bin", mimeType: "application/octet-stream", buffer: Buffer.from([0, 1]) },
        ]);
        await page.locator("#previews [role=alert]").waitFor();
        assert.equal(
          await page.getByRole("button", { name: "Send", exact: true }).isDisabled(),
          true,
        );
        await page.locator("#previews button").nth(1).click();
        assert.equal(
          await page.getByRole("button", { name: "Send", exact: true }).isEnabled(),
          true,
        );
        assert.equal(await page.locator("#previews button").count(), 1);
        assert.equal(requests.length, count);
      }
    },
  );

  await suite.test(
    "all decoded Chord operations preserve Unicode and reject invalid paths atomically",
    async (t) => {
      const { page, url, state, emit } = await fixture(t, browser);
      state.snapshot.view.docs["pi.live"] = {
        generation: {
          attempt: 1,
          message: {
            ...assistant(""),
            content: [
              { type: "text", text: "🧑prefix" },
              { type: "thinking", thinking: "reasoning" },
            ],
          },
        },
      };
      await page.goto(new URL("sessions/alpha/conversations/1", url).href);
      await connected(page);
      const content = ["view", "docs", "pi.live", "generation", "message", "content"];
      emit([
        ["t", [...content, 0, "text"], 2],
        ["a", [...content, 0, "text"], " suffix"],
        ["m", content, [1, 0]],
      ]);
      await page.waitForFunction(
        () => document.querySelector("#live .text")?.textContent === "prefix suffix",
      );
      assert.deepEqual(
        await page
          .locator("#live article > :not(header)")
          .evaluateAll((nodes) => nodes.map((node) => node.className)),
        ["thinking", "text"],
      );
      emit([
        ["d", [...content, 0]],
        ["s", [...content, 1], { type: "text", text: "appended" }],
        ["p", content, 1, 1, [{ type: "text", text: "spliced" }]],
      ]);
      await page.waitForFunction(
        () => document.querySelectorAll("#live .text")[1]?.textContent === "spliced",
      );
      emit([]);
      await painted(page);
      assert.equal(await page.locator("#connection.sr-only").count(), 1);
      emit([
        ["a", [...content, 0, "text"], " not committed"],
        ["s", ["__proto__", "polluted"], true],
      ]);
      await page.getByRole("button", { name: "Reconnect" }).waitFor();
      assert.equal(await page.locator("#live .text").first().textContent(), "prefix suffix");
      assert.equal(await page.evaluate(() => Object.hasOwn(Object.prototype, "polluted")), false);
    },
  );

  await suite.test(
    "a reconnect gap cannot be declared complete by an older in-flight history response",
    async (t) => {
      const { page, url, state, emit } = await fixture(t, browser);
      state.snapshot.view.entries = [entry(101, user("recent")), entry(102, assistant("current"))];
      state.snapshot.view.before = 100;
      await page.goto(new URL("sessions/alpha/conversations/1", url).href);
      await page.locator("#entry-102").waitFor();
      const delayed = Promise.withResolvers<void>();
      t.after(() => delayed.resolve());
      state.hold.harness = delayed.promise;
      const requested = page.waitForRequest(
        (request) => new URL(request.url()).pathname === "/api/graphql",
      );
      await page.getByRole("button", { name: "Load older messages" }).click();
      const original = await requested;
      state.snapshot.view.entries = [
        entry(201, user("after disconnect")),
        entry(202, assistant("new current")),
      ];
      state.snapshot.view.before = 200;
      emit([["r", state.snapshot]]);
      await page.locator("#entry-202").waitFor();
      state.history = [entry(100, user("old response"))];
      const received = page.waitForResponse((response) => response.request() === original);
      delayed.resolve();
      await (await received).finished();
      await page.locator("#entry-100").waitFor();
      assert.equal(
        await page.getByRole("button", { name: "Load older messages" }).isEnabled(),
        true,
      );
      delete state.hold.harness;
      state.history = [entry(200, user("gap filled"))];
      await page.getByRole("button", { name: "Load older messages" }).click();
      await page.locator("#entry-200").waitFor();
      assert.equal(await page.locator("#entry-202 .text").textContent(), "new current");
    },
  );

  await suite.test(
    "a response from an earlier visit cannot change the addressed conversation",
    async (t) => {
      const { page, url, state } = await fixture(t, browser);
      state.snapshot.view.before = 0;
      await page.goto(new URL("sessions/alpha/conversations/1", url).href);
      await connected(page);
      const delayed = Promise.withResolvers<void>();
      t.after(() => delayed.resolve());
      state.hold.harness = delayed.promise;
      const requested = page.waitForRequest(
        (request) => new URL(request.url()).pathname === "/api/graphql",
      );
      await page.getByRole("button", { name: "Load older messages" }).click();
      const original = await requested;
      await page.getByRole("link", { name: "Global settings", exact: true }).click();
      await page.getByRole("heading", { name: "Settings unavailable" }).waitFor();
      delete state.hold.harness;
      await page.goBack();
      await connected(page);
      state.history = [entry(0, user("obsolete history"))];
      const response = page.waitForResponse((reply) => reply.request() === original);
      delayed.resolve();
      await (await response).finished();
      await painted(page);
      assert.equal(await page.locator("#entry-0").count(), 0);
    },
  );

  await suite.test(
    "compaction durations use completed task timing and established summary placement",
    async (t) => {
      const { page, url, state } = await fixture(t, browser);
      state.snapshot.view.entries.push({
        id: 3,
        conversationId: 1,
        kind: "pi.compaction",
        head: 3,
        model: [user("summary")],
      });
      state.snapshot.head = state.snapshot.view.entries[2]!;
      state.tasks = [
        {
          conversationId: 1,
          startedAt: 1000,
          endedAt: 2540,
          state: { outcome: { status: "completed", result: { submissionId: 8 } } },
        },
      ];
      state.placements.set(8, 3);
      await page.goto(new URL("sessions/alpha/conversations/1", url).href);
      await page.locator("#duration-3").waitFor();
      assert.equal(await page.locator("#duration-3").getAttribute("data-duration-ms"), "1540");
      assert.equal(await page.locator("#duration-3").textContent(), "1.5s");
      assert.equal(await page.locator("#footer-context").textContent(), "—/200k");
      await page.locator("#entry-3 summary").click();
      await page.locator("#entry-1").waitFor();
      assert.equal(await page.locator("#entry-3 .compaction-summary").textContent(), "summary");
    },
  );
  await suite.test(
    "optional read failures do not prevent observation or erase the transcript",
    async (t) => {
      const { page, url, state } = await fixture(t, browser);
      state.failTimings = true;
      state.failBranches = true;
      state.faults.settings = "http";
      await page.goto(new URL("sessions/alpha/conversations/1", url).href);
      await connected(page);
      await page.locator(".history-controls [role=alert]").waitFor();
      assert.equal(await page.locator("#entry-1 .text").textContent(), "Hello");
      await page.locator("#prompt").fill("editable while an optional read fails");
      state.failTimings = false;
      await page
        .locator(".history-controls")
        .getByRole("button", { name: "Retry", exact: true })
        .click();
      await page.locator(".history-controls [role=alert]").waitFor({ state: "detached" });
      assert.equal(
        await page.locator("#prompt").inputValue(),
        "editable while an optional read fails",
      );
    },
  );
  await suite.test(
    "a rootless session exposes existing conversations on mobile without creating a root",
    async (t) => {
      const { page, url, state } = await fixture(t, browser, 390, 844);
      await page.goto(new URL("sessions/zeta", url).href);
      await page.locator("#branch-2 a").click();
      await page.waitForURL(new URL("sessions/zeta/conversations/2", url).href);
      await connected(page);
      assert.equal(state.sessions[1]?.root, null);
    },
  );
  for (const terminal of [false, true]) {
    await suite.test(
      `a partial ${terminal ? "final" : "nonfinal"} history page retries the same cursor`,
      async (t) => {
        const { page, url, state, requests } = await fixture(t, browser);
        state.snapshot.view.entries = [entry(101, user("recent")), entry(102, assistant("latest"))];
        state.snapshot.view.before = 100;
        state.history = [entry(100, user("first page"))];
        state.historyNext = { after: 100 };
        await page.goto(new URL("sessions/alpha/conversations/1", url).href);
        await page.locator("#entry-102").waitFor();
        await page.getByRole("button", { name: "Load older messages" }).click();
        await page.locator("#entry-100").waitFor();
        state.history = [
          entry(99, user("recovered model")),
          entry(98, user("usable partial data")),
        ];
        state.historyNext = terminal ? null : { after: 98 };
        state.historyModelFailure = 99;
        await page.getByRole("button", { name: "Load older messages" }).click();
        await page.locator(".history-controls [role=alert]").waitFor();
        assert.equal(await page.locator("#entry-98 .text").textContent(), "usable partial data");
        assert.equal(await page.locator("#entry-99 .text").count(), 0);
        state.historyModelFailure = null;
        await page
          .locator(".history-controls")
          .getByRole("button", { name: "Retry", exact: true })
          .click();
        await page.locator("#entry-99 .text").waitFor();
        await page.locator(".history-controls [role=alert]").waitFor({ state: "detached" });
        assert.equal(await page.locator("#entry-99 .text").textContent(), "recovered model");
        assert.deepEqual(
          requests
            .filter((request) => request.query !== undefined)
            .map((request) => structuredClone(request.cursor)),
          [undefined, { after: 100 }, { after: 100 }],
        );
        if (!terminal) {
          state.history = [entry(1, user("oldest"))];
          state.historyNext = null;
          await page.getByRole("button", { name: "Load older messages" }).click();
          await page.locator("#entry-1").waitFor();
          assert.deepEqual(
            structuredClone(
              requests.filter((request) => request.query !== undefined).at(-1)?.cursor,
            ),
            { after: 98 },
          );
        }
        assert.equal(await page.getByRole("button", { name: "Load older messages" }).count(), 0);
        assert.equal(await page.locator("#entry-102 .text").textContent(), "latest");
      },
    );
  }

  await suite.test(
    "URL-driven search updates highlights and scrolling without a watch event",
    async (t) => {
      const { page, url, state, watchRequests } = await fixture(t, browser);
      state.snapshot.view.entries = [
        entry(1, user("Hello")),
        ...Array.from({ length: 30 }, (_, index) =>
          entry(index + 2, user("Other content\n".repeat(6))),
        ),
        entry(32, assistant("Needle")),
      ];
      await deferDomFrames(page);
      await page.goto(new URL("sessions/alpha/conversations/1?q=Hello", url).href);
      const highlighted = async (value: string) => {
        await page.waitForFunction((expected) => {
          return Array.from(document.querySelectorAll("mark.search-match")).some(
            (node) => node.textContent === expected,
          );
        }, value);
      };
      const navigate = async (query: string) => {
        const target = new URL(`sessions/alpha/conversations/1${query}`, url).href;
        await page.evaluate((href) => {
          const previous = location.href;
          history.pushState(null, "", href);
          history.pushState(null, "", previous);
        }, target);
        await page.goBack();
        await page.waitForURL(target);
      };
      await highlighted("Hello");
      await navigate("?q=Needle");
      await highlighted("Needle");
      assert.equal(await page.locator("#search").inputValue(), "Needle");
      assert.equal(await page.locator("#search-count").textContent(), "1/1");
      await entryVisible(page, 32);
      assert(await page.locator("#conversation-scroll").evaluate((node) => node.scrollTop > 0));
      await navigate("");
      await page.waitForFunction(() => document.querySelectorAll("mark.search-match").length === 0);
      assert.equal(await page.locator("#search-bar").isVisible(), false);
      await page.locator("#prompt").fill("retain draft");
      await page.goBack();
      await highlighted("Needle");
      await page.goBack();
      await highlighted("Hello");
      await page.goForward();
      await highlighted("Needle");
      assert.equal(await page.locator("#prompt").inputValue(), "retain draft");
      assert.deepEqual(watchRequests, [{ externalId: "alpha", conversationId: 1 }]);
    },
  );

  for (const query of ["?q=Hello&extra=%2Fkeep", ""]) {
    await suite.test(
      `root resolution retains ${query ? "query parameters and an" : "an"} entry anchor awaiting history`,
      async (t) => {
        const { page, url, state, watchRequests } = await fixture(t, browser);
        state.snapshot.view.entries = [entry(101, user("recent")), entry(102, assistant("latest"))];
        state.snapshot.view.before = 100;
        state.history = [entry(1, user("Hello"))];
        const suffix = `${query}#entry-1`;
        await page.goto(new URL(`sessions/alpha${suffix}`, url).href);
        await page.waitForURL(new URL(`sessions/alpha/conversations/1${suffix}`, url).href);
        await page.locator("#entry-102").waitFor();
        assert.equal(await page.locator("#search-bar").isVisible(), query !== "");
        if (query) assert.equal(await page.locator("#search").inputValue(), "Hello");
        await page
          .getByText("Entry not loaded. Load older messages to find it.", { exact: true })
          .waitFor();
        await page.getByRole("button", { name: "Load older messages" }).click();
        await page.locator("#entry-1").waitFor();
        if (query) {
          await page.waitForFunction(
            () => document.querySelectorAll("mark.search-match").length === 1,
          );
          assert.equal(await page.locator("#search-count").textContent(), "1/1");
        }
        await painted(page);
        assert(
          await page.locator("#entry-1").evaluate((node) => {
            const port = document.querySelector("#conversation-scroll");
            if (!port) return false;
            const entry = node.getBoundingClientRect();
            const viewport = port.getBoundingClientRect();
            return entry.top >= viewport.top && entry.top < viewport.bottom;
          }),
        );
        assert.deepEqual(watchRequests, [{ externalId: "alpha", conversationId: 1 }]);
      },
    );
  }
  await suite.test(
    "Elm image disclosures retain local state and release browser Blob URLs on navigation",
    async (t) => {
      const { page, url, state, emit } = await fixture(t, browser);
      const data =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1kAAAAASUVORK5CYII=";
      state.snapshot.view.entries[0] = entry(1, {
        ...user(""),
        content: [{ type: "image", mimeType: "image/png", data }],
      });
      await page.goto(new URL("sessions/alpha/conversations/1", url).href);
      await connected(page);
      const image = page.locator("#entry-1 img.transcript-image");
      await page.waitForFunction(
        () => document.querySelector<HTMLImageElement>("#entry-1 img")?.naturalWidth === 1,
      );
      const link = page.getByRole("link", { name: "Open in new tab", exact: true });
      const blob = await link.getAttribute("href");
      assert(blob);
      assert.equal(new URL(blob).protocol, "blob:");
      assert.equal(await link.getAttribute("rel"), "noopener noreferrer");
      const downloaded = await page.evaluate(async (url) => {
        const response = await fetch(url);
        return {
          type: response.headers.get("content-type"),
          bytes: Array.from(new Uint8Array(await response.arrayBuffer())),
        };
      }, blob);
      assert.deepEqual(downloaded, {
        type: "image/png",
        bytes: Array.from(Buffer.from(data, "base64")),
      });
      await page.locator(".attachment-preview summary").click();
      await image.waitFor({ state: "hidden" });
      emit([
        [
          "s",
          ["view", "docs", "pi.live"],
          { generation: { attempt: 1, message: assistant("New live output") } },
        ],
      ]);
      await page.locator("#live .text").waitFor();
      assert.equal(
        await page
          .locator(".attachment-preview details")
          .evaluate((node: HTMLDetailsElement) => node.open),
        false,
      );
      await page.locator(".attachment-preview summary").click();
      await image.waitFor();
      assert.equal(await link.getAttribute("href"), blob);
      await page.locator("#conversation-title").click();
      await page.locator("#session-list").waitFor();
      assert.equal(
        await page.evaluate(async (url) => {
          try {
            await fetch(url);
            return false;
          } catch {
            return true;
          }
        }, blob),
        true,
      );
    },
  );

  await suite.test("Elm renders timestamps and CSS truncates command labels", async (t) => {
    const { page, url, state, emit } = await fixture(t, browser, 390, 844);
    state.snapshot.view.entries[1] = entry(2, {
      ...assistant(""),
      content: [
        {
          type: "toolCall",
          id: "long",
          name: "bash",
          arguments: { command: "echo " + "long argument ".repeat(30) },
        },
      ],
    });
    await page.goto(new URL("sessions/alpha/conversations/1", url).href);
    await connected(page);
    await page.waitForFunction(() => {
      const node = document.querySelector<HTMLElement>(".tool-command");
      return node && node.scrollWidth > node.clientWidth;
    });
    emit([
      ["s", ["view", "entries", 1, "model", 0, "content", 0, "arguments", "command"], "pwd"],
      ["s", ["view", "entries", 0, "model", 0, "timestamp"], 0],
    ]);
    await page.waitForFunction(() => {
      const node = document.querySelector<HTMLElement>(".tool-command");
      return node && node.scrollWidth === node.clientWidth;
    });
    assert.equal(await page.locator(".tool-command-text").textContent(), "$ pwd");
    const time = page.locator("#entry-1 time");
    assert.equal(await time.textContent(), "00:00");
    assert.equal(await time.getAttribute("datetime"), "1970-01-01T00:00:00Z");
    assert.equal(await time.getAttribute("title"), "1970-01-01 00:00:00 UTC");
  });
  await suite.test("Elm owns suspension, reconnect generations, and watch disposal", async (t) => {
    const { page, url, watchRequests } = await fixture(t, browser);
    await page.addInitScript(() => {
      window.testSources = [];
      const NativeSource = window.EventSource;
      window.EventSource = class extends NativeSource {
        constructor(url: string | URL, options?: EventSourceInit) {
          super(url, options);
          window.testSources.push(this);
        }
      };
    });
    await page.goto(new URL("sessions/alpha/conversations/1", url).href);
    await connected(page);
    await page.locator("#prompt").fill("discard on document exit");
    await page.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
      window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    });
    await page.waitForFunction(() =>
      window.testSources.every((source) => source.readyState === EventSource.CLOSED),
    );
    assert.equal(watchRequests.length, 1);
    await page.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    });
    await connected(page);
    assert.equal(watchRequests.length, 2);
    assert.equal(await page.locator("#prompt").inputValue(), "");
    await page.evaluate(() => {
      // Simulate an already queued callback from the retired native source.
      window.testSources[0]?.dispatchEvent(new MessageEvent("message", { data: "not JSON" }));
    });
    await painted(page);
    assert.equal(await page.locator("#connection").getAttribute("class"), "sr-only");
    await page.locator("#conversation-title").click();
    await page.locator("#session-list").waitFor();
    await page.waitForFunction(() =>
      window.testSources.every((source) => source.readyState === EventSource.CLOSED),
    );
    assert.equal(await page.locator(".stacked-layout, .wrap-code, .bottom-align").count(), 0);
  });

  for (const during of ["watch", "image"] as const) {
    await suite.test(
      `resources returned after navigation during ${during} creation are disposed`,
      async (t) => {
        const { page, url, state } = await fixture(t, browser);
        state.snapshot.view.entries[0] = entry(1, {
          ...user(""),
          content: [{ type: "image", mimeType: "image/png", data: "AA==" }],
        });
        await page.addInitScript((during) => {
          window.testSources = [];
          window.testURLs = [];
          const navigate = () => {
            history.pushState(null, "", "/");
            window.dispatchEvent(new PopStateEvent("popstate"));
          };
          const NativeSource = window.EventSource;
          window.EventSource = class extends NativeSource {
            constructor(url: string | URL, options?: EventSourceInit) {
              super(url, options);
              window.testSources.push(this);
              if (during === "watch") navigate();
            }
          };
          const create = URL.createObjectURL.bind(URL);
          URL.createObjectURL = (blob) => {
            const url = create(blob);
            window.testURLs.push(url);
            if (during === "image") navigate();
            return url;
          };
        }, during);
        await page.goto(new URL("sessions/alpha/conversations/1", url).href);
        await page.locator("#session-list").waitFor();
        await page.waitForFunction(
          () =>
            window.testSources.length > 0 &&
            window.testSources.every((source) => source.readyState === EventSource.CLOSED),
        );
        if (during === "image") {
          assert.equal(await page.evaluate(() => window.testURLs.length), 1);
          assert(
            await page.evaluate(async () => {
              try {
                await fetch(window.testURLs[0]!);
                return false;
              } catch {
                return true;
              }
            }),
          );
        }
      },
    );
  }

  await suite.test(
    "Elm highlights case-folded Unicode without changing text or executing markup",
    async (t) => {
      const { page, url, state } = await fixture(t, browser);
      const content = "😀 İZ <script>nothing()</script>";
      state.snapshot.view.entries[0] = entry(1, user(content));
      await page.goto(new URL("sessions/alpha/conversations/1", url).href);
      await connected(page);
      await page.locator("#entry-1").click();
      await page.keyboard.press("Control+f");
      await page.locator("#search").fill("i");
      await page.locator("#entry-1 mark").first().waitFor();
      assert.equal(await page.locator("#entry-1 mark").first().textContent(), "İ");
      assert.equal(await page.locator("#entry-1 .text").textContent(), content);
      assert.equal(await page.locator("#entry-1 script").count(), 0);
      await page.locator("#search").fill("😀");
      await page.waitForFunction(
        () => document.querySelector("#entry-1 mark")?.textContent === "😀",
      );
      await page.keyboard.press("Escape");
      await page.locator("mark.search-match").waitFor({ state: "detached" });
      assert.equal(await page.locator("mark.search-match").count(), 0);
      assert.equal(await page.locator("#entry-1 .text").textContent(), content);
    },
  );

  await suite.test(
    "Elm caret events preserve a Unicode suffix and CSS sizes the composer",
    async (t) => {
      const { page, url } = await fixture(t, browser, 390, 844);
      await deferDomFrames(page);
      await page.goto(new URL("sessions/alpha/conversations/1", url).href);
      await connected(page);
      const prompt = page.locator("#prompt");
      await prompt.fill("/co😀é");
      await prompt.evaluate((node: HTMLTextAreaElement) => {
        node.setSelectionRange(3, 3);
        node.dispatchEvent(new Event("select", { bubbles: true }));
      });
      await page.locator("#completions:not([hidden])").waitFor();
      await prompt.press("Tab");
      assert.equal(await prompt.inputValue(), "/compact 😀é");
      await page.waitForFunction(() => {
        const node = document.querySelector<HTMLTextAreaElement>("#prompt");
        return node?.selectionStart === 9 && node.selectionEnd === 9;
      });
      assert.equal(await prompt.evaluate((node: HTMLTextAreaElement) => node.selectionStart), 9);
      const short = await prompt.evaluate((node) => node.getBoundingClientRect().height);
      await prompt.fill("line\n".repeat(15));
      assert(await prompt.evaluate((node) => node.getBoundingClientRect().height > 100));
      await prompt.fill("short");
      assert.equal(await prompt.evaluate((node) => node.getBoundingClientRect().height), short);
      await prompt.press("Control+k");
      await page.locator("#session-list").waitFor();
    },
  );
  await suite.test(
    "Elm follows layout changes only while pinned to the latest message",
    async (t) => {
      const { page, url, state, emit } = await fixture(t, browser, 390, 844);
      state.snapshot.view.entries = Array.from({ length: 30 }, (_, index) =>
        entry(index + 1, user("Long message\n".repeat(5))),
      );
      await deferDomFrames(page);
      await page.goto(new URL("sessions/alpha/conversations/1", url).href);
      const pinned = () =>
        page.waitForFunction(() => {
          const node = document.querySelector("#conversation-scroll");
          return node && Math.abs(node.scrollHeight - node.clientHeight - node.scrollTop) < 1;
        });
      await connected(page);
      await pinned();
      await page.locator("#prompt").evaluate((node: HTMLTextAreaElement) => {
        node.focus();
        node.value = "line\n".repeat(15);
        node.dispatchEvent(new Event("input", { bubbles: true }));
        // A queued scroll notification can arrive after field-sizing changes
        // the viewport, without the user moving the scroll position.
        document.querySelector("#conversation-scroll")?.dispatchEvent(new Event("scroll"));
      });
      await pinned();
      emit([["p", ["view", "entries"], 30, 0, [entry(31, assistant("New output\n".repeat(10)))]]]);
      await page.locator("#entry-31").waitFor({ state: "attached" });
      await pinned();
      await page.locator("#conversation-scroll").evaluate((node) => {
        node.scrollTop = 0;
      });
      await painted(page);
      emit([["p", ["view", "entries"], 31, 0, [entry(32, assistant("More output"))]]]);
      await page.locator("#entry-32").waitFor({ state: "attached" });
      await page.setViewportSize({ width: 390, height: 650 });
      await painted(page);
      assert.equal(
        await page.locator("#conversation-scroll").evaluate((node) => node.scrollTop),
        0,
      );
      await page.getByRole("button", { name: "Latest", exact: true }).click();
      await pinned();
      await page.setViewportSize({ width: 390, height: 500 });
      await pinned();
    },
  );
});
