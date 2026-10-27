import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProxyAuthorization, type AuthorizationProvider } from "../auth.ts";
import type { ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
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
import type { Notifications } from "../notifications.ts";

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
  settings?: GlobalSettingsStore,
  origin?: string,
  authorization?: ProxyAuthorization,
  notifications?: Notifications,
) {
  const server = httpServer(sessions, host, assets, settings, origin, authorization, notifications);
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
export function post(url: string, data: Record<string, string> | FormData) {
  return fetch(url, {
    method: "POST",
    headers: { Origin: new URL(url).origin },
    body: data instanceof FormData ? data : new URLSearchParams(data),
    redirect: "manual",
  });
}

export const modelKey = (model: { provider: string; modelId: string }) =>
  JSON.stringify([model.provider, model.modelId]);
export const targetKey = (target: { provider: string; target: string }) =>
  JSON.stringify([target.provider, target.target]);
export function command(url: string, operation: string, data: Record<string, string> = {}) {
  return post(url + "/command", {
    command: operation,
    requestId: randomUUID(),
    revision: randomUUID(),
    ...data,
  });
}

export async function checkCLI<T>(
  child: ChildProcess,
  url: string,
  read: (response: Response) => Promise<T>,
  check: (catalog: T) => void | Promise<void>,
  startupTimeout = 30_000,
): Promise<void> {
  assert(child.stderr, "CLI stderr must be piped for startup diagnostics.");
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (text: string) => {
    stderr += text;
  });
  const startup = new AbortController();
  const ended = new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
    child.once("close", (code, signal) => resolve([code, signal]));
  });
  child.once("error", (error) => startup.abort(error));
  child.once("exit", (code, signal) => {
    startup.abort(new Error("CLI exited before readiness", { cause: { code, signal } }));
  });
  const timeout = setTimeout(() => {
    startup.abort(new DOMException("CLI startup timed out", "TimeoutError"));
  }, startupTimeout);
  const cleanup = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await ended;
  };
  try {
    let catalog: T;
    try {
      for (;;) {
        startup.signal.throwIfAborted();
        const response = await fetch(url, { signal: startup.signal }).catch(() => undefined);
        startup.signal.throwIfAborted();
        if (response?.ok) {
          catalog = await read(response);
          break;
        }
        await response?.body?.cancel();
        await delay(10, undefined, { signal: startup.signal });
      }
    } catch (error) {
      // Drain stderr and reap the child before reporting the original startup failure.
      const cause = startup.signal.aborted ? startup.signal.reason : error;
      await cleanup();
      throw new Error(`CLI startup failed. Stderr:\n${stderr || "(empty)"}`, {
        cause,
      });
    }
    clearTimeout(timeout);
    await check(catalog);
    child.kill("SIGTERM");
    const forceKill = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      assert.deepEqual(await ended, [0, null]);
    } finally {
      clearTimeout(forceKill);
    }
  } finally {
    clearTimeout(timeout);
    // Cleanup must not assert graceful shutdown or replace an earlier test failure.
    await cleanup();
  }
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

export async function authorizationFixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "serve-auth-"));
  const path = join(directory, "alice.sock");
  const empty = (provider: AuthorizationProvider) => ({
    state: "not-enrolled",
    user_id: provider === "github" ? 1 : null,
    device: null,
    error: null,
  });
  const snapshots: Record<AuthorizationProvider, unknown> = {
    github: empty("github"),
    openai: empty("openai"),
  };
  let credential: unknown = null;
  const calls: { method: string | undefined; path: string | undefined }[] = [];
  const server = createServer((request, response) => {
    calls.push({ method: request.method, path: request.url });
    response.setHeader("Content-Type", "application/json");
    const provider = request.url?.startsWith("/openai/") ? "openai" : "github";
    const operation = request.url?.split("/").at(-1);
    if (request.method === "GET" && operation === "status") {
      response.end(JSON.stringify(snapshots[provider]));
    } else if (request.method === "POST" && operation === "login") {
      snapshots[provider] = {
        ...empty(provider),
        state: "authorizing",
        device: {
          user_code: "ABCD-EFGH",
          verification_uri:
            provider === "github"
              ? "https://github.com/login/device"
              : "https://auth.openai.com/codex/device",
          expires_at: 1900000900,
        },
      };
      response.writeHead(204).end();
    } else if (request.method === "POST" && operation === "logout") {
      snapshots[provider] = empty(provider);
      if (provider === "openai") credential = null;
      response.writeHead(204).end();
    } else if (request.method === "POST" && request.url === "/openai/token") {
      if (credential === null) response.writeHead(503).end();
      else response.end(JSON.stringify(credential));
    } else response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  });
  return {
    authorization: new ProxyAuthorization(path),
    calls,
    reply(value: unknown, provider: AuthorizationProvider = "github") {
      snapshots[provider] = value;
    },
    token(value: unknown) {
      credential = value;
    },
    approve(provider: AuthorizationProvider = "github") {
      snapshots[provider] = {
        ...empty(provider),
        state: "usable",
        expires_at: 1900028800,
        ...(provider === "openai" ? { account_id: "account-alice" } : {}),
      };
    },
  };
}
