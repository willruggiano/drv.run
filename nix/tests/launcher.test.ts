import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const command = readFileSync(
  new URL("../../nixosModules/host/command.sh", import.meta.url),
  "utf8",
);
const timing = readFileSync(new URL("../../nixosModules/timing.sh", import.meta.url), "utf8");
const bash = (process.env.PATH ?? "")
  .split(":")
  .map((directory) => join(directory, "bash"))
  .find(existsSync);
assert.ok(bash);

for (const collision of ["none", "durable", "runtime"]) {
  test(`launcher reserves canonical IDs without replacing ${collision} state`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "drv-launcher-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    for (const path of ["bin", "runtime", "state/drv.run", "started", "attached"]) {
      mkdirSync(join(directory, path), { recursive: true });
    }
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(join(directory, "runtime/bus"), resolve);
    });
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    writeFileSync(join(directory, "kvm"), "");
    writeFileSync(join(directory, "candidate"), "42\n");
    const retained = join(
      directory,
      collision === "runtime"
        ? "runtime/drv.run.000000000000002a"
        : "state/drv.run/000000000000002a",
    );
    if (collision !== "none") {
      mkdirSync(retained);
      writeFileSync(join(retained, "reference"), "retained");
    }
    const commands = {
      "systemd-path": 'printf "%s/state\\n" "$FIXTURE"',
      od: 'id=$(cat "$FIXTURE/candidate"); echo "$((id + 1))" > "$FIXTURE/candidate"; printf "%016x\\n" "$id"',
      systemctl: 'test "$1" = --user; test "$2" = start; touch "$FIXTURE/started/$3"',
      ssh: 'test "$1" = --; touch "$FIXTURE/attached/$2"',
    };
    for (const [name, body] of Object.entries(commands)) {
      writeFileSync(join(directory, "bin", name), `#!${bash}\nset -euo pipefail\n${body}\n`, {
        mode: 0o755,
      });
    }
    const script = command
      .replace(
        'export XDG_RUNTIME_DIR="/run/user/$EUID"',
        'export XDG_RUNTIME_DIR="$FIXTURE/runtime"',
      )
      .replaceAll("/dev/kvm", `${directory}/kvm`)
      .replace("@timing@", timing)
      .replace("@connect@", "false");
    const result = spawnSync("bash", ["-c", script], {
      env: {
        ...process.env,
        PATH: `${join(directory, "bin")}:${process.env.PATH ?? ""}`,
        FIXTURE: directory,
        SSH_ORIGINAL_COMMAND: "fixture:environment",
      },
      stdio: "ignore",
      timeout: 5000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0);
    const id = collision === "none" ? "000000000000002a" : "000000000000002b";
    assert.deepEqual(readdirSync(join(directory, "started")), [`drv.run@${id}.service`]);
    assert.deepEqual(readdirSync(join(directory, "attached")), [`drv.run.${id}`]);
    const runtime = join(directory, `runtime/drv.run.${id}`);
    const state = join(directory, "state/drv.run", id);
    assert.equal(statSync(runtime).mode & 0o777, 0o700);
    assert.equal(statSync(state).mode & 0o777, 0o700);
    assert.equal(readFileSync(join(runtime, "reference"), "utf8"), "fixture:environment\n");
    if (collision !== "none") {
      assert.equal(readFileSync(join(retained, "reference"), "utf8"), "retained");
    }
    if (collision === "runtime") {
      assert.equal(existsSync(join(directory, "state/drv.run/000000000000002a")), false);
    }
  });
}
