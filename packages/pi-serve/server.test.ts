import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

await test("mobile browser runs local tools, reconnects and renders untrusted content safely", async (t) => {
  await browserFlow(t, await fixture(t));
});
