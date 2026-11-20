import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request } from "node:http";
import { serve } from "../src/server.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { hostAuth } from "../src/auth.ts";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { openApplication, type Application } from "../src/application.ts";
import type { EnvTarget } from "../src/harness/env.ts";
import { SessionId, decode } from "../src/identity.ts";

export const form = (fields: Record<string, string>): FormData => {
  const result = new FormData();
  for (const [key, value] of Object.entries(fields)) result.set(key, value);
  return result;
};

export async function knownHostsFixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "pds-known-hosts-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

export async function sessionsFixture(t: TestContext, discover?: () => Promise<EnvTarget[]>) {
  const directory = await mkdtemp(join(tmpdir(), "pds-"));
  const faux = fauxProvider({
    models: [
      { id: "first", reasoning: true, input: ["text", "image"] },
      { id: "second", reasoning: false, input: ["text"] },
    ],
    tokensPerSecond: 200,
    tokenSize: { min: 4, max: 4 },
  });
  const auth = hostAuth(join(directory, "auth.json"), {
    env: async () => undefined,
    fileExists: async () => false,
  });
  const { models } = auth;
  models.clearProviders();
  models.setProvider(faux.provider);
  const environments: EnvTarget[] = [{ type: "local" }, { type: "ssh", host: "test-guest" }];
  const owners = new Set<Application>();
  const open = async () => {
    const sessions = await openApplication({
      directory,
      models,
      environments: discover ?? (async () => environments),
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
    await auth.close();
    await Promise.all([...owners].map((owner) => owner.close()));
    await rm(directory, { recursive: true, force: true });
  });
  const selection = { model: "faux/first", thinking: "off", cwd: directory, env: "local" };
  return { sessions, auth, faux, models, directory, selection, open };
}

export async function fixture(t: TestContext, discover?: Parameters<typeof sessionsFixture>[1]) {
  const result = await sessionsFixture(t, discover);
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
    async open(this: void) {
      await result.sessions.close();
      return (await result.open()).open(decode(SessionId, "test"));
    },
  };
}

export async function authFixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "pds-login-"));
  const path = join(directory, "auth.json");
  const auth = hostAuth(path, { env: async () => undefined, fileExists: async () => false });
  const sessions = await openApplication({
    directory,
    models: auth.models,
    environments: async () => [],
    cwd: directory,
  });
  t.after(async () => {
    await auth.close();
    await sessions.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { auth, sessions, directory, path };
}

export async function servePrefixed(
  t: TestContext,
  sessions: Application,
  auth: ReturnType<typeof hostAuth>,
  prefix: string,
) {
  let upstream: URL | undefined;
  const proxy = createServer((incoming, outgoing) => {
    assert(upstream && incoming.url);
    const forwarded = request(
      new URL(incoming.url, upstream),
      { method: incoming.method, headers: incoming.headers },
      (response) => {
        outgoing.writeHead(response.statusCode!, response.headers);
        response.pipe(outgoing);
      },
    );
    forwarded.on("error", () => outgoing.destroy());
    outgoing.once("close", () => forwarded.destroy());
    incoming.pipe(forwarded);
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const address = proxy.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}${prefix}/`;
  const server = await serve(sessions, { auth, port: 0, origin: base });
  upstream = new URL(server.origin);
  t.after(async () => {
    proxy.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      proxy.close((error) => (error ? reject(error) : resolve())),
    );
    await server.close();
  });
  return base;
}
