import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { readDeploymentConfiguration } from "../src/configuration.ts";
import { createSettingsService, readHarnessRuntimeSettings } from "../src/settings.ts";

await test("settings service applies defaults and performs revision-checked replacement", async (t) => {
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
  assert.deepEqual(initial.settings, {
    wrapCode: false,
    bottomAlign: true,
    hideThinkingBlock: false,
    showImages: true,
    defaultDeliveryMode: "followUp",
  });
  await assert.rejects(access(config.configDirectory));

  const replacement = { ...initial.settings, wrapCode: true };
  const saved = await service.web.replace(initial.revision, replacement, BACKGROUND_CONTEXT);
  assert.equal(saved?.settings.wrapCode, true);
  assert.deepEqual(
    JSON.parse(await readFile(join(directory, "config/drv.run/web/settings.json"), "utf8")),
    replacement,
  );
  assert.notEqual(saved?.revision, initial.revision);
  assert.equal(
    await service.web.replace(initial.revision, replacement, BACKGROUND_CONTEXT),
    undefined,
  );
  assert.equal(
    (await createSettingsService(config).web.read(BACKGROUND_CONTEXT)).settings.wrapCode,
    true,
  );
});

await test("harness settings map GraphQL enums to Durable runtime policy", async (t) => {
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
  const current = await service.harness.read(BACKGROUND_CONTEXT);
  const saved = await service.harness.replace(
    current.revision,
    {
      transport: "websocketCached",
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
    saved.settings,
  );
  assert.deepEqual(await readHarnessRuntimeSettings(config), {
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
  });
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
  await mkdir(join(config.configDirectory, "harness"), { recursive: true });
  await writeFile(
    join(config.configDirectory, "harness", "settings.json"),
    JSON.stringify({ transport: "auto", unknown: true }),
  );
  await assert.rejects(
    createSettingsService(config).harness.read(BACKGROUND_CONTEXT),
    /Invalid harness settings file/,
  );
});
