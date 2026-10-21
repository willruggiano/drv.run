import { stat } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { RemoteExecutionEnv, type Connection } from "@earendil-works/pi-env";
import { connectInstance, listInstances, type Options } from "../pi-extensions/drv-run/index.ts";
import { openCodingSessions } from "../pi-runtime/coding.ts";
import {
  Environment,
  SessionError,
  type ExecutionBinding,
  type SessionOptions,
} from "../pi-runtime/index.ts";

/** Standard server application; custom applications may supply Sessions directly to httpServer. */
export type ApplicationOptions = Omit<SessionOptions, "open" | "close"> & {
  cwd: string;
  local?: boolean;
  drvRun?: Options;
};
export async function openApplication(options: ApplicationOptions) {
  const cwd = resolve(options.cwd);
  const connections = new Map<string, Promise<Connection>>();
  const environments = new Map<string, NodeExecutionEnv | RemoteExecutionEnv>();
  async function resolveEnvironment({ provider, target, cwd }: ExecutionBinding) {
    const key = JSON.stringify([provider, target, cwd]);
    if (provider === "local" && options.local !== false) {
      if (!isAbsolute(target) || !cwd || !isAbsolute(cwd))
        throw new SessionError("invalid", "Invalid local directory.");
      if (!(await stat(cwd).catch(() => undefined))?.isDirectory())
        throw new SessionError("unavailable", `Local directory is unavailable: ${cwd}`);
      let env = environments.get(key);
      if (!env) {
        env = new NodeExecutionEnv({ cwd });
        environments.set(key, env);
      }
      return env;
    }
    if (provider !== "drv.run" || !options.drvRun)
      throw new SessionError("unavailable", `Execution provider is unavailable: ${provider}`);
    if (!cwd || !isAbsolute(cwd)) throw new SessionError("invalid", "Invalid guest directory.");
    if (
      !(await listInstances(options.drvRun)).some(
        (instance) => instance.id === target && instance.running,
      )
    )
      throw new SessionError("unavailable", "Instance is not running or no longer exists.");
    let opening = connections.get(target);
    if (!opening) {
      opening = connectInstance(options.drvRun, target);
      connections.set(target, opening);
    }
    let connection: Connection;
    try {
      connection = await opening;
    } catch (error) {
      connections.delete(target);
      throw error;
    }
    let env = environments.get(key);
    if (!env) {
      env = new RemoteExecutionEnv({ connection, id: `drv.run.${target}`, cwd });
      environments.set(key, env);
    }
    return env;
  }
  return openCodingSessions({
    ...options,
    async targets() {
      if (options.targets) return options.targets();
      const targets = [];
      if (options.local !== false)
        targets.push({
          provider: "local",
          target: cwd,
          cwd,
          label: `Local · ${cwd}`,
          available: (await stat(cwd).catch(() => undefined))?.isDirectory() ?? false,
        });
      if (options.drvRun)
        for (const instance of await listInstances(options.drvRun))
          targets.push({
            provider: "drv.run",
            target: instance.id,
            cwd: "/workspace",
            directoryRoot: "/workspace",
            label: `${instance.id} · ${instance.reference}`,
            available: instance.running,
          });
      return targets;
    },
    directoryEnv: options.directoryEnv ?? resolveEnvironment,
    async env(target, context) {
      if (options.env) return options.env(target, context);
      const selected = await target.read.snapshot(Environment, target.conversationId, context);
      if (!selected?.provider || !selected.target) return undefined;
      return resolveEnvironment({
        provider: selected.provider,
        target: selected.target,
        cwd: target.cwd ?? "",
      });
    },
    async close() {
      try {
        const results = await Promise.allSettled(
          [...environments.values()].map((env) => env.cleanup(BACKGROUND_CONTEXT)),
        );
        const failed = results.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      } finally {
        for (const opening of connections.values()) {
          const connection = await opening.catch(() => undefined);
          connection?.close();
        }
      }
    },
  });
}
