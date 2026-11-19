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

for (const status of [0, 1, 255]) {
  const accepted = status === 0;
  test(`provisioning completes with SSH status ${status} without changing configuration`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), "image-provision-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const runtime = join(directory, "fixture");
    const state = join(directory, "state");
    const bin = join(directory, "bin");
    for (const path of [runtime, state, bin]) mkdirSync(path);
    const environment = join(directory, "fixture-env");
    writeFileSync(environment, "{}");
    symlinkSync(environment, join(state, "environment"));
    writeFileSync(join(runtime, "client.conf"), "Host fixture\n");
    writeFileSync(join(directory, "ssh-status"), String(status));
    // The SSH boundary exposes control operations, never a closure transport.
    writeFileSync(
      join(bin, "ssh"),
      `#!${bash}
set -euo pipefail
IFS= read -r environment
printf '%s' "$environment" > "$FIXTURE/requested-environment"
status=$(cat "$FIXTURE/ssh-status")
if ((status != 0)); then exit "$status"; fi
printf '%s\\n' '{"phase":"profile-ready","monotonic_s":1}'
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
        MAINPID: String(process.pid),
      },
      stdio: "ignore",
      timeout: 2000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, status);
    assert.equal(existsSync(join(runtime, "client.conf")), true);
    assert.equal(existsSync(join(directory, "nix-invoked")), false);
    assert.equal(readFileSync(join(directory, "requested-environment"), "utf8"), environment);
    if (accepted) {
      assert.deepEqual(JSON.parse(readFileSync(join(runtime, "guest-timings.jsonl"), "utf8")), {
        phase: "profile-ready",
        monotonic_s: 1,
      });
    }
  });
}

for (const ready of [false, true]) {
  test(`guest shell ${ready ? "activates the environment without interpreting commands" : "requires readiness"}`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), "guest-shell-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const bin = join(directory, "bin");
    const home = join(directory, "home");
    mkdirSync(bin);
    mkdirSync(home);
    if (ready) writeFileSync(join(directory, "ready"), "");
    writeFileSync(join(directory, "environment"), "{}");
    symlinkSync(join(directory, "environment"), join(directory, "profile"));
    writeFileSync(
      join(bin, "nix"),
      `#!${bash}
set -euo pipefail
test "$1" = develop
test "$2" = "$FIXTURE/profile"
test "$3" = --command
touch "$FIXTURE/activated"
printf 'shellHook output must not enter the protocol\\n'
if read -r unexpected; then exit 1; fi
exec "\${@:4}"
`,
      { mode: 0o755 },
    );
    const shell = readFileSync(
      new URL("../../nixosModules/guest/shell.sh", import.meta.url),
      "utf8",
    )
      .replace("profile=/nix/var/nix/profiles/project", 'profile="$FIXTURE/profile"')
      .replace("/run/drv-run-environment/ready", join(directory, "ready"))
      .replaceAll("@bash@", bash);
    const script = join(directory, "shell");
    writeFileSync(script, shell);
    const result = spawnSync(
      "bash",
      [
        script,
        "-c",
        `test "$PWD" = "$FIXTURE/home" && printf '%s\\n' "quoted; value" > result && exit 37`,
      ],
      {
        cwd: home,
        env: { ...process.env, FIXTURE: directory, PATH: `${bin}:${process.env.PATH ?? ""}` },
        stdio: "ignore",
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, ready ? 37 : 1);
    assert.equal(existsSync(join(directory, "activated")), ready);
    assert.equal(existsSync(join(home, "result")), ready);
  });
}
