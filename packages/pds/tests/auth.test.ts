import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import type * as A from "@earendil-works/pi-ai";
import { hostAuth } from "../src/auth.ts";

const noAmbient = { env: async () => undefined, fileExists: async () => false };
const expired: A.OAuthCredential = {
  type: "oauth",
  access: "old",
  refresh: "rotate-me",
  expires: 0,
};
const fresh = (): A.OAuthCredential => ({
  type: "oauth",
  access: "new",
  refresh: "rotated",
  expires: Date.now() + 3_600_000,
  opaque: { account: "fixture" },
});

function oauth(
  models: A.MutableModels,
  refresh: (current: A.OAuthCredential, signal: AbortSignal) => Promise<A.OAuthCredential>,
) {
  const provider = models.getProvider("openai");
  assert(provider);
  models.setProvider({
    ...provider,
    auth: {
      ...provider.auth,
      oauth: {
        name: "Fixture OAuth",
        login: async () => fresh(),
        refresh,
        toAuth: async (value) => ({ apiKey: value.access }),
      },
    },
  });
}

async function peer(t: TestContext, path: string, mode = "cli", env: Record<string, string> = {}) {
  const child = fork(new URL("../test-utils/credential-peer.ts", import.meta.url), [path, mode], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
    env,
    cwd: env.HOME ?? dirname(path),
  });
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await exited;
  });
  const [message] = await once(child, "message", { signal: AbortSignal.timeout(10_000) });
  return { child, message: message as { state: string; data?: unknown }, exited };
}

async function fixture(t: TestContext, filename = "auth.json") {
  const directory = await mkdtemp(join(tmpdir(), "pds-auth-"));
  const path = join(directory, filename);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const save = (value: unknown) => writeFile(path, JSON.stringify(value), { mode: 0o600 });
  const read = async (): Promise<unknown> => JSON.parse(await readFile(path, "utf8"));
  return {
    directory,
    path,
    save,
    read,
    models: hostAuth(path, noAmbient).models,
  };
}

await test("model requests observe shared file login, replacement, and logout without restarting", async (t) => {
  const f = await fixture(t);
  await f.save({ openai: { type: "api_key", key: "first" } });
  assert.equal((await f.models.getAuth("openai"))?.auth.apiKey, "first");
  assert((await f.models.getAvailable("openai")).length > 0);
  await f.save({ openai: { type: "api_key", key: "second" } });
  assert.equal((await f.models.getAuth("openai"))?.auth.apiKey, "second");
  await f.save({});
  // No ambient key is configured in this offline fixture.
  assert.equal(await f.models.getAuth("openai"), undefined);
});

await test("the complete native provider catalog can resolve shared-file availability", async (t) => {
  const f = await fixture(t);
  await f.save({ openai: { type: "api_key", key: "literal" } });
  const available = await f.models.getAvailable();
  assert(available.some((model) => model.provider === "openai"));
});

