import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { Conversation, Cursor, EntryRecord } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Environment, SessionError, type SessionOptions } from "./index.ts";
import { openCodingSessions } from "./coding.ts";

export const model = { provider: "faux", modelId: "faux-1" };

export async function readHistory(conversation: Conversation): Promise<EntryRecord[]> {
  const entries: EntryRecord[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await conversation.entries(
      { order: "ascending" },
      256,
      cursor,
      BACKGROUND_CONTEXT,
    );
    entries.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  return entries;
}

export async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "pi-runtime-state-"));
  const workspace = await mkdtemp(join(tmpdir(), "pi-runtime-work-"));
  const faux = fauxProvider({ models: [{ id: "faux-1", reasoning: true }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const binding = { provider: "local", target: workspace, cwd: workspace };
  const environments = new Map<string, NodeExecutionEnv>();
  const options = {
    directory,
    models,
    targets: async () => [{ ...binding, label: "Local", available: await exists(workspace) }],
    async env({ conversationId, cwd, read }, context) {
      const selected = await read.snapshot(Environment, conversationId, context);
      if (selected?.provider !== "local")
        throw new SessionError("unavailable", "Local environment is not selected.");
      if (!cwd || !isAbsolute(cwd) || !(await stat(cwd).catch(() => undefined))?.isDirectory())
        throw new SessionError("unavailable", "Local directory is unavailable.");
      let env = environments.get(cwd);
      if (!env) {
        env = new NodeExecutionEnv({ cwd });
        environments.set(cwd, env);
      }
      return env;
    },
    async close() {
      await Promise.all([...environments.values()].map((env) => env.cleanup(BACKGROUND_CONTEXT)));
      environments.clear();
    },
  } satisfies Omit<SessionOptions, "open">;
  let sessions = await openCodingSessions(options);
  t.after(async () => {
    await sessions.close();
    await rm(directory, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  });
  return {
    directory,
    workspace,
    faux,
    options,
    binding,
    get sessions() {
      return sessions;
    },
    create: () => sessions.create(randomUUID(), binding, model),
    async reopen(overrides: Partial<Omit<SessionOptions, "open">> = {}) {
      await sessions.close();
      sessions = await openCodingSessions({ ...options, ...overrides });
    },
  };
}

export function code(expected: SessionError["code"]) {
  return (error: unknown) => error instanceof SessionError && error.code === expected;
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const end = Date.now() + 5000;
  while (!(await predicate())) {
    assert(Date.now() < end, "State transition timed out");
    await delay(10);
  }
}
