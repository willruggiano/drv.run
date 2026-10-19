import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { fixture, model, waitFor } from "../pi-runtime/testing.ts";
import { browserFlow, serve, snapshot, post } from "./testing.ts";
import { GlobalSettingsStore, parseOptions } from "./server.ts";
import { benchmark, benchmarkFixture, benchmarkOptions } from "./benchmark.ts";
import { buildAssets } from "./build.ts";

import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { Sessions } from "../pi-runtime/index.ts";
import { chromium } from "playwright";
import type { GlobalSettings } from "./settings.ts";

const context = BACKGROUND_CONTEXT;

await test("CLI starts standalone without host commands and loads only explicit integrations", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-serve-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const module = join(directory, "example.mjs");
  const target = {
    provider: "example",
    target: "test",
    cwd: "/work",
    label: "Example",
    available: true,
  };
  await writeFile(
    module,
    `export default () => ({
    id: "example",
    targets: async () => [${JSON.stringify(target)}],
    validate: async () => {},
    open: () => { throw new Error("Not used"); },
  });`,
  );
  for (const extensions of [[], ["--no-local", "--extension", module]]) {
    const reservation = createServer();
    await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const port = (reservation.address() as AddressInfo).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("./server.ts", import.meta.url)),
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--state",
        join(directory, "state"),
        "--cwd",
        directory,
        ...extensions,
      ],
      {
        env: {
          ...process.env,
          PATH: "",
          PI_OFFLINE: "1",
          PI_CODING_AGENT_DIR: join(directory, "agent"),
        },
        stdio: "ignore",
      },
    );
    const ended = once(child, "exit");
    try {
      const url = `http://127.0.0.1:${port}/api/catalog`;
      await waitFor(async () => {
        assert.equal(child.exitCode, null);
        try {
          return (await fetch(url)).ok;
        } catch {
          return false;
        }
      });
      const catalog = await (await fetch(url)).json();
      assert.deepEqual(catalog.sessions, []);
      assert.deepEqual(
        catalog.targets,
        extensions.length
          ? [target]
          : [
              {
                provider: "local",
                target: directory,
                cwd: directory,
                label: `Local · ${directory}`,
                available: true,
              },
            ],
      );
    } finally {
      child.kill("SIGTERM");
      const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
      try {
        assert.deepEqual(await ended, [0, null]);
      } finally {
        clearTimeout(timeout);
      }
    }
  }
});

await test("HTTP disconnect does not abort work; reconnect includes history and deduplicates prompts", async (t) => {
  const f = await fixture(t);
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  f.faux.setResponses([
    async () => {
      started.resolve();
      await finish.promise;
      return fauxAssistantMessage("Done.");
    },
  ]);
  t.after(() => finish.resolve());
  const base = await serve(t, f.sessions);
  const id = randomUUID();
  assert.equal((await post(base + "/api/sessions", { id, binding: f.binding, model })).status, 201);
  const url = `${base}/api/sessions/${id}`;
  const data = { text: "Work", requestId: randomUUID() };
  assert.equal((await post(url + "/prompt", data)).status, 200);
  await started.promise;
  assert.equal((await snapshot(url + "/events")).session.id, id);
  assert.equal((await post(url + "/prompt", data)).status, 200);
  finish.resolve();
  const session = await f.sessions.get(id);
  await session.root.waitForIdle(context);
  const reconnected = await snapshot(url + "/events");
  assert.equal(
    reconnected.history
      ?.flatMap((entry) => entry.model ?? [])
      .filter((message) => message.role === "user").length,
    1,
  );
  assert.equal(f.faux.state.callCount, 1);
  assert.equal((await session.harness.inspect(context)).tasks.length, 0);
});

await test("HTTP validates origins, IDs, methods, JSON and request size", async (t) => {
  const f = await fixture(t);
  const base = await serve(t, f.sessions);
  assert.equal(
    (await fetch(base + "/api/catalog", { headers: { Origin: "https://untrusted.example" } }))
      .status,
    403,
  );
  const rebinding = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(
      base + "/api/catalog",
      { headers: { Host: "untrusted.example" } },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    req.once("error", reject);
    req.end();
  });
  assert.equal(rebinding, 403);
  assert.equal(
    (await fetch(base + "/api/catalog", { headers: { "Sec-Fetch-Site": "cross-site" } })).status,
    403,
  );
  assert.equal((await fetch(base + "/api/catalog")).status, 200);
  assert.equal((await fetch(base + "/api/sessions/bad/events")).status, 404);
  assert.equal((await post(base + "/api/sessions", {})).status, 400);
  assert.equal(
    (
      await fetch(base + "/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      })
    ).status,
    400,
  );
  assert.equal((await post(base + "/api/sessions", { data: "a".repeat(129 * 1024) })).status, 413);
  const session = await f.sessions.create(randomUUID(), f.binding, model);
  assert.equal((await fetch(base + `/api/sessions/${session.id}/stop`)).status, 405);
  assert.equal((await fetch(base + "/manifest.webmanifest")).status, 200);
  const icon = await fetch(base + "/icon.svg");
  assert.equal(icon.status, 200);
  assert.equal((await f.sessions.catalog()).sessions.length, 1);
});

