import { isAbsolute } from "node:path";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { DrvRunEnv } from "harness";
import { listInstances, type Options } from "./instances.ts";
import {
  Environment,
  Sessions,
  SessionError,
  type ExecutionBinding,
  type SessionOptions,
} from "./sessions.ts";

/** Server application backed by drv.run instances. */
export type ApplicationOptions = Omit<SessionOptions, "close"> & {
  drvRun: Options;
};
export async function openApplication(options: ApplicationOptions) {
  const environments = new Map<string, DrvRunEnv>();
  async function resolveEnvironment({ provider, target, cwd }: ExecutionBinding, context: Context) {
    context.abortSignal?.throwIfAborted();
    const key = JSON.stringify([provider, target, cwd]);
    if (provider !== "drv.run")
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
