import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { readDeploymentConfiguration } from "../src/configuration.ts";
import { createInventoryService } from "../src/inventory.ts";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";

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
      XDG_CONFIG_HOME: join(directory, "config"),
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
  await mkdir(join(state, "harness", "sessions"), { recursive: true });
  await writeFile(join(state, "retained", "reference"), "github:example/repo\n");
  const service = createInventoryService(config);
  assert.equal(await service.lookup("harness", BACKGROUND_CONTEXT), undefined);
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
  for (const record of [...first.items, ...second.items]) {
    assert.deepEqual(await service.lookup(record.id, BACKGROUND_CONTEXT), record);
    assert.deepEqual(await service.state(record.id, BACKGROUND_CONTEXT), {
      activeState: "active",
      subState: "running",
      result: "success",
    });
  }
  assert.equal(await service.flakeReference("loaded", BACKGROUND_CONTEXT), undefined);
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

await test("inventory uses retained identities without imposing an ID grammar or accepting paths", async (t) => {
  const { config, state } = await setup(t);
  await mkdir(join(state, "retained-name"));
  await mkdir(join(state, "..", "outside"));
  const service = createInventoryService(config);
  const page = await service.list(10, undefined, BACKGROUND_CONTEXT);
  assert.ok(!("invalidCursor" in page));
  assert.equal(
    page.items.some((item) => item.id === "retained-name"),
    true,
  );
  assert.deepEqual(await service.lookup("retained-name", BACKGROUND_CONTEXT), {
    id: "retained-name",
    unit: "drv.run@retained-name.service",
  });
  for (const id of ["../outside", ".", state]) {
    assert.equal(await service.lookup(id, BACKGROUND_CONTEXT), undefined);
    assert.equal(await service.flakeReference(id, BACKGROUND_CONTEXT), undefined);
  }
});

await test("inventory connect and observations use owner runtime artifacts", async (t) => {
  const { config, runtime } = await setup(t);
  const directory = join(runtime, "drv.run.loaded");
  await mkdir(join(dirname(config.stateDirectory), "loaded"), { recursive: true });
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
    user: "root",
    identityFile: join(directory, "client-key"),
    knownHostsFile: join(directory, "known_hosts"),
    hostKeyAlias: "drv.run.loaded",
    configFile: join(directory, "client.conf"),
  });
  const cancellable = withAbortSignal(new AbortController().signal, BACKGROUND_CONTEXT);
  await service.list(10, undefined, cancellable);
  await service.lookup("loaded", cancellable);
  assert(await service.connect("loaded", cancellable));
  const timings = await service.timings("loaded", BACKGROUND_CONTEXT);
  assert.equal(timings?.invocation_id, "invocation-1");
  assert.equal(timings?.host_phases?.[0]?.phase, "boot-ready");
  assert.equal(timings?.guest_phases?.[0]?.clock, "monotonic");
});

await test("inventory distinguishes absent artifacts, malformed timings, and filesystem failures", async (t) => {
  const { config, state, runtime } = await setup(t);
  const service = createInventoryService(config);
  await rm(state, { recursive: true });
  const loaded = await service.list(10, undefined, BACKGROUND_CONTEXT);
  assert("items" in loaded);
  assert.equal(loaded.items.length, 2);
  assert.equal(await service.lookup("absent", BACKGROUND_CONTEXT), undefined);
  for (const operation of ["connect", "state", "timings"] as const)
    assert.equal(await service[operation]("absent", BACKGROUND_CONTEXT), undefined);
  await mkdir(join(state, "loaded"), { recursive: true });
  assert.equal(await service.flakeReference("loaded", BACKGROUND_CONTEXT), undefined);
  assert.equal(await service.connect("loaded", BACKGROUND_CONTEXT), undefined);
  assert.equal(await service.timings("loaded", BACKGROUND_CONTEXT), undefined);
  const directory = join(runtime, "drv.run.loaded");
  await mkdir(directory, { recursive: true });
  for (const name of ["client-key", "known_hosts", "client.conf"])
    await mkdir(join(directory, name));
  assert.equal(await service.connect("loaded", BACKGROUND_CONTEXT), undefined);
  await rm(join(directory, "client-key"), { recursive: true });
  await symlink("client-key", join(directory, "client-key"));
  await assert.rejects(service.connect("loaded", BACKGROUND_CONTEXT));
  await mkdir(join(state, "loaded", "reference"));
  await assert.rejects(service.flakeReference("loaded", BACKGROUND_CONTEXT));
  for (const value of [
    "",
    "not JSON",
    JSON.stringify({}),
    JSON.stringify({ phase: "a", clock: "b", monotonic_s: -1, resolution_s: 1 }),
  ]) {
    await writeFile(join(directory, "timings.jsonl"), value);
    assert.equal(await service.timings("loaded", BACKGROUND_CONTEXT), undefined);
  }
  const phase = { phase: "ready", clock: "monotonic", monotonic_s: 1, resolution_s: 0.01 };
  await writeFile(join(directory, "guest-timings.jsonl"), JSON.stringify(phase));
  assert.deepEqual((await service.timings("loaded", BACKGROUND_CONTEXT))?.guest_phases, [phase]);
  await writeFile(join(directory, "timings.jsonl"), JSON.stringify(phase));
  await rm(join(directory, "guest-timings.jsonl"));
  assert.equal((await service.timings("loaded", BACKGROUND_CONTEXT))?.guest_phases, null);
  await rm(join(directory, "timings.jsonl"));
  await mkdir(join(directory, "timings.jsonl"));
  await assert.rejects(service.timings("loaded", BACKGROUND_CONTEXT));
  await writeFile(config.systemctl, "#!/bin/sh\nprintf 'active\\nrunning\\n\\n'\n");
  assert.equal((await service.state("loaded", BACKGROUND_CONTEXT))?.result, null);
  await writeFile(config.systemctl, "#!/bin/sh\nexit 0\n");
  assert.equal(await service.timings("loaded", BACKGROUND_CONTEXT), undefined);
  await rm(state, { recursive: true });
  await writeFile(state, "not a directory");
  await assert.rejects(service.list(10, undefined, BACKGROUND_CONTEXT));
  await assert.rejects(service.lookup("loaded", BACKGROUND_CONTEXT));
});

await test("inventory rejects malformed cursors and honors cancellation", async (t) => {
  const { config } = await setup(t);
  const service = createInventoryService(config);
  for (const cursor of [
    {},
    { namespace: service.namespace },
    { namespace: service.namespace, after: 1 },
    { namespace: service.namespace, after: "loaded", extra: true },
  ])
    assert.deepEqual(await service.list(1, cursor, BACKGROUND_CONTEXT), { invalidCursor: true });
  const aborted = withAbortSignal(AbortSignal.abort(), BACKGROUND_CONTEXT);
  await assert.rejects(service.list(1, undefined, aborted));
  await assert.rejects(service.lookup("loaded", aborted));
});
