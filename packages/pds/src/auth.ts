/**
 * Owner-scoped PDS model auth; pi-ai owns provider protocols and error wrapping.
 *
 * PDS -> pi-ai Models -> this CredentialStore --+
 *                                               +-> realpath lock -> auth.json
 * Pi CLI file backend --------------------------+
 *
 * Read:   lock -> guard -> load -> guard -> unlock -> result.
 * Modify: lock -> guard -> load -> callback -> guard -> persist -> guard -> unlock.
 * Logout uses the same lock and persistence path, removing only its provider.
 * No credential cache: each operation observes the shared file afresh.
 * Pi-compatible paths and records preserve opaque fields and unrelated providers.
 * OAuth and literal API keys are supported; executable/template keys are not.
 * Lock waits are cancellable. pi-ai shields started refresh through persistence.
 * Refresh failures preserve the stored credential and allow retry.
 * Native errors and causes reach the owner unchanged by this store.
 * Writes retain the existing inode/access; CLI interoperability is not crash-atomic.
 */
import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import lockfile from "proper-lockfile";
import type * as A from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

export function hostModels(
  path = join(
    normalizePath(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi/agent")),
    "auth.json",
  ),
  authContext?: A.AuthContext,
) {
  return builtinModels({
    credentials: credentialStore(normalizePath(path)),
    ...(authContext ? { authContext } : {}),
  });
}

function normalizePath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return resolve(path.startsWith("file://") ? fileURLToPath(path) : path);
}

class NotImplementedError extends Error {
  override readonly name = "NotImplementedError";
}

function credentialStore(path: string): A.CredentialStore {
  async function locked<T>(
    fn: (file: string, guard: () => Promise<void>) => Promise<T>,
    options?: A.AuthOperationOptions,
  ) {
    options?.signal?.throwIfAborted();
    const file = await ensureFile(path);
    const deadline = Date.now() + 30_000;
    let retry = 0;
    let compromised: Error | undefined;
    let release: () => Promise<void>;
    while (true) {
      options?.signal?.throwIfAborted();
      try {
        release = await lockfile.lock(file, {
          retries: 0,
          stale: 30_000,
          // CLI synchronous readers use the library's shorter 10s stale window.
          update: 5_000,
          onCompromised(error) {
            // Report heartbeat failures through the operation, not an unhandled timer throw.
            compromised = error;
          },
        });
        break;
      } catch (error) {
        const remaining = deadline - Date.now();
        if (!hasCode(error, "ELOCKED") || remaining <= 0) throw error;
        // Match the CLI's bounded jitter; catalog reads contend for this same file.
        const base = Math.min(10 * 2 ** retry++, 1_000);
        await sleep(
          Math.min(Math.round(base * (1 + Math.random())), remaining),
          undefined,
          options,
        );
      }
    }
    async function guard() {
      if (compromised) throw compromised;
      if (!(await lockfile.check(file, { stale: 30_000 }))) {
        throw new Error("Model credential storage lock is no longer held.");
      }
    }
    try {
      options?.signal?.throwIfAborted();
      // Reject lock loss before touching the shared records.
      await guard();
      const result = await fn(file, guard);
      // Do not return credentials after losing the lock during the operation.
      await guard();
      return result;
    } finally {
      // A compromised lock is no longer ours to release.
      if (!compromised) await release();
    }
  }
  async function load(path: string) {
    const content = await readFile(path, "utf8");
    // U+FEFF is a leading byte-order mark; Pi's file reader strips it too.
    const value: unknown = JSON.parse(content.replace(/^\uFEFF/, ""));
    if (!object(value)) throw new Error("Invalid credential file");
    const data = new Map<string, A.Credential>();
    for (const [providerId, entry] of Object.entries(value)) {
      if (!credential(entry)) throw new Error("Invalid credential record");
      data.set(providerId, entry);
    }
    return data;
  }
  return {
    read(providerId, options) {
      return locked(async (file) => {
        const value = (await load(file)).get(providerId);
        if (value?.type === "api_key" && value.key !== undefined && isExpression(value.key)) {
          throw new NotImplementedError("Credential expressions are not supported by PDS.");
        }
        return value;
      }, options);
    },
    list(options) {
      return locked(
        async (file) =>
          [...(await load(file))].map(([providerId, value]) => ({ providerId, type: value.type })),
        options,
      );
    },
    modify(providerId, fn, options) {
      return locked(async (file, guard) => {
        const data = await load(file);
        options?.signal?.throwIfAborted();
        // Hold the lock across pi-ai's callback so rotating refresh cannot race another writer.
        const next = await fn(data.get(providerId));
        options?.signal?.throwIfAborted();
        if (next !== undefined) {
          data.set(providerId, next);
          // Recheck lock health before persisting a potentially slow refresh.
          await guard();
          options?.signal?.throwIfAborted();
          await persist(file, data);
        }
        return data.get(providerId);
      }, options);
    },
    delete(providerId, options) {
      return locked(async (file, guard) => {
        const data = await load(file);
        data.delete(providerId);
        // Refuse deletion if the lock was lost while loading the file.
        await guard();
        options?.signal?.throwIfAborted();
        await persist(file, data);
      }, options);
    },
  };
}

async function persist(path: string, data: Map<string, A.Credential>): Promise<void> {
  const content = JSON.stringify(Object.fromEntries(data), null, 2);
  // Match Pi's in-place writes to retain inode, ownership, and permissions.
  const file = await open(path, "r+");
  try {
    await file.writeFile(content);
    await file.truncate(Buffer.byteLength(content));
    await file.sync();
  } finally {
    await file.close();
  }
}

async function ensureFile(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // Publish a complete empty file without replacing a concurrent creator's data.
  const temporary = join(dirname(path), `.auth-${randomUUID()}`);
  await writeFile(temporary, "{}", { flag: "wx", mode: 0o600 });
  try {
    try {
      await link(temporary, path);
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
    }
  } finally {
    await unlink(temporary);
  }
  return realpath(path);
}

function isExpression(key: string): boolean {
  if (key.startsWith("!")) return true;
  // Match braced segments whole: CLI treats invalid ${...} names as literals,
  // including any nested $ syntax. Its $$ and $! escapes are not literal keys.
  for (const match of key.matchAll(/\$\{([^}]*)\}|\$([A-Za-z_$!])/g)) {
    const name = match[1];
    if (match[2] !== undefined || (name !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)))
      return true;
  }
  return false;
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function credential(value: unknown): value is A.Credential {
  if (!object(value)) return false;
  if (value.type === "oauth") {
    return (
      typeof value.access === "string" &&
      typeof value.refresh === "string" &&
      typeof value.expires === "number" &&
      Number.isFinite(value.expires)
    );
  }
  return (
    value.type === "api_key" &&
    (value.key === undefined || typeof value.key === "string") &&
    (value.env === undefined ||
      (object(value.env) && Object.values(value.env).every((entry) => typeof entry === "string")))
  );
}
