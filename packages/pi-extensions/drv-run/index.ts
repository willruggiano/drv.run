import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { sshConnection } from "@earendil-works/pi-env";
import { SessionError, stateDirectory } from "../../pi-runtime/index.ts";

const exec = promisify(execFile);
const instanceId = /^[a-zA-Z0-9]+$/;
export type Instance = { id: string; reference: string; running: boolean };
export type Options = {
  stateDirectory: string;
  runtimeDirectory: string;
  systemctl?: string;
  ssh?: string;
  connect?: typeof sshConnection;
};

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function listInstances(options: Options, signal?: AbortSignal): Promise<Instance[]> {
  signal?.throwIfAborted();
  let names: string[];
  try {
    names = await readdir(join(options.stateDirectory, "drv.run"));
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  return (
    await Promise.all(
      names
        .filter((name) => instanceId.test(name))
        .map(async (id) => {
          let reference: string;
          try {
            reference = (
              await readFile(join(options.stateDirectory, "drv.run", id, "reference"), {
                encoding: "utf8",
                signal,
              })
            ).trim();
          } catch (error) {
            if (isMissing(error)) return undefined;
            throw error;
          }
          const { stdout } = await exec(
            options.systemctl ?? "systemctl",
            ["--user", "show", `drv.run@${id}.service`, "--property=ActiveState", "--value"],
            { timeout: 10_000, signal },
          );
          let ready = false;
          try {
            ready = (
              await stat(join(options.runtimeDirectory, `drv.run.${id}`, "client.conf"))
            ).isFile();
          } catch (error) {
            if (!isMissing(error)) throw error;
          }
          signal?.throwIfAborted();
          return { id, reference, running: stdout.trim() === "active" && ready };
        }),
    )
  )
    .filter((item): item is Instance => item !== undefined)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Owner-scoped discovery and SSH routing; callers own the returned pi-env connection. */
export async function connectInstance(options: Options, id: string) {
  if (!instanceId.test(id)) throw new SessionError("invalid", "Invalid drv.run instance.");
  if (!(await listInstances(options)).some((instance) => instance.id === id && instance.running))
    throw new SessionError("unavailable", "Instance is not running or no longer exists.");
  const host = `drv.run.${id}`;
  const runtime = join(options.runtimeDirectory, host);
  return (options.connect ?? sshConnection)({
    host,
    user: "root",
    ssh: options.ssh ?? "ssh",
    configFile: "/etc/ssh/ssh_config",
    identityFile: join(runtime, "client-key"),
    knownHostsFile: join(runtime, "known_hosts"),
    hostKeyAlias: host,
  }).connection;
}

export function ownerOptions(): Options {
  const uid = process.getuid?.();
  assert(uid !== undefined && uid !== 0, "Run drv.run as the instance owner, not root.");
  return { stateDirectory: stateDirectory(), runtimeDirectory: `/run/user/${uid}` };
}
