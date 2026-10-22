// Renderer-only by default; --frontend measures real page and SSE delivery.
// Run with --help for CLI usage. Stdout is one versioned JSON object.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo, Socket } from "node:net";
import { availableParallelism, cpus, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  ROOT_CONVERSATION_ID,
  LiveDoc,
  type EntryRecord,
  type LiveState,
  type TaskId,
} from "@earendil-works/pi-durable";
import type { CDPSession, Page } from "playwright";
import { conversationURL } from "./hypermedia.ts";
import { Sessions } from "./sessions.ts";
import type { RenderState } from "./client.ts";
import { httpServer } from "./server.ts";
import { buildAssets } from "./build.ts";

const usage = `Usage: node packages/app/serve/benchmark.ts [options]
  --frontend original|hypermedia
                 Measure real page/SSE delivery (default: original renderer only)
  --runs N       Fresh browser launches (default 3, maximum 100)
  --turns N      History turns, each with a user, assistant and tool result (default 200)
  --cpu-rate N   Chromium CPU slowdown factor, >= 1 (default 1)
  --profile      Extra fresh-browser run with CPU profiles and browser traces
  --profile-dir DIR
                 Parent directory for unique artifact folder (default cwd; requires --profile)
  --assets DIR   Frontend sources or compiled assets (default: alongside this script)
  --chromium FILE
                 Chromium executable (otherwise found on PATH)
  --help         Show this help on stderr
Outputs one JSON object with raw millisecond samples, workload and environment.
Each run measures initial history, 40 streaming updates and 10 busy/idle transitions.
Page mode includes HTTP delivery, commit and browser-control transport; byte counts
include all HTTP response headers, bodies and chunk framing, not TCP/IP overhead.
Timing runs never enable CPU profiling or traces. --profile adds a separate diagnostic run,
saving per-phase .cpuprofile and .trace.json files with paths in the JSON report.
Traces include style invalidations and paint; profiled timings are not benchmark samples.
Mobile layout emulation is not phone hardware emulation.`;

export function benchmarkOptions(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      frontend: { type: "string" },
      runs: { type: "string", default: "3" },
      turns: { type: "string", default: "200" },
      "cpu-rate": { type: "string", default: "1" },
      profile: { type: "boolean", default: false },
      "profile-dir": { type: "string" },
      assets: { type: "string" },
      chromium: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  const frontend = values.frontend;
  assert(
    frontend === undefined || frontend === "original" || frontend === "hypermedia",
    "--frontend must be original or hypermedia",
  );
  assert(values.profile || values["profile-dir"] === undefined, "--profile-dir requires --profile");
  const number = (value: string, name: string, max: number, integer = true) => {
    const result = Number(value);
    assert(
      Number.isFinite(result) &&
        result >= 1 &&
        result <= max &&
        (!integer || Number.isInteger(result)),
      `${name} must be ${integer ? "an integer" : "a number"} between 1 and ${max}`,
    );
    return result;
  };
  return {
    frontend,
    runs: number(values.runs, "--runs", 100),
    turns: number(values.turns, "--turns", 10_000),
    cpuRate: number(values["cpu-rate"], "--cpu-rate", 100, false),
    profile: values.profile,
    profileDir: resolve(values["profile-dir"] ?? "."),
    assets: resolve(values.assets ?? dirname(fileURLToPath(import.meta.url))),
    executablePath:
      values.chromium ??
      (process.env.PATH ?? "")
        .split(delimiter)
        .map((path) => join(path, "chromium"))
        .find(existsSync),
    help: values.help,
  } as const;
}

const timestamp = 1_700_000_000_000;
const streamUpdates = 40;
const transitions = 10;

