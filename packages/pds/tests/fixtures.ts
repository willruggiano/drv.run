import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { openApplication, type Application, type Environment } from "../src/application.ts";
import { SessionId, decode } from "../src/identity.ts";

export const form = (fields: Record<string, string>): FormData => {
  const result = new FormData();
  for (const [key, value] of Object.entries(fields)) result.set(key, value);
  return result;
};

export async function sessionsFixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "pds-"));
  const faux = fauxProvider({
    models: [
      { id: "first", reasoning: true, input: ["text", "image"] },
      { id: "second", reasoning: false, input: ["text"] },
    ],
    tokensPerSecond: 200,
    tokenSize: { min: 4, max: 4 },
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const environments: Environment[] = [
    { id: "local", label: "Local (server)" },
    {
      id: "test-guest",
      label: "Test guest",
      target: { host: "test-guest", knownHostsFile: "/known_hosts", hostKeyAlias: "test-guest" },
    },
  ];
  const owners = new Set<Application>();
  const open = async () => {
    const sessions = await openApplication({
      directory,
      models,
      environments: async () => environments,
      cwd: directory,
      settings: {
        retry: { maxRetries: 0 },
        compaction: { keepRecentTokens: 0, backgroundTokens: 0 },
        progress: { partialIntervalMs: 0, outputIntervalMs: 0 },
      },
    });
    owners.add(sessions);
    return sessions;
  };
  const sessions = await open();
  t.after(async () => {
    await Promise.all([...owners].map((owner) => owner.close()));
    await rm(directory, { recursive: true, force: true });
  });
  const selection = { model: "faux/first", thinking: "off", cwd: directory, environment: "local" };
  return { sessions, faux, models, directory, selection, environments, open };
}

export async function fixture(t: TestContext) {
  const result = await sessionsFixture(t);
  const app = await result.sessions.open(decode(SessionId, "test"));
  return {
    ...result,
    app,
    database: join(
      result.directory,
      "sessions",
      Buffer.from(app.id).toString("base64url"),
      "store.sqlite",
    ),
    async open() {
      await result.sessions.close();
      return (await result.open()).open(decode(SessionId, "test"));
    },
  };
}
