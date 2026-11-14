import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { readDeploymentConfiguration } from "../src/configuration.ts";
import { createSettingsService } from "../src/settings.ts";

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
  assert.ok(saved);
  const [first, stale] = await Promise.all([
    service.web.replace(saved.revision, { ...replacement, showImages: false }, BACKGROUND_CONTEXT),
    service.web.replace(saved.revision, { ...replacement, bottomAlign: false }, BACKGROUND_CONTEXT),
  ]);
  assert.ok(first);
  assert.equal(stale, undefined);
  assert.deepEqual((await service.web.read(BACKGROUND_CONTEXT)).settings, first.settings);
  await writeFile(
    join(config.configDirectory, "web", "settings.json"),
    JSON.stringify(replacement),
  );
  assert.equal(
    await service.web.replace(first.revision, first.settings, BACKGROUND_CONTEXT),
    undefined,
  );
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
  assert.deepEqual((await service.harness.read(BACKGROUND_CONTEXT)).settings, saved.settings);
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
  const { settings } = await service.harness.read(BACKGROUND_CONTEXT);
  assert.deepEqual(settings.retry, {
    enabled: true,
    maxRetries: 5,
    baseDelayMs: 2000,
    maxAgentDelayMs: 60000,
  });
  assert.equal(settings.compaction.enabled, false);
  assert.equal(settings.compaction.reserveTokens, 16384);
});
