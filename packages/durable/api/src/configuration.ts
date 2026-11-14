import Type from "typebox";
import Value from "typebox/value";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { PushConfiguration } from "./push.ts";
import { OAuthServers } from "./accounts.ts";
import type { serve } from "durable-api/serve";

export type DeploymentConfiguration = {
  readonly server: Omit<Parameters<typeof serve>[0], "routes" | "fetch" | "error">;
  readonly stateDirectory: string;
  readonly configDirectory: string;
  readonly runtimeDirectory: string;
  readonly instanceStateDirectory: string;
  readonly systemctl: string;
  readonly push: PushConfiguration | undefined;
  readonly origin: string | undefined;
  readonly oauthServers: Type.Static<typeof OAuthServers>;
};

function absolute(name: string, value: string | undefined, fallback?: string): string {
  const path = value ?? fallback;
  if (!path || !isAbsolute(path)) throw new TypeError(`${name} must be an absolute path`);
  return resolve(path);
}

const Port = Type.Integer({ minimum: 0, maximum: 65535 });

export function readDeploymentConfiguration(
  env: NodeJS.ProcessEnv = process.env,
  uid = process.getuid?.(),
  home = homedir(),
): DeploymentConfiguration {
  const port = Number(env.PORT ?? 8080);
  if (!Value.Check(Port, port)) throw new TypeError("Invalid PORT");
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
      port,
    },
    stateDirectory: join(stateHome, "drv.run", "harness"),
    configDirectory: join(configHome, "drv.run"),
    runtimeDirectory,
    instanceStateDirectory: resolve(stateHome),
    systemctl: env.SYSTEMCTL ?? "systemctl",
    origin: env.ORIGIN,
    push:
      env.VAPID_PRIVATE_KEY_FILE === undefined
        ? undefined
        : {
            origins: Value.Parse(Type.Array(Type.String()), JSON.parse(env.PUSH_ORIGINS ?? "[]")),
            subject: env.VAPID_SUBJECT ?? "",
            privateKeyFile: env.VAPID_PRIVATE_KEY_FILE,
          },
    oauthServers: Value.Parse(OAuthServers, JSON.parse(env.OAUTH_SERVERS ?? "[]")),
  };
}
