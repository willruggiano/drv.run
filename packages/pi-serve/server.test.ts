import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { fixture, model, waitFor } from "../pi-runtime/testing.ts";
import { browserFlow, serve, snapshot, post } from "./testing.ts";
import { parseOptions } from "./server.ts";
import { benchmark, benchmarkFixture, benchmarkOptions } from "./benchmark.ts";

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
