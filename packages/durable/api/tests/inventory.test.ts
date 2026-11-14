import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readDeploymentConfiguration } from "../src/configuration.ts";
import { createInventoryService } from "../src/inventory.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

async function setup(t: { after(callback: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), "durable-api-inventory-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const stateHome = join(directory, "state");
  const runtime = join(directory, "runtime");
  const state = join(stateHome, "drv.run");
  const systemctl = join(directory, "systemctl");
  await mkdir(state, { recursive: true });
  await writeFile(
    systemctl,
    `#!/bin/sh
case "$2" in
  list-units) printf '%s\\n' 'drv.run@loaded.service loaded active running Guest' ;;
  list-unit-files) printf '%s\\n' 'drv.run@defined.service enabled' ;;
  show)
    case "$*" in
      *InvocationID*) printf '%s\\n' 'invocation-1' ;;
      *) printf '%s\\n' 'active' 'running' 'success' ;;
    esac ;;
esac
`,
    { mode: 0o700 },
  );
  await chmod(systemctl, 0o700);
  const config = readDeploymentConfiguration(
    {
      DURABLE_API_STATE_DIRECTORY: join(directory, "api-state"),
      DURABLE_API_CONFIG_DIRECTORY: join(directory, "config"),
      XDG_RUNTIME_DIR: runtime,
      XDG_STATE_HOME: stateHome,
      SYSTEMCTL: systemctl,
    },
    1000,
    directory,
  );
  return { config, state, runtime };
}

await test("inventory unifies retained state and installed/loaded units with stable pagination", async (t) => {
  const { config, state } = await setup(t);
  await mkdir(join(state, "retained"), { recursive: true });
  await writeFile(join(state, "retained", "reference"), "github:example/repo\n");
  const service = createInventoryService(config);
  const first = await service.list(2, undefined, BACKGROUND_CONTEXT);
  assert.ok(!("invalidCursor" in first));
  assert.deepEqual(
    first.items.map(({ id }) => id),
    ["defined", "loaded"],
  );
  assert.deepEqual(first.next, { namespace: service.namespace, after: "loaded" });
  const second = await service.list(2, first.next ?? undefined, BACKGROUND_CONTEXT);
  assert.ok(!("invalidCursor" in second));
  assert.deepEqual(
    second.items.map(({ id }) => id),
    ["retained"],
  );
  assert.equal(second.next, null);
  assert.deepEqual(await service.lookup("retained", BACKGROUND_CONTEXT), {
    id: "retained",
    unit: "drv.run@retained.service",
  });
  assert.equal(await service.flakeReference("retained", BACKGROUND_CONTEXT), "github:example/repo");
  assert.deepEqual(
    await service.list(2, { namespace: "other", after: "loaded" }, BACKGROUND_CONTEXT),
    { invalidCursor: true },
  );
});

await test("inventory connect and observations use owner runtime artifacts", async (t) => {
  const { config, runtime } = await setup(t);
  const directory = join(runtime, "drv.run.loaded");
  await mkdir(join(config.instanceStateDirectory, "drv.run", "loaded"), { recursive: true });
  await mkdir(directory, { recursive: true });
  await Promise.all(
    ["client-key", "known_hosts", "client.conf"].map((name) =>
      writeFile(join(directory, name), "private runtime data"),
    ),
  );
  await writeFile(
    join(directory, "timings.jsonl"),
    `${JSON.stringify({ phase: "boot-ready", clock: "boottime", monotonic_s: 12.5, resolution_s: 0.01 })}\n`,
  );
  await writeFile(
    join(directory, "guest-timings.jsonl"),
    `${JSON.stringify({ phase: "guest-ready", clock: "monotonic", monotonic_s: 2, resolution_s: 0.001 })}\n`,
  );
  const service = createInventoryService(config);
  assert.deepEqual(await service.state("loaded", BACKGROUND_CONTEXT), {
    activeState: "active",
    subState: "running",
    result: "success",
  });
  assert.deepEqual(await service.connect("loaded", BACKGROUND_CONTEXT), {
    host: "drv.run.loaded",
    identityFile: join(directory, "client-key"),
    knownHostsFile: join(directory, "known_hosts"),
    hostKeyAlias: "drv.run.loaded",
    configFile: join(directory, "client.conf"),
  });
  const timings = await service.timings("loaded", BACKGROUND_CONTEXT);
  assert.equal(timings?.invocation_id, "invocation-1");
  assert.equal(timings?.host_phases?.[0]?.phase, "boot-ready");
  assert.equal(timings?.guest_phases?.[0]?.clock, "monotonic");
});
