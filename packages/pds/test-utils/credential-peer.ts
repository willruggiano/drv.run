import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import lockfile from "proper-lockfile";

const [path, mode = "cli"] = process.argv.slice(2);
assert(path);
assert(typeof process.send === "function");

if (mode !== "cli") {
  const { hostModels } = await import("../src/auth.ts");
  const models = hostModels(mode === "default" ? undefined : path, {
    env: async () => undefined,
    fileExists: async () => false,
  });
  if (mode === "login") {
    process.send({ state: "ready" });
    await once(process, "message");
    await models.login("anthropic", "api_key", {
      prompt: async () => "anthropic-first",
      notify() {},
    });
  }
  if (mode === "resolve") {
    const provider = models.getProvider("openai");
    assert(provider);
    models.setProvider({
      ...provider,
      auth: {
        oauth: {
          name: "Fixture OAuth",
          login: async () => {
            throw new Error("Unexpected login");
          },
          refresh: async () => {
            throw new Error("Duplicate rotating refresh");
          },
          toAuth: async (credential) => ({ apiKey: credential.access }),
        },
      },
    });
    process.send({ state: "ready" });
  }
  process.send({ state: "resolved", data: (await models.getAuth("openai"))?.auth });
  process.disconnect();
} else {
  // Pi CLI 1.5.2 FileAuthStorageBackend: realpath locking, 30s stale boundary,
  // and in-place read/modify/write. This branch does not import PDS storage.
  // https://unpkg.com/@earendil-works/pi-coding-agent@1.5.2/dist/core/auth-storage.js
  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(path, { retries: 0, stale: 30_000 });
    process.send({ state: "acquired", data: JSON.parse(await readFile(path, "utf8")) });
    const [replacement] = await once(process, "message");
    await writeFile(path, JSON.stringify(replacement, null, 2), { mode: 0o600 });
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ELOCKED") throw error;
    process.send({ state: "blocked" });
  } finally {
    await release?.();
    process.disconnect();
  }
}