await test("wildcard binding accepts each destination but rejects spoofed hosts and cross-site requests", async (t) => {
  const f = await fixture(t);
  const base = await serve(t, f.sessions, undefined, "0.0.0.0");
  const port = new URL(base).port;
  for (const address of ["127.0.0.1", "127.0.0.2"]) {
    const url = `http://${address}:${port}/api/catalog`;
    assert.equal(
      (await fetch(url, { headers: { Origin: `http://${address}:${port}` } })).status,
      200,
    );
    assert.equal(
      (await fetch(url, { headers: { Origin: "https://untrusted.example" } })).status,
      403,
    );
    assert.equal((await fetch(url, { headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
    for (const host of [
      `untrusted.example:${port}`,
      `0.0.0.0:${port}`,
      `192.0.2.1:${port}`,
      `${address}:1`,
      `${address === "127.0.0.1" ? "127.0.0.2" : "127.0.0.1"}:${port}`,
    ]) {
      const code = await new Promise<number | undefined>((resolve, reject) => {
        const req = request(url, { headers: { Host: host } }, (response) => {
          response.resume();
          resolve(response.statusCode);
        });
        req.once("error", reject);
        req.end();
      });
      assert.equal(code, 403);
    }
  }
  assert.equal((await fetch(`http://localhost:${port}/api/catalog`)).status, 200);
});

await test("CLI defaults to local execution and accepts explicit integration composition", () => {
  const defaults = parseOptions([]);
  assert.equal(defaults.host, "0.0.0.0");
  assert.equal(defaults.port, 8080);
  assert.equal(defaults.local, true);
  assert.equal(defaults.cwd, process.cwd());
  assert.deepEqual(defaults.extensions, []);
  const custom = parseOptions([
    "--no-local",
    "--extension",
    "./provider.mjs",
    "--port",
    "9000",
    "--cwd",
    "/work",
    "--state",
    "/state",
  ]);
  assert.equal(custom.local, false);
  assert.deepEqual(custom.extensions, [resolve("provider.mjs")]);
  assert.equal(custom.cwd, "/work");
  assert.equal(custom.directory, "/state");
  assert.equal(custom.port, 9000);
  for (const args of [
    ["--no-local"],
    ["--port", "0"],
    ["--host", "::"],
    ["--cwd"],
    ["--unknown", "x"],
  ])
    assert.throws(() => parseOptions(args), Error);
});

await test("built highlighter preserves selected languages and is served as a static module", async (t) => {
  const assets = await mkdtemp(join(tmpdir(), "pi-serve-build-"));
  t.after(() => rm(assets, { recursive: true, force: true }));
  await buildAssets(dirname(fileURLToPath(import.meta.url)), assets);
  const { default: highlighter }: { default: typeof import("highlight.js") } = await import(
    pathToFileURL(join(assets, "highlight.js")).href
  );
  assert.deepEqual(highlighter.listLanguages().sort(), [
    "bash",
    "css",
    "diff",
    "go",
    "javascript",
    "json",
    "nix",
    "python",
    "rust",
    "sql",
    "typescript",
    "xml",
  ]);
  for (const [alias, name] of [
    ["js", "javascript"],
    ["ts", "typescript"],
    ["html", "xml"],
  ])
    assert.equal(highlighter.getLanguage(alias), highlighter.getLanguage(name));
  const f = await fixture(t);
  const base = await serve(t, f.sessions, assets);
  const response = await fetch(`${base}/highlight.js`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.deepEqual(
    Buffer.from(await response.arrayBuffer()),
    await readFile(join(assets, "highlight.js")),
  );
});

await test("renderer benchmark validates options and builds deterministic paired history", () => {
  const options = benchmarkOptions([]);
  assert.equal(options.runs, 3);
  assert.equal(options.turns, 200);
  assert.equal(options.cpuRate, 1);
  assert.equal(options.profile, false);
  assert.equal(benchmarkOptions(["--profile"]).profile, true);
  assert.equal(
    benchmarkOptions(["--profile", "--profile-dir", "profiles"]).profileDir,
    resolve("profiles"),
  );
  assert.equal(benchmarkOptions(["--cpu-rate", "2.5"]).cpuRate, 2.5);
  for (const args of [
    ["--runs", "0"],
    ["--runs", "1.5"],
    ["--runs", "101"],
    ["--turns", "-1"],
    ["--turns", "10001"],
    ["--turns", "NaN"],
    ["--cpu-rate", "0.5"],
    ["--cpu-rate", "Infinity"],
    ["--profile-dir", "profiles"],
    ["--profile", "--profile-dir"],
    ["--runs"],
    ["--unknown"],
    ["unexpected"],
  ])
    assert.throws(() => benchmarkOptions(args));
  const fixture = benchmarkFixture(2);
  assert.deepEqual(fixture, benchmarkFixture(2));
  assert.deepEqual(
    fixture.view.entries.map((entry) => entry.id),
    [1, 2, 3, 4, 5, 6],
  );
  for (let i = 0; i < 2; i++) {
    const assistant = fixture.view.entries[3 * i + 1].model?.[0];
    const result = fixture.view.entries[3 * i + 2].model?.[0];
    assert(assistant?.role === "assistant");
    assert(result?.role === "toolResult");
    const call = assistant.content.find((block) => block.type === "toolCall");
    assert(call);
    assert.equal(result.toolCallId, call.id);
  }
});

await test("mobile browser renderer benchmark returns complete JSON-compatible samples", async () => {
  const report = await benchmark(benchmarkOptions(["--runs", "2", "--turns", "2"]));
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.benchmark, "pi-serve.render");
  assert.equal(report.measurement.profiling, false);
  assert.equal(report.measurement.freshBrowserPerRun, true);
  assert.equal(report.workload.entries, 6);
  assert.equal(report.environment.cpuRate, 1);
  assert.equal(report.source.clientSha256.length, 64);
  assert.equal(report.runs.length, 2);
  assert.equal(report.profile, null);
  for (const run of report.runs) {
    assert(run.initialDomElements > 0);
    assert.equal(run.streamingMs.length, report.workload.streamUpdates);
    assert.equal(run.transitionsMs.length, report.workload.transitions);
    for (const value of [run.initialMs, run.startMs, ...run.streamingMs, ...run.transitionsMs])
      assert(Number.isFinite(value) && value >= 0);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
});

await test("mobile browser renderer profiling saves separate per-phase CPU and timeline data", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-serve-profile-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const report = await benchmark(
    benchmarkOptions(["--runs", "1", "--turns", "2", "--profile", "--profile-dir", directory]),
  );
  assert.equal(report.runs.length, 1);
  assert.equal(report.runs[0].streamingMs.length, 40);
  assert.equal(report.runs[0].transitionsMs.length, 10);
  assert.equal(report.measurement.profiling, false);
  assert(report.profile);
  assert.equal(report.profile.separateRun, true);
  assert.equal(report.profile.timingsIncludedInRuns, false);
  assert.equal(report.profile.includesPaint, true);
  assert.equal(report.profile.samplingIntervalUs, 1000);
  assert.deepEqual(
    report.profile.artifacts.map((artifact) => artifact.phase),
    ["initial", "streaming", "transitions"],
  );
  for (const artifact of report.profile.artifacts) {
    assert.equal(artifact.traceDataLoss, false);
    const cpu: {
      nodes: { id: number }[];
      samples: number[];
      timeDeltas: number[];
      startTime: number;
      endTime: number;
    } = JSON.parse(await readFile(artifact.cpuProfile, "utf8"));
    assert(cpu.endTime > cpu.startTime);
    assert(cpu.samples.length > 0);
    assert.equal(cpu.timeDeltas.length, cpu.samples.length);
    const ids = new Set(cpu.nodes.map((node) => node.id));
    assert(cpu.samples.every((id) => ids.has(id)));
    const trace: { traceEvents: { name: string }[] } = JSON.parse(
      await readFile(artifact.trace, "utf8"),
    );
    const events = new Set(trace.traceEvents.map((event) => event.name));
    assert(events.has(`pi-bench:${artifact.phase}:start`));
    assert(events.has(`pi-bench:${artifact.phase}:end`));
    if (artifact.phase === "initial") {
      assert(events.has("Layout"));
      assert(events.has("Paint"));
      assert(events.has("StyleRecalcInvalidationTracking"));
    }
  }
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
});

await test("mobile browser runs local tools, reconnects and renders untrusted content safely", async (t) => {
  const f = await fixture(t);
  await browserFlow(t, {
    ...f,
    extended: true,
    restart: async () => {
      await f.reopen();
      return f.sessions;
    },
  });
});

await test("conversation controls validate input and keep forks scoped to their session", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const base = await serve(t, f.sessions);
  const url = `${base}/api/sessions/${session.id}`;
  f.faux.setResponses([fauxAssistantMessage("A completed turn.")]);
  await session.prompt("Begin.", randomUUID());
  await session.root.waitForIdle(context);
  const history = await session.history();
  for (const [action, data] of [
    ["prompt", { text: "No", requestId: randomUUID(), mode: "invalid" }],
    [
      "prompt",
      { text: "No", requestId: randomUUID(), images: [{ mimeType: "text/html", data: "AAAA" }] },
    ],
    ["configure", { model, thinkingLevel: "invalid", instructions: "" }],
    [
      "configure",
      {
        model: { provider: "missing", modelId: "missing" },
        thinkingLevel: "off",
        instructions: "",
      },
    ],
    ["cancel", { id: "wrong" }],
    ["fork", { entry: -1 }],
  ] as const)
    assert.equal((await post(`${url}/${action}`, data)).status, 400);
  for (const name of [null, 123, "a".repeat(121), "line\nbreak"]) {
    assert.equal((await post(`${url}/rename`, { name })).status, 400);
  }
  const renamed = await post(`${url}/rename`, { name: "  Counter cleanup  " });
  assert.equal(renamed.status, 200);
  assert.equal((await renamed.json()).name, "Counter cleanup");
  assert.equal(
    (await (await fetch(base + "/api/catalog")).json()).sessions[0].name,
    "Counter cleanup",
  );
  assert.deepEqual(await session.history(), history);
  assert.equal((await fetch(`${url}/events?conversation=-1`)).status, 400);
  assert.equal((await fetch(`${url}/events?conversation=9999999`)).status, 404);
  const forkResponse = await post(`${url}/fork`, { entry: history.at(-1)?.id });
  assert.equal(forkResponse.status, 201);
  const fork = await forkResponse.json();
  const branch = await session.conversation(fork.id);
  assert.deepEqual(await session.history(branch), history);
  assert.equal((await fetch(`${url}/conversations`)).status, 200);
  const reset = await post(`${url}/reset?conversation=${fork.id}`, {
    handoff: "Carry this forward.",
  });
  assert.equal(reset.status, 200);
  assert.equal((await branch.context(context)).messages.length, 1);
  assert.deepEqual(await session.history(), history);
  const exported = await (await fetch(`${url}/export?conversation=${fork.id}`)).json();
  assert.equal(exported.length, history.length + 1);
  assert.equal((await post(`${url}/compact?conversation=${fork.id}`, {})).status, 200);
  await session.harness.waitForIdle(context);
  assert.equal((await session.harness.inspect(context)).tasks.length, 0);
  const manifest = await (await fetch(base + "/manifest.webmanifest")).json();
  assert.equal(manifest.display, "standalone");
  assert.deepEqual(
    manifest.icons.map((icon: { sizes: string }) => icon.sizes),
    ["192x192", "512x512"],
  );
});

await test("HTTPS proxy origin is explicit and forwarded headers cannot bypass origin checks", async (t) => {
  const f = await fixture(t);
  const base = await serve(t, f.sessions, undefined, "127.0.0.1", "https://pi.example");
  const status = (headers: Record<string, string>) =>
    new Promise<number | undefined>((resolve, reject) => {
      const req = request(base + "/api/catalog", { headers }, (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      req.once("error", reject);
      req.end();
    });
  assert.equal(await status({ Host: "pi.example", Origin: "https://pi.example" }), 200);
  assert.equal(await status({ Host: "pi.example", Origin: "https://evil.example" }), 403);
  assert.equal(
    await status({
      Host: "evil.example",
      "X-Forwarded-Host": "pi.example",
      "X-Forwarded-Proto": "https",
    }),
    403,
  );
  for (const value of [
    "http://pi.example",
    "https://pi.example/path",
    "https://user:pass@pi.example",
    "https://pi.example?query",
    "https://pi.example#fragment",
  ])
    assert.throws(() => parseOptions(["--origin", value]));
  assert.equal(
    parseOptions(["--origin", "https://pi.example/"]).publicOrigin,
    "https://pi.example",
  );
});

await test("global settings persist through Pi, preserve unrelated keys, and drive live Durable policy", async (t) => {
  const f = await fixture(t);
  await f.sessions.close();
  const agentDir = join(f.workspace, "agent");
  const path = join(agentDir, "settings.json");
  await mkdir(agentDir);
  await mkdir(join(f.workspace, ".pi"));
  await writeFile(
    join(f.workspace, ".pi", "settings.json"),
    JSON.stringify({ defaultThinkingLevel: "off", shellPath: "/untrusted" }),
  );
  await writeFile(
    path,
    JSON.stringify({
      defaultProvider: model.provider,
      defaultModel: model.modelId,
      theme: "light",
      shellPath: "/trusted",
      compaction: { reserveTokens: 12345, modelOverrides: { "faux/faux-1": { reserveTokens: 1 } } },
      retry: { maxRetries: 7, provider: { maxRetries: 0 } },
    }),
  );
  const store = new GlobalSettingsStore(
    SettingsManager.create(f.workspace, agentDir, { projectTrusted: false }),
  );
  const options = store.bind(f.options);
  const sessions = await Sessions.open(options);
  t.after(() => sessions.close());
  const base = await serve(t, sessions, undefined, "127.0.0.1", undefined, store);
  const current = await sessions.create(randomUUID(), f.binding, model);
  assert.equal((await current.info()).thinkingLevel, "medium");
  assert.equal(options.settings?.compaction?.reserveTokens, 12345);
  assert.equal(options.settings?.stream?.maxRetries, 0);
  const get = () =>
    fetch(base + "/api/settings").then((response) => response.json()) as Promise<GlobalSettings>;
  assert.equal((await get()).values.defaultThinkingLevel, "medium");
  const before = await get();
  for (const data of [
    { values: { defaultThinkingLevel: "wrong" } },
    { values: { "retry.enabled": "false" } },
    { values: { "retry.maxRetries": -1 } },
    { values: { shellPath: "/not-allowed" } },
    { values: { hideThinkingBlock: true }, model: { provider: "missing", modelId: "missing" } },
    { modelThinkingLevel: "high" },
    { unknown: true },
  ]) {
    assert.equal((await post(base + "/api/settings", data)).status, 400);
    assert.deepEqual(await get(), before);
  }
  const result = await post(base + "/api/settings", {
    model,
    modelThinkingLevel: "high",
    values: {
      defaultThinkingLevel: "low",
      "compaction.enabled": false,
      "retry.enabled": false,
      steeringMode: "all",
      followUpMode: "all",
      transport: "sse",
      hideThinkingBlock: true,
      "terminal.showImages": false,
    },
  });
  assert.equal(result.status, 200);
  const persisted = SettingsManager.create(f.workspace, agentDir, { projectTrusted: false });
  assert.equal(persisted.getDefaultThinkingLevel(), "low");
  assert.equal(persisted.getModelThinkingLevel(model.provider, model.modelId), "high");
  assert.equal(persisted.getTheme(), "light");
  assert.equal(persisted.getShellPath(), "/trusted");
  assert.equal(persisted.getCompactionReserveTokens(), 12345);
  assert.equal(
    persisted.getCompactionReserveTokens({ provider: model.provider, id: model.modelId }),
    1,
  );
  assert.equal(options.settings?.retry?.enabled, false);
  assert.equal(options.settings?.retry?.maxRetries, 7);
  assert.equal(options.settings?.steeringMode, "all");
  assert.equal(options.settings?.followUpMode, "all");
  assert.equal(options.settings?.stream?.transport, "sse");
  const view = await snapshot(base + "/api/sessions/" + current.id + "/events");
  assert.equal(view.context.autoCompact, false);
  assert.equal((await current.info()).thinkingLevel, "medium");
  const created = await post(base + "/api/sessions", {
    id: randomUUID(),
    binding: f.binding,
    model,
  });
  assert.equal(created.status, 201);
  assert.equal((await created.json()).thinkingLevel, "high");
  const override = await post(base + "/api/sessions", {
    id: randomUUID(),
    binding: f.binding,
    model,
    thinkingLevel: "off",
  });
  assert.equal((await override.json()).thinkingLevel, "off");
  const invalid = await post(base + "/api/sessions", {
    id: randomUUID(),
    binding: f.binding,
    model,
    thinkingLevel: "invalid",
  });
  assert.equal(invalid.status, 400);
  const configured = await post(base + "/api/sessions/" + current.id + "/configure", {
    model,
    thinkingLevel: "max",
    instructions: "",
  });
  assert.equal(configured.status, 200);
  assert.equal((await current.info()).thinkingLevel, "high");
  assert.equal(
    (await post(base + "/api/settings", { model, modelThinkingLevel: null })).status,
    200,
  );
  assert.equal((await sessions.catalog()).models[0].defaultThinkingLevel, "low");
  // Verify the actual generation receives the policy, not only our settings object.
  f.faux.setResponses([
    (_context, stream) => {
      assert.equal(stream?.transport, "sse");
      assert.equal(stream?.maxRetries, 0);
      return fauxAssistantMessage("Configured.");
    },
  ]);
  await current.prompt("Run with current policy.", randomUUID());
  await current.root.waitForIdle(context);
  assert.equal(f.faux.state.callCount, 1);
});

await test("settings persistence failures are reported and never silently acknowledged", async (t) => {
  const f = await fixture(t);
  let raw = "{}";
  const manager = SettingsManager.fromStorage(
    {
      withLock(scope, change) {
        const next = change(scope === "global" ? raw : undefined);
        if (next !== undefined) throw new Error("Read-only settings");
      },
    },
    { projectTrusted: false },
  );
  const store = new GlobalSettingsStore(manager);
  await assert.rejects(store.update({ values: { hideThinkingBlock: true } }, f.sessions));
  assert.equal(store.read().values.hideThinkingBlock, false);
  assert.deepEqual(JSON.parse(raw), {});
});

await test("mobile browser edits shared defaults and keeps session settings independent", async (t) => {
  const f = await fixture(t);
  await f.sessions.close();
  const plain = fauxProvider({ provider: "plain", models: [{ id: "plain", reasoning: false }] });
  f.options.models.setProvider(plain.provider);
  const store = new GlobalSettingsStore(
    SettingsManager.inMemory({
      defaultProvider: model.provider,
      defaultModel: model.modelId,
    }),
  );
  const sessions = await Sessions.open(store.bind(f.options));
  t.after(() => sessions.close());
  const assets = join(f.workspace, "assets");
  await buildAssets(dirname(fileURLToPath(import.meta.url)), assets);
  const base = await serve(t, sessions, assets, "127.0.0.1", undefined, store);
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));
  await page.goto(base);
  await page.waitForSelector("#picker:not([hidden])");
  await page.click("#new-options-toggle");
  assert.equal(await page.locator("#models").inputValue(), "0");
  assert.equal(
    await page.locator("#new-thinking option").first().textContent(),
    "Default (medium)",
  );
  await page.selectOption("#models", "1");
  assert.equal(await page.locator("#new-thinking option").first().textContent(), "Default (off)");
  assert.deepEqual(
    await page
      .locator("#new-thinking option")
      .evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).value)),
    ["", "off"],
  );
  const oldOption = await page.locator("#models option").last().elementHandle();
  assert(oldOption);
  await page.click("#close-view");
  await page.click("#title");
  await page.waitForFunction((option) => !option.isConnected, oldOption);
  assert.equal(await page.locator("#models").inputValue(), "1");

  // Change models while a refresh is pending. Its response must not restore
  // the selection from before the request.
  const requested = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  t.after(() => release.resolve());
  await page.route("**/api/catalog", async (route) => {
    requested.resolve();
    await release.promise;
    await route.continue();
  });
  const pendingOption = await page.locator("#models option").last().elementHandle();
  assert(pendingOption);
  await page.click("#close-view");
  await page.click("#title");
  await requested.promise;
  await page.selectOption("#models", "0");
  release.resolve();
  await page.waitForFunction((option) => !option.isConnected, pendingOption);
  await page.unroute("**/api/catalog");
  assert.equal(await page.locator("#models").inputValue(), "0");
  assert.equal(await page.locator("#new-thinking").inputValue(), "");

  await page.click("#close-view");
  await page.click("#menu-toggle");
  await page.selectOption("#default-model", "0");
  await page.selectOption("#model-thinking-default", "high");
  await page.selectOption('[name="defaultThinkingLevel"]', "low");
  await page.selectOption('[name="hideThinkingBlock"]', "true");
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(
      await page
        .locator("#global-preferences")
        .evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth),
      true,
    );
    if (process.env.PI_SCREENSHOT_DIR) {
      await mkdir(process.env.PI_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.PI_SCREENSHOT_DIR, `defaults-${width}.png`) });
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click("#close-view");
  await page.waitForSelector("#global-preferences", { state: "hidden" });
  assert.equal(await page.locator("#new-thinking option").first().textContent(), "Default (high)");
  assert.equal(
    await page.locator("body").evaluate((node) => node.classList.contains("hide-thinking")),
    true,
  );
  await page.click("#title");
  await page.click("#create");
  await page.waitForFunction(() => new URL(location.href).searchParams.has("session"));
  const id = new URL(page.url()).searchParams.get("session")!;
  const session = await sessions.get(id);
  assert.equal((await session.info()).thinkingLevel, "high");
  await page.waitForFunction(
    () => !document.querySelector<HTMLButtonElement>("#footer-model")?.disabled,
  );
  await page.click("#footer-model");
  assert.deepEqual(
    await page
      .locator("#thinking option")
      .evaluateAll((nodes) => nodes.map((node) => node.textContent)),
    ["off", "minimal", "low", "medium", "high"],
  );
  await page.selectOption("#thinking", "off");
  await page.click("#close-view");
  await page.waitForSelector("#preferences", { state: "hidden" });
  assert.equal((await session.info()).thinkingLevel, "off");
  assert.equal(store.read().values.defaultThinkingLevel, "low");
  assert.equal(store.read().modelThinkingLevels["faux/faux-1"], "high");
  await page.reload();
  await page.waitForFunction(
    () => !document.querySelector<HTMLButtonElement>("#footer-model")?.disabled,
  );
  assert.equal(
    await page.locator("body").evaluate((node) => node.classList.contains("hide-thinking")),
    true,
  );
  assert.equal((await session.info()).thinkingLevel, "off");
  assert.deepEqual(errors, []);
});

