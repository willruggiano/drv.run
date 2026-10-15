import assert from "node:assert/strict";
import { test } from "node:test";
import { readDeploymentConfiguration } from "../src/configuration.ts";

await test("deployment config defaults to owner-scoped XDG paths", () => {
  const config = readDeploymentConfiguration({}, 1000, "/home/pi");
  assert.deepEqual(config.server, { host: "127.0.0.1", port: 8080 });
  assert.equal(config.stateDirectory, "/home/pi/.local/state/drv.run/harness");
  assert.equal(config.configDirectory, "/home/pi/.config/drv.run");
  assert.equal(config.runtimeDirectory, "/run/user/1000");
  assert.equal(config.systemctl, "systemctl");
  assert.equal(config.wwwDirectory, undefined);
  assert.equal(config.openaiAuthSocket, undefined);
  assert.equal(
    readDeploymentConfiguration({ WWW_ROOT: "/srv/www" }, 1000).wwwDirectory,
    "/srv/www",
  );
  assert.throws(() => readDeploymentConfiguration({ WWW_ROOT: "relative" }, 1000));
  assert.equal(readDeploymentConfiguration({ PORT: "0" }, 1000).server.port, 0);
});

await test("deployment config maps service env and derives owner-scoped paths", () => {
  const config = readDeploymentConfiguration(
    {
      HOST: "127.0.0.1",
      PORT: "8123",
      XDG_CONFIG_HOME: "/srv/config",
      XDG_RUNTIME_DIR: "/run/user/1000",
      XDG_STATE_HOME: "/srv/state",
      SYSTEMCTL: "/run/current-system/sw/bin/systemctl",
    },
    1000,
    "/home/pi",
  );
  assert.deepEqual(config.server, { host: "127.0.0.1", port: 8123 });
  assert.equal(config.stateDirectory, "/srv/state/drv.run/harness");
  assert.equal(config.configDirectory, "/srv/config/drv.run");
  assert.equal(config.runtimeDirectory, "/run/user/1000");
  assert.equal(config.systemctl, "/run/current-system/sw/bin/systemctl");
});

await test("deployment config ignores empty and relative XDG home overrides", () => {
  for (const value of ["", "relative"]) {
    const config = readDeploymentConfiguration(
      { XDG_CONFIG_HOME: value, XDG_STATE_HOME: value },
      1000,
      "/home/pi",
    );
    assert.equal(config.configDirectory, "/home/pi/.config/drv.run");
    assert.equal(config.stateDirectory, "/home/pi/.local/state/drv.run/harness");
  }
});

await test("host OpenAI auth is opt-in and requires an absolute socket path", () => {
  const path = "/run/mitm-proxy-auth/me.sock";
  assert.equal(readDeploymentConfiguration({ OPENAI_AUTH_SOCKET: path }).openaiAuthSocket, path);
  for (const OPENAI_AUTH_SOCKET of ["", "relative"])
    assert.throws(() => readDeploymentConfiguration({ OPENAI_AUTH_SOCKET }), TypeError);
});

await test("deployment config validates ports without enforcing a process identity", () => {
  for (const value of ["-1", "65536", "1.5", "abc"]) {
    assert.throws(() => readDeploymentConfiguration({ PORT: value }, 1000), TypeError);
  }
  assert.equal(readDeploymentConfiguration({}, 0).server.port, 8080);
});

await test("production config validates OAuth registrations, origins and runtime secret paths", () => {
  const server = {
    id: "openai",
    provider: "openai-codex",
    label: "OpenAI",
    client_id: "client",
    clientSecretFile: "/run/secrets/client",
    scope: "openid profile",
    metadata: {
      issuer: "https://issuer.example",
      authorization_endpoint: "https://issuer.example/authorize",
      token_endpoint: "https://issuer.example/token",
      grant_types_supported: ["authorization_code"],
    },
  };
  const env = {
    ORIGIN: "https://app.example",
    OAUTH_SERVERS: JSON.stringify([server]),
    PARALLEL_API_KEY_FILE: "/run/secrets/parallel",
    PUSH_ORIGINS: JSON.stringify(["https://push.example"]),
    VAPID_SUBJECT: "mailto:operator@example.com",
    VAPID_PRIVATE_KEY_FILE: "/run/secrets/vapid",
  };
  const config = readDeploymentConfiguration(env, 1000);
  assert.deepEqual(config.oauthServers, [server]);
  assert.throws(() =>
    readDeploymentConfiguration({ ...env, OPENAI_AUTH_SOCKET: "/run/mitm-proxy-auth/me.sock" }),
  );
  assert.equal(
    readDeploymentConfiguration({
      ...env,
      OPENAI_AUTH_SOCKET: "/run/mitm-proxy-auth/me.sock",
      OAUTH_SERVERS: JSON.stringify([{ ...server, provider: "other" }]),
    }).openaiAuthSocket,
    "/run/mitm-proxy-auth/me.sock",
  );
  assert.equal(config.origin, env.ORIGIN);
  assert.equal(config.parallelApiKeyFile, env.PARALLEL_API_KEY_FILE);
  assert.deepEqual(config.push, {
    origins: ["https://push.example"],
    subject: env.VAPID_SUBJECT,
    privateKeyFile: env.VAPID_PRIVATE_KEY_FILE,
  });
  env.ORIGIN = "https://changed.example";
  assert.equal(config.origin, "https://app.example");
  for (const ORIGIN of [
    "",
    "http://app.example",
    "https://user:password@app.example",
    "https://app.example/path",
    "https://app.example/#fragment",
  ])
    assert.throws(() => readDeploymentConfiguration({ ORIGIN }, 1000));
  for (const path of ["relative", "", "/nix/store/private-key"]) {
    assert.throws(() => readDeploymentConfiguration({ PARALLEL_API_KEY_FILE: path }, 1000));
    assert.throws(() =>
      readDeploymentConfiguration({ ...env, VAPID_PRIVATE_KEY_FILE: path }, 1000),
    );
    assert.throws(() =>
      readDeploymentConfiguration(
        { ...env, OAUTH_SERVERS: JSON.stringify([{ ...server, clientSecretFile: path }]) },
        1000,
      ),
    );
  }
  for (const override of [
    { ORIGIN: undefined },
    { OAUTH_SERVERS: JSON.stringify([server, server]) },
    { OAUTH_SERVERS: JSON.stringify([{ ...server, extra: true }]) },
    {
      OAUTH_SERVERS: JSON.stringify([
        { ...server, metadata: { ...server.metadata, authorization_endpoint: undefined } },
      ]),
    },
    {
      OAUTH_SERVERS: JSON.stringify([
        {
          ...server,
          metadata: {
            ...server.metadata,
            token_endpoint: "https://user:secret@issuer.example/token",
          },
        },
      ]),
    },
    {
      OAUTH_SERVERS: JSON.stringify([
        {
          ...server,
          metadata: {
            ...server.metadata,
            grant_types_supported: ["urn:ietf:params:oauth:grant-type:device_code"],
          },
        },
      ]),
    },
    { PUSH_ORIGINS: "[]" },
    { PUSH_ORIGINS: '["https://push.example/path"]' },
    { VAPID_SUBJECT: "http://operator.example" },
    { VAPID_PRIVATE_KEY_FILE: undefined },
  ])
    assert.throws(() => readDeploymentConfiguration({ ...env, ...override }, 1000));
  assert.throws(() => readDeploymentConfiguration({ VAPID_SUBJECT: env.VAPID_SUBJECT }, 1000));
});
