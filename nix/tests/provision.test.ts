import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const post = readFileSync(new URL("../../nixosModules/host/post.sh", import.meta.url), "utf8");
const timing = readFileSync(new URL("../../nixosModules/timing.sh", import.meta.url), "utf8");
// The Nix sandbox has no /usr/bin/env. Use the same Bash found by spawnSync.
const bash = (process.env.PATH ?? "")
  .split(":")
  .map((directory) => join(directory, "bash"))
  .find(existsSync);
assert.ok(bash, "Bash is required for the provisioning fixture");

for (const accepted of [true, false]) {
  test(`provisioning ${accepted ? "publishes only after acknowledgement and master close" : "fails closed"}`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), "image-provision-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const runtime = join(directory, "drv.run.fixture");
    const state = join(directory, "state");
    const bin = join(directory, "bin");
    for (const path of [runtime, state, bin]) mkdirSync(path);
    const environment = join(directory, "fixture-env");
    writeFileSync(environment, "{}");
    symlinkSync(environment, join(state, "environment"));
    writeFileSync(join(runtime, "service-connection.conf"), "Host fixture\n");
    writeFileSync(join(directory, "accepted"), JSON.stringify(accepted));
    // The SSH boundary exposes control operations, never a closure transport.
    writeFileSync(
      join(bin, "ssh"),
      `#!${bash}
set -euo pipefail
case "$*" in
  *-fMN*) touch "$FIXTURE/master" ;;
  *root-environment)
    IFS= read -r environment
    printf '%s' "$environment" > "$FIXTURE/requested-environment"
    test "$(cat "$FIXTURE/accepted")" = true
    ;;
  *environment-timings) printf '%s\\n' '{"phase":"profile-ready","monotonic_s":1}' ;;
  *'-O exit'*)
    test ! -e "$RUNTIME_DIRECTORY/client.conf"
    rm "$FIXTURE/master"
    touch "$FIXTURE/master-closed"
    ;;
  *) exit 2 ;;
esac
`,
      { mode: 0o755 },
    );
    writeFileSync(join(bin, "nix"), `#!${bash}\ntouch "$FIXTURE/nix-invoked"\nexit 2\n`, {
      mode: 0o755,
    });
    const script = join(directory, "post.sh");
    writeFileSync(
      script,
      post.replaceAll("@service-ssh@", "/dev/null").replace("@timing@", timing),
    );
    const result = spawnSync("bash", [script], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        FIXTURE: directory,
        RUNTIME_DIRECTORY: runtime,
        STATE_DIRECTORY: state,
      },
      stdio: "ignore",
    });
    assert.ifError(result.error);
    assert.equal(result.status, accepted ? 0 : 1);
    assert.equal(existsSync(join(runtime, "client.conf")), accepted);
    assert.equal(existsSync(join(directory, "master-closed")), accepted);
    assert.equal(existsSync(join(directory, "nix-invoked")), false);
    assert.equal(readFileSync(join(directory, "requested-environment"), "utf8"), environment);
    if (accepted) {
      assert.deepEqual(
        readFileSync(join(runtime, "client.conf")),
        readFileSync(join(runtime, "service-connection.conf")),
      );
      assert.equal(existsSync(join(directory, "master")), false);
      assert.deepEqual(JSON.parse(readFileSync(join(runtime, "guest-timings.jsonl"), "utf8")), {
        phase: "profile-ready",
        monotonic_s: 1,
      });
    }
  });
}

await test("notification streaming does not require a prepared environment", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "notification-dispatch-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const guest = readFileSync(new URL("../../nixosModules/guest/guest.sh", import.meta.url), "utf8")
    .replace("ready=/run/drv-run-environment/ready", 'ready="$FIXTURE/ready"')
    .replace("@notifications-stream@", 'touch "$FIXTURE/stream-opened"; exit 0');
  const result = spawnSync("bash", ["-c", guest], {
    env: { ...process.env, FIXTURE: directory, SSH_ORIGINAL_COMMAND: "notifications-stream" },
    stdio: "ignore",
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0);
  assert.equal(existsSync(join(directory, "stream-opened")), true);
  assert.equal(existsSync(join(directory, "ready")), false);
});

for (const ready of [false, true]) {
  test(`SFTP ${ready ? "bypasses nix develop" : "requires guest readiness"}`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), "sftp-dispatch-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const bin = join(directory, "bin");
    mkdirSync(bin);
    if (ready) writeFileSync(join(directory, "ready"), "");
    writeFileSync(join(bin, "nix"), `#!${bash}\ntouch "$FIXTURE/nix-invoked"\nexit 2\n`, {
      mode: 0o755,
    });
    const server = join(bin, "sftp-server");
    writeFileSync(
      server,
      `#!${bash}\nset -euo pipefail\ntest "$1" = -u\ntest "$2" = 0077\ntouch "$FIXTURE/sftp-opened"\n`,
      { mode: 0o755 },
    );
    const guest = readFileSync(
      new URL("../../nixosModules/guest/guest.sh", import.meta.url),
      "utf8",
    )
      .replace("ready=/run/drv-run-environment/ready", 'ready="$FIXTURE/ready"')
      .replace("profile=/nix/var/nix/profiles/project", 'profile="$FIXTURE/missing-profile"')
      .replace("@sftp-pattern@", "'test-sftp -u 0077'")
      .replace("@sftp-command@", `${server} -u 0077`);
    const result = spawnSync("bash", ["-c", guest], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        FIXTURE: directory,
        SSH_ORIGINAL_COMMAND: "test-sftp -u 0077",
      },
      stdio: "ignore",
    });
    assert.ifError(result.error);
    assert.equal(result.status, ready ? 0 : 1);
    assert.equal(existsSync(join(directory, "sftp-opened")), ready);
    assert.equal(existsSync(join(directory, "nix-invoked")), false);
  });
}
