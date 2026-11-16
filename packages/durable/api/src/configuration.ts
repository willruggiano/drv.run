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
  readonly systemctl: string;
  readonly wwwDirectory: string | undefined;
  readonly parallelApiKeyFile: string | undefined;
  readonly push: PushConfiguration | undefined;
  readonly origin: string | undefined;
  readonly oauthServers: Type.Static<typeof OAuthServers>;
};

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
  const origin = env.ORIGIN;
  if (origin !== undefined && https(origin).origin !== origin)
    throw new TypeError("ORIGIN must be an HTTPS origin");
  const oauthServers: unknown = JSON.parse(env.OAUTH_SERVERS ?? "[]");
  Value.Assert(OAuthServers, oauthServers);
  const ids = new Set<string>();
  for (const server of oauthServers) {
    if (ids.has(server.id)) throw new TypeError("Duplicate OAuth server id");
    ids.add(server.id);
    for (const [key, value] of Object.entries(server.metadata))
      if (key !== "grant_types_supported") https(String(value));
    if (server.clientSecretFile !== undefined)
      server.clientSecretFile = secretFile("OAuth clientSecretFile", server.clientSecretFile);
    if (
      server.metadata.grant_types_supported.includes("authorization_code") &&
      (!origin || !server.metadata.authorization_endpoint)
    )
      throw new TypeError("Authorization-code grants require ORIGIN and authorization_endpoint");
    if (
      server.metadata.grant_types_supported.includes(
        "urn:ietf:params:oauth:grant-type:device_code",
      ) &&
      !server.metadata.device_authorization_endpoint
    )
      throw new TypeError("Device grants require device_authorization_endpoint");
  }
  let push: PushConfiguration | undefined;
  if (
    [env.PUSH_ORIGINS, env.VAPID_SUBJECT, env.VAPID_PRIVATE_KEY_FILE].some(
      (value) => value !== undefined,
    )
  ) {
    const origins: unknown = JSON.parse(env.PUSH_ORIGINS ?? "null");
    Value.Assert(Type.Array(Type.String(), { minItems: 1, uniqueItems: true }), origins);
    for (const value of origins)
      if (https(value).origin !== value)
        throw new TypeError("PUSH_ORIGINS must contain HTTPS origins");
    if (!env.VAPID_SUBJECT || !env.VAPID_PRIVATE_KEY_FILE)
      throw new TypeError("Push requires VAPID_SUBJECT and VAPID_PRIVATE_KEY_FILE");
    const subject = new URL(env.VAPID_SUBJECT);
    if (subject.protocol !== "mailto:" && subject.protocol !== "https:")
      throw new TypeError("VAPID_SUBJECT must be a mailto or HTTPS URL");
    push = {
      origins,
      subject: env.VAPID_SUBJECT,
      privateKeyFile: secretFile("VAPID_PRIVATE_KEY_FILE", env.VAPID_PRIVATE_KEY_FILE),
    };
  }
  return {
    server: {
      host: env.HOST ?? "127.0.0.1",
      port,
    },
    stateDirectory: join(stateHome, "drv.run", "harness"),
    configDirectory: join(configHome, "drv.run"),
    runtimeDirectory,
    systemctl: env.SYSTEMCTL ?? "systemctl",
    wwwDirectory: env.WWW_ROOT === undefined ? undefined : absolute("WWW_ROOT", env.WWW_ROOT),
    origin,
    oauthServers,
    push,
    parallelApiKeyFile:
      env.PARALLEL_API_KEY_FILE === undefined
        ? undefined
        : secretFile("PARALLEL_API_KEY_FILE", env.PARALLEL_API_KEY_FILE),
  };
}

const Port = Type.Integer({ minimum: 0, maximum: 65535 });

function absolute(name: string, value: string | undefined, fallback?: string): string {
  const path = value ?? fallback;
  if (!path || !isAbsolute(path)) throw new TypeError(`${name} must be an absolute path`);
  return resolve(path);
}

function https(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || value.includes("#"))
    throw new TypeError("Expected an HTTPS URL without credentials or fragment");
  return url;
}

function secretFile(name: string, value: string): string {
  const path = absolute(name, value);
  if (path.startsWith("/nix/store/")) throw new TypeError(`${name} must be outside the Nix store`);
  return path;
}