await test("native Codex inference observes CLI rotations and logout without holding storage during inference", async (t) => {
  const f = await fixture(t);
  const credential = (generation: number) => ({
    type: "oauth",
    access: `header.${Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": { chatgpt_account_id: "account-me" },
        generation,
      }),
    ).toString("base64url")}.signature`,
    refresh: "fixture-refresh",
    expires: Date.now() + 3_600_000,
    accountId: "account-me",
  });
  await f.save({ "openai-codex": credential(1) });
  const model = (await f.models.getAvailable("openai-codex"))[0];
  assert(model);
  assert(f.models.getProvider("openai-codex")?.auth.oauth);
  for (const generation of [1, 2]) {
    const result = await f.models.completeSimple(
      model,
      { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
      {
        transport: "sse",
        fetch: async (input, init) => {
          assert.equal(
            input instanceof Request ? input.url : input.toString(),
            "https://chatgpt.com/backend-api/codex/responses",
          );
          const headers = new Headers(init?.headers);
          assert.equal(headers.get("authorization"), `Bearer ${credential(generation).access}`);
          assert.equal(headers.get("chatgpt-account-id"), "account-me");
          const writer = await peer(t, f.path);
          assert.equal(writer.message.state, "acquired");
          writer.child.send(generation === 1 ? { "openai-codex": credential(2) } : {});
          assert.equal((await writer.exited)[0], 0);
          return new Response(
            `data: ${JSON.stringify({
              type: "response.completed",
              response: {
                status: "completed",
                usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
              },
            })}\n\n`,
            { headers: { "Content-Type": "text/event-stream" } },
          );
        },
      },
    );
    assert.equal(result.stopReason, "stop");
  }
  assert.equal(await f.models.getAuth("openai-codex"), undefined);
  assert.deepEqual(await f.models.getAvailable("openai-codex"), []);
});

await test("default shared credential selection honors the CLI home and agent-directory override", async (t) => {
  const f = await fixture(t);
  const defaultDirectory = join(f.directory, ".pi/agent");
  const overrideDirectory = join(f.directory, "selected");
  await mkdir(defaultDirectory, { recursive: true });
  await mkdir(overrideDirectory);
  await writeFile(
    join(defaultDirectory, "auth.json"),
    JSON.stringify({ openai: { type: "api_key", key: "default" } }),
  );
  await writeFile(
    join(overrideDirectory, "auth.json"),
    JSON.stringify({ openai: { type: "api_key", key: "selected" } }),
  );
  for (const [override, key] of [
    ["", "default"],
    ["~/selected", "selected"],
    ["selected", "selected"],
    [pathToFileURL(overrideDirectory).href, "selected"],
  ]) {
    assert(override !== undefined && key !== undefined);
    const reader = await peer(t, f.path, "default", {
      HOME: f.directory,
      PI_CODING_AGENT_DIR: override,
    });
    assert.equal(reader.message.state, "resolved");
    assert.deepEqual(reader.message.data, { apiKey: key });
    assert.equal((await reader.exited)[0], 0);
  }
});

await test("storage failures preserve diagnostics without stale credentials or ambient fallback", async (t) => {
  const f = await fixture(t);
  const { models } = hostAuth(f.path, { ...noAmbient, env: async () => "ambient-must-not-win" });
  await f.save({ openai: { type: "api_key", key: "stored" } });
  assert.equal((await models.getAuth("openai"))?.auth.apiKey, "stored");
  for (const [data, failureType] of [
    ["secret-not-json", SyntaxError],
    ["", SyntaxError],
    ["[]", Error],
    ["null", Error],
    ['{"openai":{"type":"oauth","access":17}}', Error],
  ] as const) {
    const failure = (error: unknown) => {
      assert(error instanceof Error && "code" in error);
      assert.equal(error.code, "auth");
      assert(error.cause instanceof Error);
      assert.equal(error.cause.constructor, failureType);
      return true;
    };
    await writeFile(f.path, data);
    const before = await readFile(f.path);
    await assert.rejects(models.getAuth("openai"), failure);
    await assert.rejects(models.getAvailable("openai"), failure);
    assert.deepEqual(await readFile(f.path), before);
  }
  await rename(f.path, join(f.directory, "old"));
  await mkdir(f.path);
  await assert.rejects(models.getAuth("openai"), (error: unknown) => {
    assert(error instanceof Error && "code" in error);
    assert.equal(error.code, "auth");
    assert(error.cause instanceof Error && "code" in error.cause);
    assert.equal(error.cause.code, "EISDIR");
    return true;
  });
});

await test("CLI JSON with a BOM preserves opaque records and existing file ownership and modes", async (t) => {
  const f = await fixture(t);
  const unrelated = { ...fresh(), opaque: { account: "kept", extension: [1, 2] } };
  await writeFile(
    f.path,
    "\uFEFF" + JSON.stringify({ openai: { type: "api_key", key: "literal" }, unrelated }),
  );
  await chmod(f.path, 0o640);
  const before = await stat(f.path);
  assert.equal((await f.models.getAuth("openai"))?.auth.apiKey, "literal");
  await f.models.logout("openai");
  assert.deepEqual(await f.read(), { unrelated });
  const after = await stat(f.path);
  assert.equal(after.mode, before.mode);
  assert.equal(after.ino, before.ino);
  assert.equal(after.uid, before.uid);
  assert.equal(after.gid, before.gid);
});

await test("credential resolution rejects expressions and escapes without evaluating unrelated records", async (t) => {
  const f = await fixture(t);
  const unrelated = { type: "api_key", key: "!not-a-command-to-run", extra: { opaque: true } };
  for (const key of [
    "!not-a-command-to-run",
    "$TOKEN",
    "${TOKEN}",
    "prefix-$TOKEN",
    "$$TOKEN",
    "$!literal",
  ]) {
    await f.save({ openai: { type: "api_key", key }, unrelated });
    await assert.rejects(f.models.getAuth("openai"), (error: unknown) => {
      assert(error instanceof Error && "code" in error);
      assert.equal(error.code, "auth");
      assert(error.cause instanceof Error);
      assert.equal(error.cause.name, "NotImplementedError");
      return true;
    });
  }
  for (const literal of ["literal-$9-${not-a-variable}", "${not-${VARIABLE}}", "${bad-$!x}"]) {
    await f.models.login("openai", "api_key", { prompt: async () => literal, notify() {} });
    assert.equal((await f.models.getAuth("openai"))?.auth.apiKey, literal);
    assert.deepEqual(await f.read(), { openai: { type: "api_key", key: literal }, unrelated });
  }
  await f.models.logout("openai");
  assert.deepEqual(await f.read(), { unrelated });
});

await test("concurrent first logins create owner-only storage without losing either provider", async (t) => {
  const f = await fixture(t, "new/agent/auth.json");
  const other = await peer(t, f.path, "login", { HOME: f.directory });
  assert.equal(other.message.state, "ready");
  const login = f.models.login("openai", "api_key", {
    prompt: async () => "openai-first",
    notify() {},
  });
  other.child.send("start");
  await login;
  assert.equal((await other.exited)[0], 0);
  assert.equal((await f.models.getAuth("openai"))?.auth.apiKey, "openai-first");
  assert.equal((await f.models.getAuth("anthropic"))?.auth.apiKey, "anthropic-first");
  assert.deepEqual(await f.read(), {
    openai: { type: "api_key", key: "openai-first" },
    anthropic: { type: "api_key", key: "anthropic-first" },
  });
  assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  assert.equal((await stat(dirname(f.path))).mode & 0o777, 0o700);
  assert.equal((await stat(dirname(dirname(f.path)))).mode & 0o777, 0o700);
});

await test("refresh failures preserve provider errors and stored credentials for retry", async (t) => {
  const f = await fixture(t);
  await f.save({ openai: expired });
  let attempts = 0;
  const replacement = fresh();
  const failure = new Error("provider-response-with-fixture-secret", {
    cause: new Error("underlying provider failure"),
  });
  oauth(f.models, async () => {
    if (++attempts === 1) throw failure;
    return replacement;
  });
  await assert.rejects(f.models.getAuth("openai"), (error: unknown) => {
    assert(error instanceof Error && "code" in error);
    assert.equal(error.code, "oauth");
    assert.equal(error.cause, failure);
    return true;
  });
  assert.deepEqual(await f.read(), { openai: expired });
  assert.equal((await f.models.getAuth("openai"))?.auth.apiKey, replacement.access);
  assert.equal(attempts, 2);
  assert.deepEqual(await f.read(), { openai: replacement });
});

await test("a cancelled login cannot write after a CLI holder releases the file", async (t) => {
  const f = await fixture(t);
  const original = { openai: { type: "api_key", key: "old" } };
  await f.save(original);
  const holder = await peer(t, f.path);
  assert.equal(holder.message.state, "acquired");
  const prompted = Promise.withResolvers<void>();
  const controller = new AbortController();
  const login = f.models.login("openai", "api_key", {
    signal: controller.signal,
    prompt: async () => {
      prompted.resolve();
      return "replacement";
    },
    notify() {},
  });
  await prompted.promise;
  controller.abort();
  await assert.rejects(login, { name: "AbortError" });
  holder.child.send(original);
  assert.equal((await holder.exited)[0], 0);
  assert.equal((await f.models.getAuth("openai"))?.auth.apiKey, "old");
  assert.deepEqual(await f.read(), original);
});

await test("caller cancellation does not discard a rotating refresh and concurrent resolution reuses it", async (t) => {
  const f = await fixture(t);
  await f.save({ openai: expired });
  const entered = Promise.withResolvers<AbortSignal>();
  const finish = Promise.withResolvers<A.OAuthCredential>();
  const replacement = fresh();
  t.after(() => finish.resolve(replacement));
  oauth(f.models, async (_current, signal) => {
    entered.resolve(signal);
    return finish.promise;
  });
  const controller = new AbortController();
  const request = f.models.getAuth("openai", { signal: controller.signal });
  const refreshSignal = await entered.promise;
  controller.abort();
  await assert.rejects(request, { name: "AbortError" });
  assert.equal(refreshSignal.aborted, false);
  const other = await peer(t, f.path, "resolve");
  assert.equal(other.message.state, "ready");
  const resolved = once(other.child, "message");
  finish.resolve(replacement);
  assert.deepEqual((await resolved)[0], {
    state: "resolved",
    data: { apiKey: replacement.access },
  });
  assert.equal((await other.exited)[0], 0);
  assert.deepEqual(await f.read(), { openai: replacement });
});

await test("logout serializes behind refresh and cannot be undone by its late result", async (t) => {
  const f = await fixture(t);
  await f.save({ openai: expired });
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<A.OAuthCredential>();
  t.after(() => finish.resolve(fresh()));
  oauth(f.models, async () => {
    entered.resolve();
    return finish.promise;
  });
  const request = f.models.getAuth("openai");
  await entered.promise;
  const logout = f.models.logout("openai");
  finish.resolve(fresh());
  await Promise.all([request, logout]);
  assert.deepEqual(await f.read(), {});
  assert.equal(await f.models.getAuth("openai"), undefined);
});

await test("a refresh persistence failure prevents issuance and permits a later retry", async (t) => {
  const f = await fixture(t);
  const previous = join(f.directory, "previous.json");
  await f.save({ openai: expired });
  let attempts = 0;
  oauth(f.models, async () => {
    if (++attempts === 1) {
      await rename(f.path, previous);
      await mkdir(f.path);
    }
    return fresh();
  });
  await assert.rejects(f.models.getAuth("openai"), { code: "auth" });
  assert.deepEqual(JSON.parse(await readFile(previous, "utf8")), { openai: expired });
  await rm(f.path, { recursive: true });
  await rename(previous, f.path);
  assert.equal((await f.models.getAuth("openai"))?.auth.apiKey, "new");
  assert.equal(attempts, 2);
});

await test("a compromised refresh lock cannot publish or persist returned credentials", async (t) => {
  const f = await fixture(t);
  await f.save({ openai: expired });
  oauth(f.models, async () => {
    await rm(f.path + ".lock", { recursive: true });
    return fresh();
  });
  await assert.rejects(f.models.getAuth("openai"), { code: "auth" });
  assert.deepEqual(await f.read(), { openai: expired });
});

await test("rotating refresh excludes a CLI-protocol writer through a symlink alias", async (t) => {
  const f = await fixture(t);
  const alias = join(f.directory, "alias.json");
  await f.save({ openai: expired });
  await symlink(f.path, alias);
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<A.OAuthCredential>();
  t.after(() => finish.resolve(fresh()));
  oauth(f.models, async (current) => {
    assert.deepEqual(current, expired);
    entered.resolve();
    return finish.promise;
  });
  const request = f.models.getAuth("openai");
  await entered.promise;
  const contender = await peer(t, alias);
  assert.equal(contender.message.state, "blocked");
  const replacement = fresh();
  finish.resolve(replacement);
  assert.equal((await request)?.auth.apiKey, "new");
  assert.deepEqual(await f.read(), { openai: replacement });
  const writer = await peer(t, alias);
  assert.equal(writer.message.state, "acquired");
  assert.deepEqual(writer.message.data, { openai: replacement });
  writer.child.send({ other: { type: "api_key", key: "unrelated" } });
  assert.equal((await writer.exited)[0], 0);
  assert.equal(await f.models.getAuth("openai"), undefined);
});
