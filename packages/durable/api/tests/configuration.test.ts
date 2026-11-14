import assert from "node:assert/strict";
import { test } from "node:test";
import { readDeploymentConfiguration } from "../src/configuration.ts";

await test("deployment config requires an explicit absolute Durable state directory", () => {
  assert.throws(
    () => readDeploymentConfiguration({}, 1000, "/home/pi"),
    /DURABLE_API_STATE_DIRECTORY must be an absolute path/,
  );
  assert.throws(
    () => readDeploymentConfiguration({ DURABLE_API_STATE_DIRECTORY: "relative" }, 1000),
    /DURABLE_API_STATE_DIRECTORY must be an absolute path/,
  );
});

await test("deployment config maps service env and derives owner-scoped paths", () => {
  const config = readDeploymentConfiguration(
    {
      HOST: "127.0.0.1",
      PORT: "8123",
      DURABLE_API_STATE_DIRECTORY: "/srv/drv.run/api",
      DURABLE_API_CONFIG_DIRECTORY: "/srv/drv.run/config",
      XDG_RUNTIME_DIR: "/run/user/1000",
      XDG_STATE_HOME: "/srv/state",
      SYSTEMCTL: "/run/current-system/sw/bin/systemctl",
    },
    1000,
    "/home/pi",
  );
  assert.deepEqual(config.server, { host: "127.0.0.1", port: 8123 });
  assert.equal(config.stateDirectory, "/srv/drv.run/api");
  assert.equal(config.configDirectory, "/srv/drv.run/config");
  assert.equal(config.runtimeDirectory, "/run/user/1000");
  assert.equal(config.instanceStateDirectory, "/srv/state");
  assert.equal(config.systemctl, "/run/current-system/sw/bin/systemctl");
});

await test("deployment config honors an absolute XDG config root and ignores relative overrides", () => {
  const absolute = readDeploymentConfiguration(
    { DURABLE_API_STATE_DIRECTORY: "/state", XDG_CONFIG_HOME: "/config" },
    1000,
    "/home/pi",
  );
  assert.equal(absolute.configDirectory, "/config/drv.run");
  const relative = readDeploymentConfiguration(
    { DURABLE_API_STATE_DIRECTORY: "/state", XDG_CONFIG_HOME: "relative" },
    1000,
    "/home/pi",
  );
  assert.equal(relative.configDirectory, "/home/pi/.config/drv.run");
});

await test("deployment config rejects invalid ports and root execution", () => {
  for (const value of ["0", "65536", "1.5", "abc"]) {
    assert.throws(
      () =>
        readDeploymentConfiguration({ DURABLE_API_STATE_DIRECTORY: "/state", PORT: value }, 1000),
      /PORT must be an integer/,
    );
  }
  assert.throws(
    () => readDeploymentConfiguration({ DURABLE_API_STATE_DIRECTORY: "/state" }, 0),
    /unprivileged user/,
  );
});
