import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "rock5b-installer-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = join(directory, "state");
  const boot = join(directory, "boot");
  const target = join(directory, "target");
  const handoff = join(directory, "handoff.scr");
  await Promise.all([
    mkdir(state),
    mkdir(join(boot, "EFI"), { recursive: true }),
    mkdir(join(boot, "loader"), { recursive: true }),
    mkdir(join(target, "boot/EFI/BOOT"), { recursive: true }),
    writeFile(handoff, Buffer.from([1, 2, 3])),
  ]);
  await writeFile(join(boot, "ssh_host_ed25519_key"), "test identity");

  function run(failure = "") {
    const result = spawnSync(
      "bash",
      [
        "-c",
        `
          source "$INSTALLER_SCRIPT"
          sync() { :; }
          rm() {
            [[ "$FAILURE" != published ]]
            command rm "$@"
          }
          preflight() {
            [[ "$FAILURE" != preflight ]]
          }
          provision() {
            test -d "$STATE_DIRECTORY/started"
            test ! -e "$STATE_DIRECTORY/provisioned"
            touch "$STATE_DIRECTORY/provisioned"
            [[ "$FAILURE" != provision ]]
          }
          install_host() {
            test -e "$STATE_DIRECTORY/provisioned"
            [[ "$FAILURE" != install ]]
            if [[ "$FAILURE" != handoff ]]; then
              printf '\\x01' >"$INSTALL_ROOT/boot/EFI/BOOT/BOOTAA64.EFI"
            fi
          }
          reboot_host() {
            test -e "$STATE_DIRECTORY/completed"
            touch "$STATE_DIRECTORY/rebooted"
          }
          run_install
        `,
      ],
      {
        env: {
          ...process.env,
          INSTALLER_SCRIPT: fileURLToPath(new URL("../installer.sh", import.meta.url)),
          STATE_DIRECTORY: state,
          BOOT: boot,
          INSTALL_ROOT: target,
          HANDOFF_SCRIPT: handoff,
          FAILURE: failure,
        },
        stdio: "ignore",
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    return result.status;
  }
  return { state, boot, target, run };
}

await test("successful install disables MMC EFI boot before requesting reboot", async (t) => {
  const f = await fixture(t);
  assert.equal(f.run(), 0);
  for (const name of ["started", "provisioned", "completed", "rebooted"]) {
    assert(existsSync(join(f.state, name)));
  }
  assert(existsSync(join(f.boot, "boot.scr")));
  assert(!existsSync(join(f.boot, "EFI")));
  assert(!existsSync(join(f.boot, "loader")));
  assert(!existsSync(join(f.boot, "ssh_host_ed25519_key")));
  assert(existsSync(join(f.target, "boot/EFI/BOOT/BOOTAA64.EFI")));
  await rm(join(f.state, "rebooted"));
  assert.equal(f.run(), 0);
  assert(!existsSync(join(f.state, "rebooted")));
});

await test("preflight failure does not arm a destructive attempt", async (t) => {
  const f = await fixture(t);
  assert.notEqual(f.run("preflight"), 0);
  assert(!existsSync(join(f.state, "started")));
  assert(!existsSync(join(f.state, "provisioned")));
  assert.equal(f.run(), 0);
});

for (const failure of ["provision", "install", "handoff"]) {
  await test(`failure during ${failure} prevents automatic reformatting`, async (t) => {
    const f = await fixture(t);
    assert.notEqual(f.run(failure), 0);
    assert(existsSync(join(f.state, "started")));
    assert(!existsSync(join(f.state, "completed")));
    assert(!existsSync(join(f.state, "rebooted")));
    assert(existsSync(join(f.boot, "EFI")));
    assert(existsSync(join(f.boot, "ssh_host_ed25519_key")));
    assert.notEqual(f.run(), 0);
    assert(!existsSync(join(f.state, "completed")));
  });
}

await test("failure after publishing the chainloader still prevents reformatting", async (t) => {
  const f = await fixture(t);
  assert.notEqual(f.run("published"), 0);
  assert(existsSync(join(f.boot, "boot.scr")));
  assert(!existsSync(join(f.state, "completed")));
  assert(!existsSync(join(f.state, "rebooted")));
  assert.notEqual(f.run(), 0);
});

await test("a power loss after arming cannot start another provisioning attempt", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.state, "started"));
  assert.notEqual(f.run(), 0);
  assert(!existsSync(join(f.state, "provisioned")));
});
