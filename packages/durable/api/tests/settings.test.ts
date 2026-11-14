import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { readDeploymentConfiguration } from "../src/configuration.ts";
import { createSettingsService } from "../src/settings.ts";

await test("settings service applies defaults and writes replacements without reading existing files", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "durable-api-settings-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const config = readDeploymentConfiguration(
    {
      XDG_STATE_HOME: join(directory, "state"),
      XDG_CONFIG_HOME: join(directory, "config"),
    },
    1000,
    directory,
  );
  const service = createSettingsService(config);
  const initial = await service.web.read(BACKGROUND_CONTEXT);
  assert.deepEqual(initial, {
    wrapCode: false,
    bottomAlign: true,
    hideThinkingBlock: false,
    showImages: true,
    defaultDeliveryMode: "followUp",
  });
  await assert.rejects(access(config.configDirectory));

  const replacement = { ...initial, wrapCode: true };
  const saved = await service.web.replace(replacement, BACKGROUND_CONTEXT);
  assert.equal(saved.wrapCode, true);
  assert.deepEqual(
    JSON.parse(await readFile(join(directory, "config/drv.run/web/settings.json"), "utf8")),
    replacement,
  );
  const path = join(config.configDirectory, "web", "settings.json");
  await writeFile(path, "malformed JSON");
  const latest = { ...replacement, showImages: false };
  assert.deepEqual(await service.web.replace(latest, BACKGROUND_CONTEXT), latest);
  assert.deepEqual(await service.web.read(BACKGROUND_CONTEXT), latest);
});

await test("harness settings retain validated enum and policy values", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "durable-api-settings-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const config = readDeploymentConfiguration(
    {
      XDG_STATE_HOME: join(directory, "state"),
      XDG_CONFIG_HOME: join(directory, "config"),
    },
    1000,
    directory,
  );
  const service = createSettingsService(config);
  const saved = await service.harness.replace(
    {
      stream: { transport: "websocket-cached" },
      steeringMode: "all",
      followUpMode: "all",
      retry: { enabled: false, maxRetries: 0, baseDelayMs: 0, maxAgentDelayMs: 0 },
      compaction: {
        enabled: false,
        reserveTokens: 0,
        keepRecentTokens: 0,
        backgroundTokens: 0,
      },
    },
    BACKGROUND_CONTEXT,
  );
  assert.ok(saved);
  assert.deepEqual(
    JSON.parse(await readFile(join(directory, "config/drv.run/harness/settings.json"), "utf8")),
    saved,
  );
  assert.deepEqual(await service.harness.read(BACKGROUND_CONTEXT), saved);
});

await test("settings service rejects malformed persisted values", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "durable-api-settings-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const config = readDeploymentConfiguration(
    {
      XDG_STATE_HOME: join(directory, "state"),
      XDG_CONFIG_HOME: join(directory, "config"),
    },
    1000,
    directory,
  );
  const service = createSettingsService(config);
  for (const app of ["web", "harness"] as const) {
    await mkdir(join(config.configDirectory, app), { recursive: true });
    for (const value of [null, [], { unknown: true }]) {
      await writeFile(join(config.configDirectory, app, "settings.json"), JSON.stringify(value));
      await assert.rejects(service[app].read(BACKGROUND_CONTEXT), TypeError);
    }
  }
  for (const value of [
    { transport: "invalid" },
    { retry: null },
    { retry: { maxRetries: -1 } },
    { retry: { baseDelayMs: 1.5 } },
    { retry: { maxAgentDelayMs: 2147483648 } },
    { retry: { unknown: true } },
    { compaction: { enabled: "false" } },
    { compaction: { unknown: true } },
  ]) {
    await writeFile(
      join(config.configDirectory, "harness", "settings.json"),
      JSON.stringify(value),
    );
    await assert.rejects(service.harness.read(BACKGROUND_CONTEXT), TypeError);
  }
  await writeFile(
    join(config.configDirectory, "harness", "settings.json"),
    JSON.stringify({ retry: { maxRetries: 5 }, compaction: { enabled: false } }),
  );
  const settings = await service.harness.read(BACKGROUND_CONTEXT);
  assert.deepEqual(settings.retry, {
    enabled: true,
    maxRetries: 5,
    baseDelayMs: 2000,
    maxAgentDelayMs: 60000,
  });
  assert.equal(settings.compaction.enabled, false);
  assert.equal(settings.compaction.reserveTokens, 16384);
});

await test("settings propagate filesystem read failures", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "durable-api-settings-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = readDeploymentConfiguration({ XDG_CONFIG_HOME: directory }, 1000, directory);
  await mkdir(join(config.configDirectory, "web", "settings.json"), { recursive: true });
  await assert.rejects(createSettingsService(config).web.read(BACKGROUND_CONTEXT));
});