await test("mobile browser stacked views preserve input and scroll, serialize autosaves and isolate background work", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const store = new GlobalSettingsStore(SettingsManager.inMemory());
  const assets = join(f.workspace, "assets");
  await buildAssets(dirname(fileURLToPath(import.meta.url)), assets);
  const base = await serve(t, f.sessions, assets, "127.0.0.1", undefined, store);
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  t.after(() => browser.close());
  f.faux.setResponses([fauxAssistantMessage("Searchable history.\n".repeat(80))]);
  await session.prompt("Seed history.", randomUUID());
  await session.root.waitForIdle(context);
  for (const width of [390, 1440]) {
    const page = await browser.newPage({
      viewport: { width, height: 900 },
      hasTouch: width === 390,
    });
    const errors: Error[] = [];
    page.on("pageerror", (error) => errors.push(error));
    page.setDefaultTimeout(10_000);
    await page.goto(`${base}/?session=${session.id}`);
    await page.waitForSelector("#status[data-state=ready]");
    await page.fill("#prompt", "Unsent draft");
    await page.setInputFiles("#images", {
      name: "pixel.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    });
    await page.waitForSelector("#attachments button");
    const scroll = await page.locator("#transcript").evaluate((node) => {
      node.scrollTop = 120;
      return node.scrollTop;
    });
    await page.click("#footer-model");
    await page.fill("#session-name", `Session ${width}`);
    await page.focus("#instructions");
    await waitFor(async () => (await session.info()).name === `Session ${width}`);
    assert.equal(await page.locator("body").getAttribute("data-view"), "settings");

    // A blur starts a save; leaving during that request must wait and fail closed.
    const requested = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    t.after(() => release.resolve());
    let fail = true;
    await page.route("**/configure*", async (route) => {
      requested.resolve();
      await release.promise;
      if (fail)
        await route.fulfill({ status: 503, json: { error: "Settings storage unavailable" } });
      else await route.continue();
    });
    await page.fill("#instructions", `Instructions ${width}`);
    await page.click("#close-view");
    await requested.promise;
    assert.equal(await page.locator("body").getAttribute("data-view"), "settings");
    assert.equal(await page.locator("#preferences").getAttribute("aria-busy"), "true");
    release.resolve();
    await page.waitForSelector("#preferences:not([aria-busy])");
    assert.equal(await page.locator("#notice").isVisible(), true);
    assert.equal(await page.inputValue("#instructions"), `Instructions ${width}`);
    assert.equal(await page.inputValue("#prompt"), "Unsent draft");
    const failed = page.waitForResponse(
      (response) => response.url().includes("/configure") && response.status() === 503,
    );
    await page.keyboard.press("Control+k");
    await failed;
    await page.waitForSelector("#preferences:not([aria-busy])");
    assert.equal(await page.locator("body").getAttribute("data-view"), "settings");
    fail = false;
    await page.keyboard.press("Control+k");
    await page.waitForSelector("#picker:not([hidden])");
    assert.equal((await session.root.agent(context)).instructions, `Instructions ${width}`);
    assert.equal(await page.locator("#attachments button").count(), 1);
    assert.equal(await page.locator("#new-options").isHidden(), true);
    await page.click("#new-options-toggle");
    assert.equal(await page.locator("#new-options").isVisible(), true);
    assert.equal(
      await page.locator("#new-options-toggle .options-close").textContent(),
      await page.locator("#stop span").textContent(),
    );
    await page.fill("#session-filter", "not a session");
    assert.equal(await page.locator("#sessions button").count(), 0);
    await page.fill("#session-filter", `Session ${width}`);
    assert.equal(await page.locator("#sessions button").count(), 1);
    await page.keyboard.press("Control+f");
    await page.waitForSelector("#search-bar:not([hidden])");
    assert.equal(await page.locator("#view-title").textContent(), `Search in “Session ${width}”`);
    const articleStyles = () =>
      page.locator("#transcript article").evaluateAll((nodes) =>
        nodes.map((node) => {
          const css = getComputedStyle(node);
          return [css.paddingLeft, css.borderLeftWidth, css.backgroundColor];
        }),
      );
    const before = await articleStyles();
    await page.fill("#search", "Searchable");
    assert.deepEqual(await articleStyles(), before);
    assert(await page.evaluate(() => (CSS.highlights.get("pi-search")?.size ?? 0) > 0));
    await page.click("#close-view");
    await page.waitForSelector("#composer:not([hidden])");
    assert.equal(await page.locator("#transcript").evaluate((node) => node.scrollTop), scroll);
    assert.equal(await page.inputValue("#prompt"), "Unsent draft");
    await page.locator("#attachments button").click();

    // Saving immediately on selects includes edits made while a save is pending.
    const selectRequested = Promise.withResolvers<void>();
    const selectRelease = Promise.withResolvers<void>();
    t.after(() => selectRelease.resolve());
    await page.unroute("**/configure*");
    await page.route("**/configure*", async (route) => {
      selectRequested.resolve();
      await selectRelease.promise;
      await route.continue();
    });
    await page.click("#footer-model");
    await page.selectOption("#thinking", "low");
    await selectRequested.promise;
    await page.selectOption("#thinking", "high");
    await page.click("#footer-context");
    assert.equal(await page.locator("body").getAttribute("data-view"), "settings");
    selectRelease.resolve();
    await page.waitForSelector("#usage-dialog:not([hidden])");
    assert.equal((await session.root.agent(context)).thinkingLevel, "high");
    await page.unroute("**/configure*");

    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    t.after(() => finish.resolve());
    f.faux.setResponses([
      async () => {
        started.resolve();
        await finish.promise;
        return fauxAssistantMessage(`Background response ${width}`);
      },
    ]);
    await page.fill("#prompt", "Run in the background.");
    await page.press("#prompt", "Control+Enter");
    await started.promise;
    await page.waitForSelector("#status[data-state=working]", { state: "attached" });
    assert.equal(await page.locator("body").getAttribute("data-view"), "stats");
    await page.fill("#prompt", "Queued text ".repeat(200));
    await page.press("#prompt", "Control+Enter");
    await page.waitForSelector("#queue button", { state: "attached" });
    assert.equal(await page.locator("#queue").isHidden(), true);
    await page.click("#close-view");
    const queue = await page.locator("#queue").evaluate((node) => ({
      height: node.getBoundingClientRect().height,
      scroll: node.scrollHeight,
      client: node.clientHeight,
    }));
    assert(queue.height > 0 && queue.height <= 180);
    assert(queue.scroll > queue.client);
    await page.locator("#queue button").click();
    await page.waitForSelector("#queue", { state: "hidden" });
    await page.click("#footer-context");
    finish.resolve();
    await session.root.waitForIdle(context);
    await page.waitForSelector("#status[data-state=ready]", { state: "attached" });
    assert.equal(await page.locator("body").getAttribute("data-view"), "stats");
    await page.fill("#prompt", "/fork");
    await page.press("#prompt", "Control+Enter");
    await page.waitForSelector("#branches button");
    assert.equal(await page.locator("#branches button").count(), 1);
    await page.locator("#branches button").click();
    await page.waitForSelector("#title", { state: "visible" });

    // Global save failures use the same bar and transition guard, not a dialog.
    await page.click("#menu-toggle");
    fail = true;
    await page.route("**/api/settings", async (route) => {
      if (fail && route.request().method() === "POST")
        await route.fulfill({ status: 503, json: { error: "Defaults storage unavailable" } });
      else await route.continue();
    });
    await page.selectOption('[name="defaultThinkingLevel"]', width === 390 ? "high" : "low");
    await page.waitForSelector("#notice", { state: "visible" });
    await page.waitForSelector("#global-preferences:not([aria-busy])");
    const failedGlobal = page.waitForResponse(
      (response) => response.url().endsWith("/api/settings") && response.status() === 503,
    );
    await page.click("#close-view");
    await failedGlobal;
    await page.waitForSelector("#global-preferences:not([aria-busy])");
    assert.equal(await page.locator("body").getAttribute("data-view"), "global");
    if (process.env.PI_SCREENSHOT_DIR) {
      await mkdir(process.env.PI_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({
        path: join(process.env.PI_SCREENSHOT_DIR, `autosave-failure-${width}.png`),
      });
    }
    fail = false;
    await page.click("#close-view");
    await page.waitForSelector("#title", { state: "visible" });
    assert.equal(store.read().values.defaultThinkingLevel, width === 390 ? "high" : "low");
    await page.click("#footer-context");
    await page.fill("#prompt", "Keep through reconnect");
    await page.context().setOffline(true);
    await page.waitForSelector('#bottom-line[data-connected="false"]');
    await page.context().setOffline(false);
    await page.waitForSelector('#bottom-line[data-connected="true"]');
    assert.equal(await page.locator("body").getAttribute("data-view"), "stats");
    assert.equal(await page.inputValue("#prompt"), "Keep through reconnect");

    // Creation can finish while a new edit is saving. It must not switch the
    // form binding or repaint the new session with the old rename/configure result.
    const creating = Promise.withResolvers<void>();
    const createRelease = Promise.withResolvers<void>();
    const configuring = Promise.withResolvers<void>();
    const configureRelease = Promise.withResolvers<void>();
    t.after(() => {
      createRelease.resolve();
      configureRelease.resolve();
    });
    await page.route("**/api/sessions", async (route) => {
      creating.resolve();
      await createRelease.promise;
      await route.continue();
    });
    await page.route("**/configure*", async (route) => {
      configuring.resolve();
      await configureRelease.promise;
      await route.continue();
    });
    await page.click("#footer-model");
    await page.fill("#prompt", "/new");
    await page.press("#prompt", "Control+Enter");
    await creating.promise;
    await page.fill("#instructions", `Before creating ${width}`);
    await page.focus("#session-name");
    await configuring.promise;
    await page.fill("#session-name", `Old session ${width}`);
    const created = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/sessions") && response.request().method() === "POST",
    );
    createRelease.resolve();
    const newSession = await (await created).json();
    assert.equal(await page.locator("body").getAttribute("data-view"), "settings");
    assert.equal(new URL(page.url()).searchParams.get("session"), session.id);
    configureRelease.resolve();
    await page.waitForURL((url) => url.searchParams.get("session") === newSession.id);
    await page.waitForSelector("#status[data-state=ready]");
    assert.equal((await session.root.agent(context)).instructions, `Before creating ${width}`);
    assert.equal((await session.info()).name, `Old session ${width}`);
    assert.equal(
      (await (await f.sessions.get(newSession.id)).root.agent(context)).instructions,
      undefined,
    );
    assert.equal(await page.locator("#title").textContent(), f.workspace.split("/").at(-1));
    assert.deepEqual(errors, []);
    await page.close();
  }
});

await test("mobile browser branch refresh preserves keyboard focus while loading new conversations", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  await session.root.reset(undefined, context);
  const last = (await session.history()).at(-1);
  assert(last);
  const assets = join(f.workspace, "assets");
  await buildAssets(dirname(fileURLToPath(import.meta.url)), assets);
  const base = await serve(t, f.sessions, assets);
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(`${base}/?session=${session.id}`);
  await page.waitForSelector("#status[data-state=ready]");
  await page.waitForSelector("#branches button", { state: "attached" });
  const original = await page.locator("#branches button").first().elementHandle();
  assert(original);
  const requested = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  t.after(() => release.resolve());
  await page.route("**/conversations", async (route) => {
    requested.resolve();
    await release.promise;
    await route.continue();
  });
  await page.fill("#prompt", "/fork");
  await page.press("#prompt", "Control+Enter");
  await requested.promise;
  await page.keyboard.press("Control+j");
  assert.equal(await original.evaluate((node) => node === document.activeElement), true);
  const branch = await session.root.fork(last.id, { ownership: { kind: "ownerless" } }, context);
  release.resolve();
  await page.waitForFunction(() => document.querySelectorAll("#branches button").length === 2);
  assert.equal(
    await original.evaluate((node) => node.isConnected && node === document.activeElement),
    true,
  );
  await page.keyboard.press("Control+k");
  assert.equal(
    await page
      .locator("#branches button")
      .last()
      .evaluate((node) => node === document.activeElement),
    true,
  );
  await page.keyboard.press("Enter");
  await page.waitForURL((url) => url.searchParams.get("conversation") === String(branch.id));
});