export function benchmarkFixture(turns: number): RenderState {
  const entries: EntryRecord[] = [];
  for (let i = 0; i < turns; i++) {
    entries.push(
      {
        id: (3 * i + 1) as EntryRecord["id"],
        conversationId: ROOT_CONVERSATION_ID,
        kind: "message",
        model: [{ role: "user", content: `Inspect module ${i}`, timestamp }],
      },
      {
        id: (3 * i + 2) as EntryRecord["id"],
        conversationId: ROOT_CONVERSATION_ID,
        kind: "message",
        model: [
          fauxAssistantMessage(
            [
              { type: "text", text: "Checking the module and its test results." },
              fauxToolCall("bash", { command: `npm test -- module${i}` }, { id: `call${i}` }),
            ],
            { timestamp: timestamp + 1, stopReason: "toolUse" },
          ),
        ],
      },
      {
        id: (3 * i + 3) as EntryRecord["id"],
        conversationId: ROOT_CONVERSATION_ID,
        kind: "message",
        model: [
          {
            role: "toolResult",
            toolCallId: `call${i}`,
            toolName: "bash",
            content: [{ type: "text", text: "Test passed\n".repeat(100) }],
            details: {
              exitCode: 0,
              tests: Array.from({ length: 20 }, (_, j) => ({ name: `case${j}`, passed: true })),
            },
            isError: false,
            timestamp: timestamp + 2,
          },
        ],
      },
    );
  }
  return {
    session: {
      id: "benchmark",
      name: "Profile",
      binding: { provider: "local", target: "local", cwd: "/tmp" },
      cwd: "/tmp",
      created: timestamp,
      model: { provider: "faux", modelId: "faux-1" },
      thinkingLevel: "off",
      needsResume: false,
    },
    context: { window: 200_000, autoCompact: true, lastResponse: null },
    inspection: { state: "unavailable", conversation: ROOT_CONVERSATION_ID },
    view: { conversation: { id: ROOT_CONVERSATION_ID }, entries, docs: { "pi.live": {} } },
  };
}

declare global {
  interface Window {
    __piBenchmarkRender(snapshot: string): number;
    __piBenchmarkCommit(live: LiveState): Promise<void>;
    __piBenchmarkObserve(expected: { text?: string; busy?: boolean }): Promise<number>;
    __piBenchmarkComplete: Promise<number>;
    __piBenchmarkStreamReady: boolean;
  }
}

type ProfilePhase = "initial" | "streaming" | "transitions";
type ProfileArtifact = {
  phase: ProfilePhase;
  cpuProfile: string;
  trace: string;
  traceDataLoss: boolean;
};
const traceCategories = [
  "devtools.timeline",
  "v8.execute",
  "blink.user_timing",
  "disabled-by-default-devtools.timeline.invalidationTracking",
];
const samplingIntervalUs = 1000;

async function profilePhase<T>(
  cdp: CDPSession,
  page: Page,
  directory: string,
  phase: ProfilePhase,
  action: () => Promise<T>,
): Promise<{ value: T; artifact: ProfileArtifact }> {
  await cdp.send("Profiler.start");
  await cdp.send("Tracing.start", {
    categories: traceCategories.join(","),
    options: "record-as-much-as-possible",
    transferMode: "ReturnAsStream",
    streamFormat: "json",
    streamCompression: "none",
  });
  await page.evaluate((phase) => performance.mark(`pi-bench:${phase}:start`), phase);
  const value = await action();
  // Diagnostic traces include the resulting paint, unlike the synchronous
  // benchmark timer. These waits and profiler overhead never enter runs[].
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await page.evaluate((phase) => performance.mark(`pi-bench:${phase}:end`), phase);
  const { profile } = await cdp.send("Profiler.stop");
  const completed = Promise.withResolvers<{ stream?: string; dataLossOccurred: boolean }>();
  const onComplete = (event: { stream?: string; dataLossOccurred: boolean }) =>
    completed.resolve(event);
  cdp.once("Tracing.tracingComplete", onComplete);
  const timeout = setTimeout(() => completed.reject(new Error("Trace flush timed out")), 30_000);
  try {
    const [result] = await Promise.all([completed.promise, cdp.send("Tracing.end")]);
    assert(result.stream, "Chromium did not return a trace stream");
    const artifact = {
      phase,
      cpuProfile: join(directory, `${phase}.cpuprofile`),
      trace: join(directory, `${phase}.trace.json`),
      traceDataLoss: result.dataLossOccurred,
    };
    try {
      await writeFile(artifact.cpuProfile, JSON.stringify(profile), { flag: "wx" });
      const file = await open(artifact.trace, "wx");
      try {
        // Stream large invalidation traces to disk instead of retaining them
        // in Node's heap or embedding them in the stdout report.
        for (;;) {
          const chunk = await cdp.send("IO.read", { handle: result.stream, size: 64 * 1024 });
          await file.writeFile(Buffer.from(chunk.data, chunk.base64Encoded ? "base64" : "utf8"));
          if (chunk.eof) break;
        }
      } finally {
        await file.close();
      }
    } finally {
      await cdp.send("IO.close", { handle: result.stream });
    }
    return { value, artifact };
  } finally {
    clearTimeout(timeout);
    cdp.off("Tracing.tracingComplete", onComplete);
  }
}

