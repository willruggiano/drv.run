import assert from "node:assert/strict";
import { test } from "node:test";
import { readDeploymentConfiguration } from "../src/configuration.ts";

await test("deployment config defaults to owner-scoped XDG paths", () => {
  const config = readDeploymentConfiguration({}, 1000, "/home/pi");
  assert.deepEqual(config.server, { host: "127.0.0.1", port: 8080 });
  assert.equal(config.stateDirectory, "/home/pi/.local/state/drv.run/harness");
  assert.equal(config.configDirectory, "/home/pi/.config/drv.run");
  assert.equal(config.instanceStateDirectory, "/home/pi/.local/state");
  assert.equal(config.runtimeDirectory, "/run/user/1000");
  assert.equal(config.systemctl, "systemctl");
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
  assert.equal(config.instanceStateDirectory, "/srv/state");
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
    assert.equal(config.instanceStateDirectory, "/home/pi/.local/state");
  }
});

await test("deployment config rejects invalid ports and root execution", () => {
  for (const value of ["0", "65536", "1.5", "abc"]) {
    assert.throws(
      () => readDeploymentConfiguration({ PORT: value }, 1000),
      /PORT must be an integer/,
    );
  }
  assert.throws(() => readDeploymentConfiguration({}, 0), /unprivileged user/);
});