await test("mobile browser navigation never automatically focuses controls", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const assets = join(f.workspace, "assets");
  await buildAssets(dirname(fileURLToPath(import.meta.url)), assets);
  const base = await serve(t, f.sessions, assets);
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  // Catch transient focus too, not just the active element after a transition.
  await page.addInitScript(() => {
    const calls: string[] = [];
    Object.assign(window, { automaticFocus: calls });
    const focus = Reflect.get(HTMLElement.prototype, "focus") as HTMLElement["focus"];
    HTMLElement.prototype.focus = function (...args) {
      calls.push(this.id || this.tagName);
      focus.apply(this, args);
    };
  });
  await page.goto(`${base}/?session=${session.id}`);
  await page.waitForFunction(
    () => !document.querySelector<HTMLButtonElement>("#footer-model")?.disabled,
  );
  assert.equal(
    await page.locator("#prompt").evaluate((node) => node === document.activeElement),
    false,
  );
  for (const initiallyFocused of [false, true]) {
    if (initiallyFocused) await page.click("#prompt");
    await page.click("#menu-toggle");
    await page.waitForSelector("#global-preferences", { state: "visible" });
    await page.click("#close-view");
    await page.waitForSelector("#global-preferences", { state: "hidden" });
    assert.equal(
      await page.locator("#prompt").evaluate((node) => node === document.activeElement),
      false,
    );
  }
  for (const trigger of ["#footer-model", "#title"]) {
    await page.click(trigger);
    await page.waitForSelector("#close-view", { state: "visible" });
    await page.keyboard.press("Escape");
    await page.waitForSelector("#close-view", { state: "hidden" });
  }
  await page.click("#prompt");
  await page.keyboard.type("/review");
  await page.keyboard.press("Control+Enter");
  await page.waitForSelector("#review-setup[open]");
  assert.equal(
    await page.locator("#review-setup").evaluate((node) => node.contains(document.activeElement)),
    false,
  );
  await page.click("#review-instructions");
  await page.keyboard.press("Escape");
  await page.waitForSelector("#review-setup", { state: "hidden" });
  assert.equal(
    await page.locator("#prompt").evaluate((node) => node === document.activeElement),
    false,
  );
  assert.deepEqual(await page.evaluate(() => Reflect.get(window, "automaticFocus")), []);
});

