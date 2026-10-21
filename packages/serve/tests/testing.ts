import type { RenderState } from "../client.ts";
import assert from "node:assert/strict";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { SessionError, Environment, type SessionOptions, type Sessions } from "../sessions.ts";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { fixture } from "./sessions-testing.ts";
import { httpServer, type GlobalSettingsStore } from "../server.ts";

const context = BACKGROUND_CONTEXT;

export function chromiumExecutable(searchPath = process.env.PATH ?? ""): string {
  for (const directory of searchPath.split(delimiter)) {
    const candidate = resolve(directory, "chromium");
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error) ||
        !["ENOENT", "ENOTDIR", "EACCES"].includes(String(error.code))
      )
        throw error;
    }
  }
  throw new Error("Chromium is required on PATH for browser tests; use nix develop.");
}

export async function serve(
  t: TestContext,
  sessions: Sessions,
  assets?: string,
  host = "127.0.0.1",
  publicOrigin?: string,
  settings?: GlobalSettingsStore,
) {
  const server = httpServer(sessions, host, assets, publicOrigin, settings);
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
export async function snapshot(url: string): Promise<RenderState> {
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal });
  assert.equal(response.status, 200);
  assert(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (!text.includes("\n\n")) {
      const part = await reader.read();
      assert.equal(part.done, false);
      text += decoder.decode(part.value, { stream: true });
    }
    const view = JSON.parse(text.slice(6, text.indexOf("\n\n"))).value as RenderState["view"];
    const resource = new URL(url);
    const id = resource.pathname.split("/")[3];
    const get = async (path: string) => {
      const response = await fetch(resource.origin + path + resource.search);
      assert.equal(response.status, 200);
      return response.json();
    };
    const [session, context, inspection, history] = await Promise.all([
      get(`/api/sessions/${id}/info`),
      get(`/api/sessions/${id}/context-status`),
      get(`/api/sessions/${id}/inspection`),
      get(`/api/harness/${id}/entries`),
    ]);
    return { session, view, context, inspection, history: history.items };
  } finally {
    controller.abort();
    reader.releaseLock();
  }
}
export function post(url: string, data: unknown) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

// Frontend contract fixture. The drv.run suite separately exercises the real pi-env daemon.
export async function directoryFixture(t: TestContext, root?: string) {
  const f = await fixture(t);
  const binding = { provider: "test", target: "guest", cwd: root ?? f.workspace };
  let available = true;
  let connections = 0;
  const environments = new Map<string, NodeExecutionEnv>();
  function remoteEnvironment(cwd: string) {
    if (!available) throw new SessionError("unavailable", "Guest stopped.");
    let env = environments.get(cwd);
    if (!env) {
      connections++;
      env = new NodeExecutionEnv({ cwd });
      environments.set(cwd, env);
    }
    return env;
  }
  const execution: Partial<SessionOptions> = {
    async targets() {
      return [
        { ...binding, directoryRoot: binding.cwd, label: "Guest", available },
        ...(await f.options.targets()),
      ];
    },
    async env(target, context) {
      const selected = await target.read.snapshot(Environment, target.conversationId, context);
      if (selected?.provider === "local") return f.options.env(target, context);
      assert.equal(selected?.provider, binding.provider);
      assert.equal(selected?.target, binding.target);
      return remoteEnvironment(target.cwd ?? binding.cwd);
    },
    directoryEnv(selected) {
      assert.equal(selected.provider, binding.provider);
      assert.equal(selected.target, binding.target);
      return remoteEnvironment(selected.cwd);
    },
    async close() {
      await f.options.close();
      await Promise.all([...environments.values()].map((env) => env.cleanup(context)));
      environments.clear();
    },
  };
  await f.reopen(execution);
  return {
    ...f,
    get sessions() {
      return f.sessions;
    },
    binding,
    execution,
    stop() {
      available = false;
    },
    get connections() {
      return connections;
    },
  };
}
