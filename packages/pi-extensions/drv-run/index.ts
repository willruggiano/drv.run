import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineExtension, section } from "@earendil-works/pi-durable";
import { RemoteExecutionEnv, sshConnection } from "@earendil-works/pi-env";
import { SessionError, stateDirectory, type Integration } from "../../pi-runtime/index.ts";

const exec = promisify(execFile);
const instanceId = /^[a-zA-Z0-9]+$/;
export type Instance = { id: string; reference: string; running: boolean };
type Options = {
  stateDirectory: string;
  runtimeDirectory: string;
  systemctl?: string;
  ssh?: string;
  connect?: typeof sshConnection;
};

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function listInstances(options: Options): Promise<Instance[]> {
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
              await readFile(join(options.stateDirectory, "drv.run", id, "reference"), "utf8")
            ).trim();
          } catch (error) {
            if (isMissing(error)) return undefined;
            throw error;
          }
          const { stdout } = await exec(
            options.systemctl ?? "systemctl",
            ["--user", "show", `drv.run@${id}.service`, "--property=ActiveState", "--value"],
            { timeout: 10_000 },
          );
          let ready = false;
          try {
            ready = (
              await stat(join(options.runtimeDirectory, `drv.run.${id}`, "client.conf"))
            ).isFile();
          } catch (error) {
            if (!isMissing(error)) throw error;
          }
          return { id, reference, running: stdout.trim() === "active" && ready };
        }),
    )
  )
    .filter((item): item is Instance => item !== undefined)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function createDrvRunIntegration(options: Options): Integration {
  return {
    id: "drv.run",
    extensions: [
      defineExtension({
        name: "drv.run",
        sections: [
          section(
            "execution",
            () => "File and command tools run in the selected drv.run guest, in /workspace.",
          ),
        ],
      }),
    ],
    async targets() {
      return (await listInstances(options)).map((instance) => ({
        provider: "drv.run",
        target: instance.id,
        cwd: "/workspace",
        label: `${instance.id} · ${instance.reference}`,
        available: instance.running,
      }));
    },
    async validate(binding) {
      if (
        binding.provider !== "drv.run" ||
        !instanceId.test(binding.target) ||
        binding.cwd !== "/workspace"
      )
        throw new SessionError("invalid", "Invalid drv.run binding.");
      if (
        !(await listInstances(options)).some(
          (instance) => instance.id === binding.target && instance.running,
        )
      )
        throw new SessionError("unavailable", "Instance is not running or no longer exists.");
    },
    open(binding) {
      assert(
        binding.provider === "drv.run" &&
          instanceId.test(binding.target) &&
          binding.cwd === "/workspace",
      );
      const host = `drv.run.${binding.target}`;
      const runtime = join(options.runtimeDirectory, host);
      // Owner-scoped route and pinned key: no user SSH overrides or network key acceptance.
      const { connection } = (options.connect ?? sshConnection)({
        host,
        user: "root",
        ssh: options.ssh ?? "ssh",
        configFile: "/etc/ssh/ssh_config",
        identityFile: join(runtime, "client-key"),
        knownHostsFile: join(runtime, "known_hosts"),
        hostKeyAlias: host,
      });
      const env = new RemoteExecutionEnv({ connection, id: host, cwd: binding.cwd });
      return {
        env,
        async close() {
          try {
            await env.cleanup(BACKGROUND_CONTEXT);
          } finally {
            connection.close();
          }
        },
      };
    },
  };
}

export default function drvRun(): Integration {
  const uid = process.getuid?.();
  assert(uid !== undefined && uid !== 0, "Load drv.run as the instance owner, not root.");
  return createDrvRunIntegration({
    stateDirectory: stateDirectory(),
    runtimeDirectory: `/run/user/${uid}`,
  });
}