await test("mobile browser compaction and reset archive unchanged conversation nodes in Shadow DOM", async (t) => {
  const f = await fixture(t);
  const sessions = await Sessions.open({
    ...f.options,
    directory: join(f.workspace, "state"),
    settings: { compaction: { keepRecentTokens: 1 } },
  });
  t.after(() => sessions.close());
  const session = await sessions.create(randomUUID(), f.binding, model);
  for (const entry of benchmarkFixture(2).view.entries)
    await session.root.submit(
      { type: "write", entry: { kind: entry.kind, model: entry.model } },
      context,
    );
  const assets = join(f.workspace, "assets");
  await buildAssets(dirname(fileURLToPath(import.meta.url)), assets);
  const base = await serve(t, sessions, assets);
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));
  await page.goto(`${base}/?session=${session.id}`);
  await page.waitForSelector('.tool-call[data-call-id="call1"]');
  const tool = page.locator('.tool-call[data-call-id="call0"]');
  await tool.locator(":scope > summary").click();
  const original = await page.evaluateHandle(() =>
    Array.from(document.querySelectorAll("#transcript > article")),
  );
  const appearance = async () =>
    original.evaluate((nodes) =>
      nodes
        .flatMap((node) => [node, ...node.querySelectorAll("*")])
        .map((node) => {
          const style = getComputedStyle(node);
          return [
            style.font,
            style.color,
            style.padding,
            style.margin,
            style.border,
            style.display,
            node.getBoundingClientRect().width,
          ];
        }),
    );
  const before = await appearance();
  await page.setViewportSize({ width: 1440, height: 900 });
  const desktopBefore = await appearance();
  await page.setViewportSize({ width: 390, height: 844 });
  const release = Promise.withResolvers<void>();
  t.after(() => release.resolve());
  f.faux.setResponses([
    async () => {
      await release.promise;
      return fauxAssistantMessage("A concise checkpoint.");
    },
  ]);
  const taskId = await session.root.compact(undefined, context);
  const running = page.locator('.context-event[data-state="running"]');
  await running.waitFor();
  assert.equal(await running.locator(".tool-status > span").count(), 4);
  assert.equal(await running.locator(".tool-status").getAttribute("aria-label"), "running");
  assert.equal(
    await running
      .locator(".tool-status > span")
      .first()
      .evaluate((node) => getComputedStyle(node).animationName),
    "tool-spinner",
  );
  assert.equal(await page.locator(".context-history").count(), 0);
  release.resolve();
  await session.harness.waitForTask(taskId, context);
  const completed = page.locator('.context-event[data-state="completed"]');
  await completed.waitFor();
  assert.equal(await running.count(), 0);
  assert.equal(await completed.evaluate((node) => (node as HTMLDetailsElement).open), false);
  assert.equal(
    await completed.locator(":scope > summary > .tool-status").getAttribute("aria-label"),
    "completed",
  );
  const task = await session.harness.getTask(taskId, context);
  assert(task?.startedAt !== undefined && task.endedAt !== undefined);
  const duration = task.endedAt - task.startedAt;
  assert.equal(
    await completed.locator(":scope > summary > .tool-duration").getAttribute("title"),
    `Duration: ${duration}ms`,
  );
  assert.equal(
    await original.evaluate((nodes) =>
      nodes.every((node) => node.isConnected && node.getRootNode() instanceof ShadowRoot),
    ),
    true,
  );
  assert.equal(
    await page.evaluate(() => document.querySelectorAll("#transcript > article").length),
    1,
  );
  assert.equal(await tool.isVisible(), false);
  const summaryContent = completed.locator(":scope > .compaction-summary");
  assert.equal(await summaryContent.count(), 1);
  assert.equal(await summaryContent.isVisible(), false);
  assert.equal(await completed.locator(":scope > details").count(), 0);
  await completed.locator(":scope > summary").click();
  assert.equal(await summaryContent.isVisible(), true);
  assert.equal(await tool.evaluate((node) => (node as HTMLDetailsElement).open), true);
  assert.deepEqual(await appearance(), before);
  await page.setViewportSize({ width: 1440, height: 900 });
  assert.deepEqual(await appearance(), desktopBefore);
  await page.setViewportSize({ width: 390, height: 844 });
  // Updates reuse both the archive and its message nodes, preserving expansion.
  await session.root.submit(
    {
      type: "write",
      entry: {
        kind: "message",
        model: [{ role: "user", content: "After compaction", timestamp: Date.now() }],
      },
    },
    context,
  );
  await page.locator('article[data-role="user"]').filter({ hasText: "After compaction" }).waitFor();
  assert.equal(await completed.evaluate((node) => (node as HTMLDetailsElement).open), true);
  assert.equal(await original.evaluate((nodes) => nodes.every((node) => node.isConnected)), true);
  await session.root.reset(undefined, context);
  const reset = page.locator('article[data-context="pi.reset"] > .context-event');
  await reset.waitFor();
  assert.equal(await reset.evaluate((node) => (node as HTMLDetailsElement).open), false);
  assert.equal(await page.locator(".context-history").count(), 2);
  await reset.locator(":scope > summary").click();
  assert.equal(await tool.isVisible(), true);
  assert.deepEqual(await appearance(), before);
  // Archived message actions still work across the shadow boundary.
  await tool.locator(":scope > summary").dispatchEvent("pointerdown", {
    pointerType: "touch",
    isPrimary: true,
    pointerId: 1,
    composed: true,
  });
  await page.locator("#message-menu").waitFor();
  await tool
    .locator(":scope > summary")
    .dispatchEvent("pointerup", { pointerId: 1, composed: true });
  assert.equal(await page.locator("#message-menu").isVisible(), true);
  await page.keyboard.press("Escape");
  await page.reload();
  await reset.waitFor();
  assert.equal(await reset.evaluate((node) => (node as HTMLDetailsElement).open), false);
  assert.equal(await page.locator(".context-history").count(), 2);
  assert.equal(
    await page
      .locator('article[data-context="pi.compaction"] > .context-event > summary > .tool-duration')
      .getAttribute("title"),
    `Duration: ${duration}ms`,
  );
  await page.keyboard.press("Control+f");
  await page.fill("#search", "Inspect module 0");
  assert.equal(await page.locator("#search-count").textContent(), "1 / 1");
  assert.equal(await reset.evaluate((node) => (node as HTMLDetailsElement).open), true);
  assert.equal(
    await page
      .locator('article[data-context="pi.compaction"] > .context-event')
      .evaluate((node) => (node as HTMLDetailsElement).open),
    true,
  );
  assert.deepEqual(errors, []);
});

