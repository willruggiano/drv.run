// Renderer-only benchmark: no SSE delivery, asset loading or completed paint in
// the timer. Run with --help for CLI usage. Stdout is one versioned JSON object.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { availableParallelism, cpus, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  ROOT_CONVERSATION_ID,
  type EntryRecord,
  type LiveState,
  type TaskId,
} from "@earendil-works/pi-durable";
import { chromium, type CDPSession, type Page } from "playwright";
import { Sessions, type Snapshot } from "../pi-runtime/index.ts";
import { httpServer } from "./server.ts";
import { buildAssets } from "./build.ts";

const usage = `Usage: node packages/pi-serve/benchmark.ts [options]
  --runs N       Fresh browser launches (default 3, maximum 100)
  --turns N      History turns, each with a user, assistant and tool result (default 200)
  --cpu-rate N   Chromium CPU slowdown factor, >= 1 (default 1)
  --profile      Extra fresh-browser run with CPU profiles and browser traces
  --profile-dir DIR
                 Parent directory for unique artifact folder (default cwd; requires --profile)
  --assets DIR   Frontend sources or compiled assets (default: alongside this script)
  --chromium FILE
                 Chromium executable (otherwise PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH or PATH)
  --help         Show this help on stderr
Outputs one JSON object with raw millisecond samples, workload and environment.
Each run measures initial history, 40 streaming updates and 10 busy/idle transitions.
Timing runs never enable instrumentation. --profile adds a separate diagnostic run,
saving per-phase .cpuprofile and .trace.json files with paths in the JSON report.
Traces include style invalidations and paint; profiled timings are not benchmark samples.
Mobile layout emulation is not phone hardware emulation.`;

export function benchmarkOptions(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
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
    runs: number(values.runs, "--runs", 100),
    turns: number(values.turns, "--turns", 10_000),
    cpuRate: number(values["cpu-rate"], "--cpu-rate", 100, false),
    profile: values.profile,
    profileDir: resolve(values["profile-dir"] ?? "."),
    assets: resolve(values.assets ?? dirname(fileURLToPath(import.meta.url))),
    executablePath:
      values.chromium ??
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
      (process.env.PATH ?? "")
        .split(delimiter)
        .map((path) => join(path, "chromium"))
        .find(existsSync),
    help: values.help,
  };
}

const timestamp = 1_700_000_000_000;
const streamUpdates = 40;
const transitions = 10;

export function benchmarkFixture(turns: number): Snapshot {
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
    view: { conversation: { id: ROOT_CONVERSATION_ID }, entries, docs: { "pi.live": {} } },
  };
}

declare global {
  interface Window {
    __piBenchmarkRender(snapshot: string): number;
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

export async function benchmark(options: ReturnType<typeof benchmarkOptions>) {
  assert(
    options.executablePath,
    "Chromium is required; set --chromium or use nix run .#pi-serve.bench.render",
  );
  const directory = await mkdtemp(join(tmpdir(), "pi-serve-bench-"));
  let sessions: Sessions | undefined;
  let server: ReturnType<typeof httpServer> | undefined;
  try {
    if (existsSync(join(options.assets, "client.ts"))) await buildAssets(options.assets, directory);
    else
      for (const file of ["client.js", "highlight.js", "index.html", "styles.css"])
        await copyFile(join(options.assets, file), join(directory, file));
    const client = await readFile(join(directory, "client.js"), "utf8");
    const html = await readFile(join(directory, "index.html"), "utf8");
    const css = await readFile(join(directory, "styles.css"), "utf8");
    const highlighter = await readFile(join(directory, "highlight.js"), "utf8");
    const hash = (text: string) => createHash("sha256").update(text).digest("hex");
    // A real, empty runtime serves the app/catalog/highlighter. No provider,
    // credentials, sessions or tools are used by this synthetic workload.
    sessions = await Sessions.open({
      directory: join(directory, "state"),
      models: createModels(),
      integrations: [],
    });
    server = httpServer(sessions, "127.0.0.1", directory);
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
      profile.directory = await mkdtemp(join(options.profileDir, "pi-serve-profile-"));
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
        await page.goto(base);
        // Import the public renderer export, not private names that minifiers
        // can rename. The timed code uses the exact served production module.
        // The literal browser import avoids tsc adding a Node-side import
        // rewriting helper to a function that Playwright serializes.
        const frontend = await page.evaluateHandle<{ render: (snapshot: Snapshot) => void }>(
          "import('/client.js')",
        );
        await page.evaluate(({ render }) => {
          const transcript = document.getElementById("transcript");
          if (!transcript) throw new Error("Missing transcript");
          window.__piBenchmarkRender = (snapshot) => {
            const start = performance.now();
            render(JSON.parse(snapshot) as Snapshot);
            transcript.getBoundingClientRect();
            return performance.now() - start;
          };
        }, frontend);
        await frontend.dispose();
        await page.locator("#close-picker").click();
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
      benchmark: "pi-serve.render",
      units: "ms",
      measurement: {
        includes: ["json-parse", "render", "synchronous-layout"],
        excludes: ["asset-loading", "network", "sse-dispatch", "completed-paint"],
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
        htmlSha256: hash(html),
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
