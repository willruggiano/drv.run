import { stat } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { DrvRunEnv } from "harness";
import { listInstances, type Options } from "./instances.ts";
import {
  Environment,
  Sessions,
  SessionError,
  type ExecutionBinding,
  type SessionOptions,
} from "./sessions.ts";

/** Standard server application; custom applications may supply Sessions directly to httpServer. */
export type ApplicationOptions = Omit<SessionOptions, "close"> & {
  cwd: string;
  local?: boolean;
  drvRun?: Options;
};
export async function openApplication(options: ApplicationOptions) {
  const cwd = resolve(options.cwd);
  const environments = new Map<string, NodeExecutionEnv | DrvRunEnv>();
  async function resolveEnvironment({ provider, target, cwd }: ExecutionBinding, context: Context) {
    context.abortSignal?.throwIfAborted();
    const key = JSON.stringify([provider, target, cwd]);
    if (provider === "local" && options.local !== false) {
      if (!isAbsolute(target) || !cwd || !isAbsolute(cwd))
        throw new SessionError("invalid", "Invalid local directory.");
      const directory = await stat(cwd).catch(() => undefined);
      context.abortSignal?.throwIfAborted();
      if (!directory?.isDirectory())
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
      !(await listInstances(options.drvRun, context.abortSignal)).some(
        (instance) => instance.id === target && instance.running,
      )
    )
      throw new SessionError("unavailable", "Instance is not running or no longer exists.");
    context.abortSignal?.throwIfAborted();
    let env = environments.get(key);
    if (!env) {
      env = new DrvRunEnv({ ...options.drvRun, instance: target, cwd });
      environments.set(key, env);
    }
    context.abortSignal?.throwIfAborted();
    return env;
  }
  return Sessions.open({
    ...options,
    async targets(context) {
      context.abortSignal?.throwIfAborted();
      if (options.targets) return options.targets(context);
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
        for (const instance of await listInstances(options.drvRun, context.abortSignal))
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
      return resolveEnvironment(
        {
          provider: selected.provider,
          target: selected.target,
          cwd: target.cwd ?? "",
        },
        context,
      );
    },
    async close() {
      const results = await Promise.allSettled(
        [...environments.values()].map((env) => env.cleanup(BACKGROUND_CONTEXT)),
      );
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    },
  });
}