await test("queued compaction duration resolves its submission, including after reset and fork", async (t) => {
  const f = await fixture(t);
  const sessions = await Sessions.open({
    ...f.options,
    directory: join(f.workspace, "state"),
    settings: { compaction: { keepRecentTokens: 1 } },
  });
  t.after(() => sessions.close());
  const session = await sessions.create(randomUUID(), f.binding, model);
  for (const entry of benchmarkFixture(2).view.entries)
    await session.root.submit(
      { type: "write", entry: { kind: entry.kind, model: entry.model } },
      context,
    );
  const generating = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  t.after(() => release.resolve());
  f.faux.setResponses([
    async () => {
      generating.resolve();
      await release.promise;
      return fauxAssistantMessage("Finished.");
    },
    fauxAssistantMessage("A checkpoint while generation is busy."),
  ]);
  await session.prompt("Continue.", randomUUID());
  await generating.promise;
  const taskId = await session.root.compact(undefined, context);
  const receipt = await session.harness.waitForTask(taskId, context);
  assert.equal(receipt.state.outcome.status, "completed");
  assert.equal(
    (await session.history()).some((entry) => entry.kind === "pi.compaction"),
    false,
  );
  release.resolve();
  await session.root.waitForIdle(context);
  const entry = (await session.history()).find((entry) => entry.kind === "pi.compaction");
  assert(entry);
  assert.notEqual(entry.byTaskId, taskId);
  const task = await session.harness.getTask(taskId, context);
  assert(task?.startedAt !== undefined && task.endedAt !== undefined);
  const duration = task.endedAt - task.startedAt;
  await session.root.reset(undefined, context);
  const last = (await session.history()).at(-1);
  assert(last);
  const branch = await session.root.fork(last.id, { ownership: { kind: "ownerless" } }, context);
  const base = await serve(t, sessions);
  for (const conversation of [session.root, branch]) {
    const state = await snapshot(
      `${base}/api/sessions/${session.id}/events?conversation=${conversation.id}`,
    );
    assert.equal(state.contextDurations?.[entry.id], duration);
  }
});