// Use the actual HTTP handlers and browser event stream. Durable commits supply
// deterministic observations without starting a provider or changing its semantics.
async function pageWorkload(
  page: Page,
  cdp: CDPSession,
  sessions: Sessions,
  base: string,
  frontend: "original" | "hypermedia",
  turns: number,
  bytesWritten: () => number,
  stage: <T>(phase: ProfilePhase, action: () => Promise<T>) => Promise<T>,
) {
  const session = await sessions.create(randomUUID());
  const context = BACKGROUND_CONTEXT;
  await session.root.commit(async (tx) => {
    for (const { kind, model } of benchmarkFixture(turns).view.entries)
      await tx.appendEntry(session.root.id, { kind, model });
  }, context);
  await page.exposeFunction("__piBenchmarkCommit", (value: LiveState) =>
    session.root.commit(async (tx) => {
      const live = await tx.doc(LiveDoc, session.root.id);
      delete live.run;
      delete live.generation;
      Object.assign(live, value);
    }, context),
  );
  await page.addInitScript(
    ({ frontend, turns }) => {
      window.__piBenchmarkObserve = (expected) =>
        new Promise<number>((resolve, reject) => {
          const start = expected.busy === undefined ? 0 : performance.now();
          const check = () => {
            const transcript = document.querySelector("#transcript");
            if (!transcript) return;
            if (expected.busy === undefined) {
              if (
                transcript.querySelectorAll("article").length !==
                  turns * (frontend === "original" ? 2 : 3) ||
                transcript.querySelectorAll(".tool-call").length !== turns
              )
                return;
            } else {
              const status = document.querySelector(
                frontend === "original" ? "#status" : "#controls",
              );
              if (status?.getAttribute("data-state") !== (expected.busy ? "working" : "ready"))
                return;
              if (
                expected.text !== undefined &&
                document
                  .querySelector(
                    frontend === "original"
                      ? "#transcript > article:last-child .text"
                      : "#live .text",
                  )
                  ?.textContent?.trimEnd() !== expected.text.trimEnd()
              )
                return;
            }
            transcript.getBoundingClientRect();
            observer.disconnect();
            clearTimeout(timeout);
            resolve(performance.now() - start);
          };
          const observer = new MutationObserver(check);
          const timeout = setTimeout(() => {
            observer.disconnect();
            reject(
              new Error(
                `Page benchmark timed out: ${JSON.stringify({
                  expected,
                  articles: document.querySelectorAll("#transcript article").length,
                  tools: document.querySelectorAll("#transcript .tool-call").length,
                  status: document.querySelector("#status")?.getAttribute("data-state"),
                  text: document.querySelector("#transcript > article:last-child .text")
                    ?.textContent,
                })}`,
              ),
            );
          }, 30_000);
          observer.observe(document, {
            subtree: true,
            childList: true,
            characterData: true,
            attributes: true,
          });
          check();
        });
      window.__piBenchmarkComplete = window.__piBenchmarkObserve({});
      window.__piBenchmarkStreamReady = false;
      document.addEventListener(
        "htmx:sse:after:message",
        () => {
          window.__piBenchmarkStreamReady = true;
        },
        { once: true },
      );
    },
    { frontend, turns },
  );
  const firstFrame = Promise.withResolvers<void>();
  let streamRequest: string | undefined;
  const requested = (event: { requestId: string; request: { url: string } }) => {
    const path = new URL(event.request.url).pathname;
    if (
      path ===
      (frontend === "original"
        ? `/api/harness/${session.id}/watch`
        : `${conversationURL(session)}/events`)
    )
      streamRequest = event.requestId;
  };
  const received = (event: { requestId: string }) => {
    if (event.requestId === streamRequest) firstFrame.resolve();
  };
  // Observe initial delivery only. Disable network telemetry before token timing.
  if (frontend === "original") await cdp.send("Network.enable");
  cdp.on("Network.requestWillBeSent", requested);
  cdp.on("Network.eventSourceMessageReceived", received);
  const initialBefore = bytesWritten();
  const initialMs = await stage("initial", async () => {
    const timeout = setTimeout(() => {
      if (frontend === "original") firstFrame.reject(new Error("Initial SSE frame timed out"));
    }, 30_000);
    try {
      await Promise.all([
        page.goto(
          base + (frontend === "original" ? `/?session=${session.id}` : conversationURL(session)),
        ),
        frontend === "original" ? firstFrame.promise : Promise.resolve(),
      ]);
      if (frontend === "hypermedia")
        await page.waitForFunction(() => window.__piBenchmarkStreamReady);
      const elapsed = await page.evaluate(() => window.__piBenchmarkComplete);
      // Drain the initial event handler and resulting layout before token timing.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      return elapsed;
    } finally {
      clearTimeout(timeout);
      cdp.off("Network.requestWillBeSent", requested);
      cdp.off("Network.eventSourceMessageReceived", received);
      if (frontend === "original") await cdp.send("Network.disable");
    }
  });
  const initialBytes = bytesWritten() - initialBefore;
  const initialDomElements = await page.locator("#transcript *").count();
  const assistant = fauxAssistantMessage("", { timestamp: timestamp + 3 });
  const partial = {
    role: assistant.role,
    content: [{ type: "text" as const, text: "" }],
    api: assistant.api,
    provider: assistant.provider,
    model: assistant.model,
    usage: assistant.usage,
    stopReason: assistant.stopReason,
    timestamp: assistant.timestamp,
  };
  const run = { taskId: 1 as TaskId, inputs: [] };
  const measure = async (live: LiveState, text?: string) => {
    const before = bytesWritten();
    const ms = await page.evaluate(
      async ({ data, text }) => {
        const live = JSON.parse(data) as LiveState;
        const completed = window.__piBenchmarkObserve({ busy: !!live.run, text });
        await window.__piBenchmarkCommit(live);
        return completed;
      },
      { data: JSON.stringify(live), text },
    );
    return { ms, bytes: bytesWritten() - before };
  };
  const { startMs, startBytes, streamingMs, streamingBytes } = await stage(
    "streaming",
    async () => {
      const live: LiveState = { run, generation: { attempt: 1, message: partial } };
      const start = await measure(live);
      const streamingMs: number[] = [],
        streamingBytes: number[] = [];
      for (let update = 1; update <= streamUpdates; update++) {
        partial.content[0].text = "An incremental update. ".repeat(update);
        const sample = await measure(live, partial.content[0].text);
        streamingMs.push(sample.ms);
        streamingBytes.push(sample.bytes);
      }
      return { startMs: start.ms, startBytes: start.bytes, streamingMs, streamingBytes };
    },
  );
  const { transitionsMs, transitionsBytes } = await stage("transitions", async () => {
    const transitionsMs: number[] = [],
      transitionsBytes: number[] = [];
    for (let transition = 0; transition < transitions; transition++) {
      const sample = await measure(transition % 2 ? { run } : {});
      transitionsMs.push(sample.ms);
      transitionsBytes.push(sample.bytes);
    }
    return { transitionsMs, transitionsBytes };
  });
  return {
    initialMs,
    initialBytes,
    initialDomElements,
    startMs,
    startBytes,
    streamingMs,
    streamingBytes,
    transitionsMs,
    transitionsBytes,
  };
}

