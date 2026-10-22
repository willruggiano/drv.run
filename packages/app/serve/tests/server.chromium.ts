import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium } from "playwright";
import { checkCLI, chromiumExecutable } from "./testing.ts";
import { benchmark, benchmarkOptions } from "../benchmark.ts";

await test("mobile browser page benchmark returns complete JSON-compatible samples", async () => {
  const report = await benchmark(benchmarkOptions(["--runs", "2", "--turns", "2"]));
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.benchmark, "serve.render");
  assert.equal(report.measurement.profiling, false);
  assert.equal(report.measurement.freshBrowserPerRun, true);
  assert.equal(report.workload.entries, 6);
  assert.equal(report.environment.cpuRate, 1);
  assert.equal(report.source.clientSha256.length, 64);
  assert.equal(report.runs.length, 2);
  assert.equal(report.profile, null);
  assert.equal(report.memory, null);
  for (const run of report.runs) {
    assert(run.firstUpdateMs >= run.initialMs);
    assert(run.initialDomElements > 0);
    assert.equal(run.streamingMs.length, report.workload.streamUpdates);
    assert.equal(run.transitionsMs.length, report.workload.transitions);
    for (const value of [run.initialMs, run.startMs, ...run.streamingMs, ...run.transitionsMs])
      assert(Number.isFinite(value) && value >= 0);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
});

await test("page benchmarks drive the production stream and count HTTP response bytes", async () => {
  {
    const frontend = "hypermedia";
    const report = await benchmark(
      benchmarkOptions(["--frontend", frontend, "--runs", "1", "--turns", "2"]),
    );
    assert.equal(report.frontend, frontend);
    assert.deepEqual(report.environment.viewport, { width: 390, height: 844 });
    assert.equal(report.workload.entries, 6);
    assert.equal(report.runs.length, 1);
    const run = report.runs[0];
    assert(run.firstUpdateMs >= run.initialMs);
    assert(run.initialDomElements > 0);
    assert.equal(run.streamingMs.length, 40);
    assert.equal(run.streamingBytes.length, 40);
    assert.equal(run.transitionsMs.length, 10);
    assert.equal(run.transitionsBytes.length, 10);
    for (const ms of [run.initialMs, run.startMs, ...run.streamingMs, ...run.transitionsMs])
      assert(Number.isFinite(ms) && ms > 0);
    for (const bytes of [
      run.initialBytes,
      run.startBytes,
      ...run.streamingBytes,
      ...run.transitionsBytes,
    ])
      assert(Number.isSafeInteger(bytes) && bytes > 0);
    assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
  }
});

await test("page benchmark samples exact history sizes and memory in separate fresh browsers", async () => {
  {
    const frontend = "hypermedia";
    const report = await benchmark(
      benchmarkOptions(["--frontend", frontend, "--entries", "5", "--runs", "2", "--memory"]),
    );
    assert.equal(report.workload.entries, 5);
    assert.equal(report.workload.completeToolTurns, 1);
    assert.equal(report.workload.trailingEntries, 2);
    assert.equal(report.runs.length, 2);
    assert(report.memory);
    assert.equal(report.memory.separateRuns, true);
    assert.equal(report.memory.timingsIncludedInRuns, false);
    assert.equal(report.memory.forcedGC, true);
    assert.equal(report.memory.runs.length, 2);
    for (const run of report.memory.runs) {
      assert.deepEqual(
        run.samples.map((sample) => sample.phase),
        ["empty", "initial", "settled"],
      );
      assert.equal(run.samples[0].transcriptElements, 0);
      for (const sample of run.samples) {
        assert(sample.usedSize > 0 && sample.totalSize >= sample.usedSize);
        for (const value of [
          sample.embedderHeapUsedSize,
          sample.backingStorageSize,
          sample.documents,
          sample.nodes,
          sample.jsEventListeners,
          sample.transcriptElements,
        ])
          assert(Number.isFinite(value) && value >= 0);
      }
      for (const sample of run.samples.slice(1)) {
        assert.equal(sample.transcriptElements, report.runs[0].initialDomElements);
        assert(sample.nodes >= sample.transcriptElements);
      }
    }
    assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
  }
});

await test("mobile browser page profiling saves separate per-phase CPU and timeline data", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "serve-profile-test-"));
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

await test("server reads HOST/PORT and starts with no local execution target", async (t) => {
  for (const host of [undefined, "127.0.0.2"]) {
    await t.test(host ?? "default host", async (t) => {
      const directory = await mkdtemp(join(tmpdir(), "serve-startup-"));
      t.after(() => rm(directory, { recursive: true, force: true }));
      const address = host ?? "127.0.0.1";
      const reservation = createServer();
      await new Promise<void>((resolve) => reservation.listen(0, address, resolve));
      const port = (reservation.address() as AddressInfo).port;
      await new Promise<void>((resolve) => reservation.close(() => resolve()));
      const browser = await chromium.launch({ executablePath: chromiumExecutable() });
      t.after(() => browser.close());
      const page = await browser.newPage({ javaScriptEnabled: false });
      const child = spawn(
        process.execPath,
        [
          // The fixture has an empty inventory; use a fixed instance-owner identity.
          "--import",
          'data:text/javascript,import { mock } from "node:test"; mock.method(process, "getuid", () => 1000);',
          fileURLToPath(new URL("../server.ts", import.meta.url)),
        ],
        {
          env: {
            ...process.env,
            HOST: host,
            PORT: String(port),
            HOME: directory,
            XDG_STATE_HOME: join(directory, "state"),
            PATH: "",
            PI_OFFLINE: "1",
            PI_CODING_AGENT_DIR: join(directory, "agent"),
          },
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
      await checkCLI(
        child,
        `http://${address}:${port}/sessions`,
        (response) => response.text(),
        async (html) => {
          await page.setContent(html);
          assert.equal(await page.locator("#session-list").count(), 1);
          assert.equal(await page.locator("#session-list a").count(), 0);
          assert.equal(await page.locator("#targets").count(), 1);
          assert.equal(await page.locator("#targets option").count(), 0);
          assert.equal(await page.locator("#create").isDisabled(), true);
        },
      );
    });
  }
});
