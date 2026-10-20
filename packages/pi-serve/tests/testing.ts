import assert from "node:assert/strict";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  SessionError,
  type Integration,
  type Sessions,
  type Snapshot,
} from "../../pi-runtime/index.ts";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { AskRequest, ReviewReport } from "../../pi-runtime/workflows.ts";
import { fixture } from "../../pi-runtime/testing.ts";
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
export async function snapshot(url: string): Promise<Snapshot> {
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
    return JSON.parse(text.slice(6, text.indexOf("\n\n"))) as Snapshot;
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
  const integration: Integration = {
    id: "test",
    directoryRoot: binding.cwd,
    async targets() {
      return [{ ...binding, label: "Guest", available }];
    },
    async validate(value) {
      assert.deepEqual(value, binding);
      if (!available) throw new SessionError("unavailable", "Guest stopped.");
    },
    open() {
      connections++;
      const env = new NodeExecutionEnv({ cwd: binding.cwd });
      return {
        env,
        atDirectory: (cwd) => new NodeExecutionEnv({ cwd }),
        close: () => env.cleanup(context),
      };
    },
  };
  await f.reopen([integration]);
  return {
    ...f,
    get sessions() {
      return f.sessions;
    },
    binding,
    integration,
    stop() {
      available = false;
    },
    get connections() {
      return connections;
    },
  };
}

export const workflowQuestions: AskRequest = {
  title: "Preferences storage",
  questions: [
    {
      id: "storage",
      label: "Storage",
      prompt: "Which storage should the preferences service use?",
      type: "single",
      preview: true,
      options: [
        {
          value: "sqlite",
          label: "SQLite",
          description: "Atomic updates using the existing session database.",
          recommended: true,
          preview: "CREATE TABLE preferences (key TEXT PRIMARY KEY, value TEXT);",
        },
        {
          value: "json",
          label: "JSON file",
          description: "A standalone configuration file.",
          preview: '{ "theme": "dark", "lineWrap": true }',
        },
      ],
    },
    {
      id: "checks",
      label: "Verification",
      prompt: "Which checks should we run?",
      type: "multiple",
      options: [
        { value: "unit", label: "Unit tests" },
        { value: "browser", label: "Browser tests" },
      ],
    },
  ],
};
export const workflowReport: ReviewReport = {
  scope: "Preferences service · preferences.ts",
  verdict: "needs attention",
  findings: [
    {
      id: "updates",
      priority: "P1",
      title: "Prevent lost preference updates",
      file: "preferences.ts",
      startLine: 12,
      endLine: 16,
      explanation:
        "Two concurrent requests can read the same value and overwrite one another. Apply each update in a database transaction.",
      suggestion: "Run the read and write inside the existing transaction.",
    },
    {
      id: "empty",
      priority: "P2",
      title: "Handle a missing preference",
      file: "preferences.ts",
      startLine: 24,
      endLine: 24,
      explanation:
        "A fresh database returns no row. Return the default preference rather than dereferencing an absent result.",
    },
  ],
  callouts: ["Database schema changes require human review."],
};