export async function benchmark(options: ReturnType<typeof benchmarkOptions>) {
  const { chromium } = await import("playwright");
  assert(
    options.executablePath,
    "Chromium is required; set --chromium or use nix run .#app.bench.render",
  );
  const directory = await mkdtemp(join(tmpdir(), "serve-bench-"));
  let sessions: Sessions | undefined;
  let server: ReturnType<typeof httpServer> | undefined;
  try {
    if (existsSync(join(options.assets, "client.ts"))) await buildAssets(options.assets, directory);
    else
      for (const file of [
        "client.js",
        "highlight.js",
        "index.html",
        "styles.css",
        "hypermedia-client.js",
        "hypermedia.css",
        "htmx.js",
        "hx-sse.js",
        "hypermedia-morph.js",
      ])
        await copyFile(join(options.assets, file), join(directory, file));
    const client = await readFile(
      join(directory, options.frontend === "hypermedia" ? "hypermedia-client.js" : "client.js"),
      "utf8",
    );
    const html = await readFile(join(directory, "index.html"), "utf8");
    const css = await readFile(join(directory, "styles.css"), "utf8");
    const highlighter = await readFile(join(directory, "highlight.js"), "utf8");
    const hash = (text: string) => createHash("sha256").update(text).digest("hex");
    // No provider, credentials or tools. Page mode commits the synthetic
    // history/live documents; renderer-only mode needs only the asset server.
    sessions = await Sessions.open({
      directory: join(directory, "state"),
      models: createModels(),
    });
    server = httpServer(sessions, "127.0.0.1", directory);
    const sockets: Socket[] = [];
    server.on("connection", (socket) => sockets.push(socket));
    const bytesWritten = () => sockets.reduce((sum, socket) => sum + socket.bytesWritten, 0);
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", resolve);
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const viewport = { width: 390, height: 844 };
    const runs: {
      run: number;
      initialMs: number;
      initialDomElements: number;
      startMs: number;
      streamingMs: number[];
      transitionsMs: number[];
      initialBytes?: number;
      startBytes?: number;
      streamingBytes?: number[];
      transitionsBytes?: number[];
    }[] = [];
    const profile = options.profile
      ? {
          separateRun: true,
          timingsIncludedInRuns: false,
          includesPaint: true,
          samplingIntervalUs,
          traceCategories,
          directory: "",
          artifacts: [] as ProfileArtifact[],
        }
      : null;
    if (profile) {
      await mkdir(options.profileDir, { recursive: true });
      profile.directory = await mkdtemp(join(options.profileDir, "serve-profile-"));
    }
    let browserVersion = "";
    for (let run = 1; run <= options.runs + (profile ? 1 : 0); run++) {
      const profiling = run > options.runs;
      const browser = await chromium.launch({ executablePath: options.executablePath });
      try {
        browserVersion = browser.version();
        const page = await browser.newPage({
          viewport,
          isMobile: true,
          hasTouch: true,
          locale: "en-US",
          timezoneId: "UTC",
          serviceWorkers: "block",
        });
        page.setDefaultTimeout(30_000);
        const errors: Error[] = [];
        page.on("pageerror", (error) => errors.push(error));
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: options.cpuRate });
        if (profiling) {
          await cdp.send("Profiler.enable");
          await cdp.send("Profiler.setSamplingInterval", { interval: samplingIntervalUs });
        }
        const stage = async <T>(phase: ProfilePhase, action: () => Promise<T>): Promise<T> => {
          if (!profiling || !profile) return action();
          const result = await profilePhase(cdp, page, profile.directory, phase, action);
          profile.artifacts.push(result.artifact);
          return result.value;
        };
        if (options.frontend) {
          const sample = await pageWorkload(
            page,
            cdp,
            sessions,
            base,
            options.frontend,
            options.turns,
            bytesWritten,
            stage,
          );
          assert.deepEqual(errors, []);
          if (!profiling) runs.push({ run, ...sample });
          continue;
        }
        await page.goto(base);
        // Let the ordinary catalog initialization finish before showing the synthetic surface.
        await page.waitForFunction(
          () => document.querySelector("#models")?.childElementCount === 1,
        );
        // Import the public renderer export, not private names that minifiers
        // can rename. The timed code uses the exact served production module.
        // The literal browser import avoids tsc adding a Node-side import
        // rewriting helper to a function that Playwright serializes.
        const frontend = await page.evaluateHandle<{ render: (snapshot: RenderState) => void }>(
          "import('/client.js')",
        );
        await page.evaluate(({ render }) => {
          const transcript = document.getElementById("transcript");
          if (!transcript) throw new Error("Missing transcript");
          // This synthetic workload has no selected session. Show its render
          // surface explicitly instead of benchmarking the hidden transcript.
          const landing = document.getElementById("landing");
          if (!landing) throw new Error("Missing landing page");
          landing.hidden = true;
          transcript.hidden = false;
          window.__piBenchmarkRender = (snapshot) => {
            const start = performance.now();
            render(JSON.parse(snapshot) as RenderState);
            transcript.getBoundingClientRect();
            return performance.now() - start;
          };
        }, frontend);
        await frontend.dispose();
        assert.equal(await page.locator("#transcript").isVisible(), true);
        const snapshot = benchmarkFixture(options.turns);
        // Serialization and Playwright's transport are outside the browser timer.
        const measure = () =>
          page.evaluate((data) => window.__piBenchmarkRender(data), JSON.stringify(snapshot));
        const initialMs = await stage("initial", measure);
        assert.equal(await page.locator("#transcript > article").count(), options.turns * 2);
        assert.equal(await page.locator(".tool-call").count(), options.turns);
        const initialDomElements = await page.locator("#transcript *").count();
        const assistant = fauxAssistantMessage("", { timestamp: timestamp + 3 });
        const partial = {
          role: assistant.role,
          content: [{ type: "text" as const, text: "" }],
          api: assistant.api,
          provider: assistant.provider,
          model: assistant.model,
          usage: assistant.usage,
          stopReason: assistant.stopReason,
          timestamp: assistant.timestamp,
        };
        const runState = { taskId: 1 as TaskId, inputs: [] };
        const live: LiveState = {
          run: runState,
          generation: { attempt: 1, message: partial },
        };
        snapshot.view = { ...snapshot.view, entries: [], docs: { "pi.live": live } };
        const { startMs, streamingMs } = await stage("streaming", async () => {
          const startMs = await measure();
          const streamingMs: number[] = [];
          for (let update = 1; update <= streamUpdates; update++) {
            partial.content[0].text = "An incremental update. ".repeat(update);
            streamingMs.push(await measure());
          }
          return { startMs, streamingMs };
        });
        const transitionsMs = await stage("transitions", async () => {
          const timings: number[] = [];
          for (let transition = 0; transition < transitions; transition++) {
            snapshot.view = {
              ...snapshot.view,
              docs: { "pi.live": transition % 2 ? { run: runState } : {} },
            };
            timings.push(await measure());
          }
          return timings;
        });
        assert.deepEqual(errors, []);
        if (!profiling)
          runs.push({ run, initialMs, initialDomElements, startMs, streamingMs, transitionsMs });
      } finally {
        await browser.close();
      }
    }
    return {
      schemaVersion: 1,
      benchmark: "serve.render",
      frontend: options.frontend ?? "renderer",
      units: "ms",
      measurement: {
        includes: options.frontend
          ? [
              "page-loading",
              "commit",
              "http",
              "sse-dispatch",
              "render",
              "synchronous-layout",
              "browser-control-transport",
            ]
          : ["json-parse", "render", "synchronous-layout"],
        excludes: options.frontend
          ? ["completed-paint"]
          : ["asset-loading", "network", "sse-dispatch", "completed-paint"],
        bytes: options.frontend
          ? "HTTP response headers, bodies and chunk framing; excludes TCP/IP overhead"
          : null,
        profiling: false,
        freshBrowserPerRun: true,
      },
      environment: {
        node: process.version,
        chromium: browserVersion,
        platform: process.platform,
        arch: process.arch,
        cpu: cpus()[0]?.model ?? "unknown",
        availableParallelism: availableParallelism(),
        cpuRate: options.cpuRate,
        viewport,
        mobile: true,
        headless: true,
        locale: "en-US",
        timezone: "UTC",
      },
      source: {
        clientSha256: hash(client),
        cssSha256: hash(css),
        htmlSha256: options.frontend === "hypermedia" ? null : hash(html),
        htmxSha256:
          options.frontend === "hypermedia"
            ? hash(await readFile(join(directory, "htmx.js"), "utf8"))
            : null,
        hypermediaCssSha256:
          options.frontend === "hypermedia"
            ? hash(await readFile(join(directory, "hypermedia.css"), "utf8"))
            : null,
        highlighterSha256: hash(highlighter),
      },
      workload: {
        version: 1,
        turns: options.turns,
        entries: options.turns * 3,
        toolOutputLines: 100,
        metadataTests: 20,
        streamUpdates,
        transitions,
      },
      runs,
      profile,
    };
  } finally {
    try {
      if (server?.listening) {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server!.close((error) => (error ? reject(error) : resolve())),
        );
      }
    } finally {
      try {
        await sessions?.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = benchmarkOptions(process.argv.slice(2));
    if (options.help) console.error(usage);
    else console.log(JSON.stringify(await benchmark(options)));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
