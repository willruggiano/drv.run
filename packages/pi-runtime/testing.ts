import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { TestContext } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { localIntegration, SessionError, Sessions, type Integration } from "./index.ts";

export const model = { provider: "faux", modelId: "faux-1" };

export async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "pi-runtime-state-"));
  const workspace = await mkdtemp(join(tmpdir(), "pi-runtime-work-"));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const binding = { provider: "local", target: workspace, cwd: workspace };
  const options = { directory, models, integrations: [localIntegration(workspace)] };
  let sessions = await Sessions.open(options);
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
    async reopen(integrations: readonly Integration[] = options.integrations) {
      await sessions.close();
      sessions = await Sessions.open({ ...options, integrations });
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
