import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

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
const { username: owner, uid } = userInfo();

async function inventoryFixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "drv-inventory-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const path of ["bin", "runtime", "state", "properties"]) {
    mkdirSync(join(directory, path));
  }
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(join(directory, "runtime/bus"), resolve);
  });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const commands = {
    "systemd-path": 'printf "%s/state\\n" "$FIXTURE"',
    // All Node fixture state belongs to the caller. Real cross-owner execution
    // and root's multi-owner aggregation are exercised by the NixOS test.
    runuser: `
      test "$1" = --user
      test "$2" = "$FIXTURE_OWNER"
      test "$3" = --
      shift 3
      exec "$@"`,
    systemctl: `
      test ! -e "$FIXTURE/unavailable"
      test "$1" = --user
      test "$2" = show
      if [[ \${3:-} == drv.run@*.service ]]; then
        cat "$FIXTURE/properties/$3"
      else
        printf 'Version=262\\n'
      fi`,
  };
  for (const [name, body] of Object.entries(commands)) {
    writeFileSync(join(directory, "bin", name), `#!${bash}\nset -euo pipefail\n${body}\n`, {
      mode: 0o755,
    });
  }
  const launcher = join(directory, "launcher");
  writeFileSync(
    launcher,
    `#!${bash}\n` +
      command
        .replace(
          'export XDG_RUNTIME_DIR="/run/user/$EUID"',
          'export XDG_RUNTIME_DIR="$FIXTURE/runtime"',
        )
        .replace("@timing@", timing)
        .replace("@connect@", "false"),
    { mode: 0o755 },
  );
  const cli = join(directory, "drv.run");
  writeFileSync(
    cli,
    readFileSync(new URL("../../nixosModules/host/cli.sh", import.meta.url), "utf8")
      .replaceAll("@launcher@", launcher)
      .replace("@owners@", `'${owner.replaceAll("'", "'\\''")}'`),
  );
  return {
    directory,
    retain(id: string, reference: string, properties: string) {
      const state = join(directory, "state/drv.run", id);
      mkdirSync(state, { recursive: true });
      writeFileSync(join(state, "reference"), `${reference}\n`);
      writeFileSync(join(directory, "properties", `drv.run@${id}.service`), properties);
    },
    run(args = ["list", "--json"]) {
      const result = spawnSync("bash", [cli, ...args], {
        env: {
          ...process.env,
          PATH: `${join(directory, "bin")}:${process.env.PATH ?? ""}`,
          FIXTURE: directory,
          FIXTURE_OWNER: owner,
          USER: "not-the-calling-owner",
          SSH_ORIGINAL_COMMAND: "fixture:must-not-launch",
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
        timeout: 5000,
      });
      assert.ifError(result.error);
      return result;
    },
  };
}

test("owner inventory returns an empty versioned document without creating state", async (t) => {
  const fixture = await inventoryFixture(t);
  const result = fixture.run();
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), { version: 1, instances: [] });
  assert.deepEqual(readdirSync(join(fixture.directory, "state")), []);
  assert.deepEqual(readdirSync(join(fixture.directory, "runtime")), ["bus"]);
});

test("owner inventory reports sorted retained instances without changing their state", async (t) => {
  const fixture = await inventoryFixture(t);
  fixture.retain(
    "zeta",
    "fixture:stopped",
    "ActiveState=inactive\nSubState=dead\nResult=success\n",
  );
  fixture.retain(
    "beta",
    "fixture:failed",
    "ActiveState=failed\nSubState=failed\nResult=exit-code\n",
  );
  fixture.retain(
    "alpha",
    'path:/project#"shell"',
    "ActiveState=active\nSubState=running\nResult=success\n",
  );
  const before = readdirSync(fixture.directory, { recursive: true });
  const result = fixture.run();
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    version: 1,
    instances: [
      {
        user: owner,
        id: "alpha",
        reference: 'path:/project#"shell"',
        host: "drv.run.alpha",
        ready: true,
        activeState: "active",
        subState: "running",
        result: "success",
      },
      {
        user: owner,
        id: "beta",
        reference: "fixture:failed",
        host: "drv.run.beta",
        ready: false,
        activeState: "failed",
        subState: "failed",
        result: "exit-code",
      },
      {
        user: owner,
        id: "zeta",
        reference: "fixture:stopped",
        host: "drv.run.zeta",
        ready: false,
        activeState: "inactive",
        subState: "dead",
        result: "success",
      },
    ],
  });
  assert.deepEqual(readdirSync(fixture.directory, { recursive: true }), before);
});

