import assert from "node:assert/strict";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { serve } from "durable-api/serve";

export type DeploymentConfiguration = {
  readonly server: Omit<Parameters<typeof serve>[0], "routes" | "fetch" | "error">;
  readonly stateDirectory: string;
  readonly configDirectory: string;
  readonly runtimeDirectory: string;
  readonly instanceStateDirectory: string;
  readonly systemctl: string;
};

function absolute(name: string, value: string | undefined, fallback?: string): string {
  const path = value ?? fallback;
  if (!path || !isAbsolute(path)) throw new TypeError(`${name} must be an absolute path`);
  return resolve(path);
}

function port(value: string | undefined): number {
  if (value === undefined) return 8080;
  if (!/^[0-9]+$/.test(value)) throw new TypeError("PORT must be an integer from 1 to 65535");
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1 || result > 65535)
    throw new TypeError("PORT must be an integer from 1 to 65535");
  return result;
}

export function readDeploymentConfiguration(
  env: NodeJS.ProcessEnv = process.env,
  uid = process.getuid?.(),
  home = homedir(),
): DeploymentConfiguration {
  assert(uid !== undefined && uid !== 0, "Run the Durable API as an unprivileged user.");
  const runtimeDirectory = absolute("XDG_RUNTIME_DIR", env.XDG_RUNTIME_DIR, `/run/user/${uid}`);
  const configHome =
    env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME)
      ? env.XDG_CONFIG_HOME
      : join(home, ".config");
  const stateHome =
    env.XDG_STATE_HOME && isAbsolute(env.XDG_STATE_HOME)
      ? env.XDG_STATE_HOME
      : join(home, ".local/state");
  return {
    server: {
      host: env.HOST ?? "127.0.0.1",
      port: port(env.PORT),
    },
    stateDirectory: join(stateHome, "drv.run", "harness"),
    configDirectory: join(configHome, "drv.run"),
    runtimeDirectory,
    instanceStateDirectory: resolve(stateHome),
    systemctl: env.SYSTEMCTL ?? "systemctl",
  };
}