test("owner inventory uses systemd readiness independently of SSH configuration", async (t) => {
  const fixture = await inventoryFixture(t);
  fixture.retain("alpha", "fixture:retained", "");
  mkdirSync(join(fixture.directory, "state/drv.run/alpha/ready"));
  const runtime = join(fixture.directory, "runtime/drv.run/alpha");
  mkdirSync(runtime, { recursive: true });
  for (const [activeState, subState, published, ready] of [
    ["active", "running", false, true],
    ["active", "running", true, true],
    ["inactive", "dead", true, false],
    ["activating", "start-post", false, false],
    ["activating", "start-post", true, false],
    ["active", "exited", true, false],
    ["failed", "failed", true, false],
  ] as const) {
    fixture.retain(
      "alpha",
      "fixture:retained",
      `ActiveState=${activeState}\nSubState=${subState}\nResult=success\n`,
    );
    if (published) writeFileSync(join(runtime, "ssh_config"), "private connection details");
    else rmSync(join(runtime, "ssh_config"), { force: true });
    const result = fixture.run();
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), {
      version: 1,
      instances: [
        {
          user: owner,
          id: "alpha",
          reference: "fixture:retained",
          host: "drv.run.alpha",
          ready,
          activeState,
          subState,
          result: "success",
        },
      ],
    });
  }
});

test("clean targets the instance only after preparation stops", async (t) => {
  const fixture = await inventoryFixture(t);
  fixture.retain(
    "alpha",
    "fixture:retained",
    "ActiveState=inactive\nSubState=dead\nResult=success\n",
  );
  const cli = join(fixture.directory, "drv.run");
  // Double root eligibility and the manager boundary; native tests use actual UIDs.
  writeFileSync(cli, readFileSync(cli, "utf8").replace("if ((EUID != 0)); then", "if false; then"));
  const systemctl = join(fixture.directory, "bin/systemctl");
  const original = readFileSync(systemctl, "utf8");
  writeFileSync(
    systemctl,
    original.replace(
      "test ! -e",
      `
if [[ \${2:-} == --machine=* ]]; then
  test "$2" = "--machine=$FIXTURE_OWNER@.host"
  case "$3" in
    show)
      test "$4" = drv.run-prepare@alpha.service
      cat "$FIXTURE/preparation"
      ;;
    clean)
      test "$4" = --what=state
      test "$5" = drv.run@alpha.service
      touch "$FIXTURE/cleaned"
      ;;
    *) exit 1 ;;
  esac
  exit 0
fi
test ! -e`,
    ),
  );
  for (const preparation of ["activating", "active", "deactivating", "inactive", "failed"]) {
    writeFileSync(join(fixture.directory, "preparation"), preparation + "\n");
    rmSync(join(fixture.directory, "cleaned"), { force: true });
    const stopped = preparation === "inactive" || preparation === "failed";
    assert.equal(fixture.run(["clean", "-u", owner, "alpha"]).status, stopped ? 0 : 1);
    assert.equal(existsSync(join(fixture.directory, "cleaned")), stopped);
  }
});

test("owner inventory fails discovery rather than returning an empty or partial document", async (t) => {
  const fixture = await inventoryFixture(t);
  writeFileSync(join(fixture.directory, "unavailable"), "");
  let result = fixture.run();
  assert.notEqual(result.status, 0);
  assert.throws(() => JSON.parse(result.stdout), SyntaxError);
  rmSync(join(fixture.directory, "unavailable"));

  fixture.retain(
    "alpha",
    "fixture:healthy",
    "ActiveState=active\nSubState=running\nResult=success\n",
  );
  fixture.retain(
    "beta",
    "fixture:unavailable",
    "ActiveState=inactive\nSubState=dead\nResult=success\n",
  );
  for (const broken of ["properties/drv.run@beta.service", "state/drv.run/beta/reference"]) {
    const path = join(fixture.directory, broken);
    const original = readFileSync(path);
    rmSync(path);
    if (broken.endsWith("reference")) writeFileSync(path, "");
    result = fixture.run();
    assert.notEqual(result.status, 0);
    assert.throws(() => JSON.parse(result.stdout), SyntaxError);
    writeFileSync(path, original);
  }
});

test("owner inventory distinguishes missing state from invalid state paths", async (t) => {
  const fixture = await inventoryFixture(t);
  for (const path of ["state/drv.run", "state"]) {
    const target = join(fixture.directory, path);
    rmSync(target, { recursive: true, force: true });
    writeFileSync(target, "not a directory");
    for (const args of [["list"], ["list", "--json"]]) {
      const result = fixture.run(args);
      assert.notEqual(result.status, 0);
      if (args.includes("--json")) assert.throws(() => JSON.parse(result.stdout), SyntaxError);
    }
    rmSync(target);
  }
  const result = fixture.run();
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), { version: 1, instances: [] });
});

test("owner inventory follows owner state-directory links without treating invalid names as IDs", async (t) => {
  const fixture = await inventoryFixture(t);
  fixture.retain(
    "alpha",
    "fixture:retained",
    "ActiveState=inactive\nSubState=dead\nResult=success\n",
  );
  fixture.retain("alpha\nbeta", "fixture:not-an-id", "");
  const state = join(fixture.directory, "state/drv.run");
  const target = join(fixture.directory, "retained");
  renameSync(state, target);
  symlinkSync(target, state);
  const result = fixture.run();
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    version: 1,
    instances: [
      {
        user: owner,
        id: "alpha",
        reference: "fixture:retained",
        host: "drv.run.alpha",
        ready: false,
        activeState: "inactive",
        subState: "dead",
        result: "success",
      },
    ],
  });
});

test("list formats preserve authorized owner selection without changing instance state", async (t) => {
  const fixture = await inventoryFixture(t);
  fixture.retain(
    "alpha",
    "fixture:retained",
    "ActiveState=inactive\nSubState=dead\nResult=success\n",
  );
  const before = readdirSync(fixture.directory, { recursive: true });
  const argumentsList = [["list"], ["list", "--json"]];
  if (uid === 0) {
    argumentsList.push(
      ["list", "--json", "-u", owner],
      ["list", "-u", owner, "--json"],
      ["list", "-u", owner],
    );
  }
  for (const args of argumentsList) {
    const result = fixture.run(args);
    assert.equal(result.status, 0);
    if (args.includes("--json")) {
      assert.deepEqual(JSON.parse(result.stdout), {
        version: 1,
        instances: [
          {
            user: owner,
            id: "alpha",
            reference: "fixture:retained",
            host: "drv.run.alpha",
            ready: false,
            activeState: "inactive",
            subState: "dead",
            result: "success",
          },
        ],
      });
    }
  }
  assert.deepEqual(readdirSync(fixture.directory, { recursive: true }), before);
});

test("inventory rejects unauthorized owner selectors and extra arguments without creating instances", async (t) => {
  const fixture = await inventoryFixture(t);
  for (const args of [
    ["list", "--json", "-u", "other"],
    ["list", "-u", "other", "--json"],
    ["list", "--json", "extra"],
    ["list", "--json", "--json"],
    ["list", "-u", "other"],
  ]) {
    const result = fixture.run(args);
    assert.notEqual(result.status, 0);
    if (args.includes("--json")) assert.throws(() => JSON.parse(result.stdout), SyntaxError);
  }
  assert.deepEqual(readdirSync(join(fixture.directory, "state")), []);
  assert.deepEqual(readdirSync(join(fixture.directory, "runtime")), ["bus"]);
});

test("owner inventory fails on corrupt retained references instead of omitting the instance", async (t) => {
  const fixture = await inventoryFixture(t);
  fixture.retain(
    "alpha",
    "fixture:healthy",
    "ActiveState=active\nSubState=running\nResult=success\n",
  );
  fixture.retain(
    "beta",
    "fixture:retained",
    "ActiveState=inactive\nSubState=dead\nResult=success\n",
  );
  const path = join(fixture.directory, "state/drv.run/beta/reference");
  for (const corruption of ["directory", "dangling", "missing", "", "-option", "not a reference"]) {
    rmSync(path, { recursive: true, force: true });
    if (corruption === "directory") mkdirSync(path);
    else if (corruption === "dangling") symlinkSync(join(fixture.directory, "missing"), path);
    else if (corruption !== "missing") writeFileSync(path, `${corruption}\n`);
    const result = fixture.run();
    assert.notEqual(result.status, 0);
    assert.throws(() => JSON.parse(result.stdout), SyntaxError);
  }
});

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
        ? "runtime/drv.run/000000000000002a"
        : "state/drv.run/000000000000002a",
    );
    if (collision !== "none") {
      mkdirSync(retained, { recursive: true });
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
    const runtime = join(directory, `runtime/drv.run/${id}`);
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
