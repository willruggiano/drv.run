import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const assembler = fileURLToPath(new URL("../main.py", import.meta.url));

test("producer trees become a private snapshot with separate environment metadata", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "guest-files-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const inputs = join(directory, "inputs");
  const image = join(directory, "seed.img");
  const environment = join(directory, "prepared-environment");
  writeFileSync(environment, "{}");
  const paths = [
    ["core/root/.ssh/authorized_keys", "fixture-public-key\n"],
    ["integration/root/.config/fixture/settings.json", '{"capability":"fake"}\n'],
  ] as const;
  for (const [path, contents] of paths) {
    const file = join(inputs, path);
    mkdirSync(dirname(file), { recursive: true, mode: 0o755 });
    writeFileSync(file, contents, { mode: 0o600 });
  }
  for (const producer of ["core", "integration"]) {
    chmodSync(join(inputs, producer, "root"), 0o700);
  }
  const assembled = spawnSync(
    "python3",
    ["-B", assembler, "--inputs", inputs, "--environment", environment, "--output", image],
    { stdio: "inherit" },
  );
  assert.ifError(assembled.error);
  assert.equal(assembled.status, 0);
  assert.equal(statSync(image).mode & 0o777, 0o600);
  const original = readFileSync(image);
  writeFileSync(join(inputs, paths[1][0]), '{"capability":"changed-after-assembly"}\n');
  assert.deepEqual(readFileSync(image), original);
  const extracted = join(directory, "extracted");
  const extraction = spawnSync("fsck.erofs", [`--extract=${extracted}`, image], {
    stdio: "inherit",
  });
  assert.ifError(extraction.error);
  assert.equal(extraction.status, 0);
  assert.equal(readFileSync(join(extracted, "environment"), "utf8"), `${environment}\n`);
  for (const [path, contents] of paths) {
    assert.equal(
      readFileSync(join(extracted, "rootfs", path.slice(path.indexOf("/") + 1)), "utf8"),
      contents,
    );
  }
});

for (const contents of ["competing-file", "core-file"]) {
  test(`competing guest paths fail without publication (${contents})`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), "guest-files-collision-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const inputs = join(directory, "inputs");
    const image = join(directory, "seed.img");
    const environment = join(directory, "environment");
    writeFileSync(environment, "{}");
    for (const [producer, content] of [
      ["core", "core-file"],
      ["integration", contents],
    ] as const) {
      const file = join(inputs, producer, "etc/ssh/ssh_host_ed25519_key");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
    const result = spawnSync(
      "python3",
      ["-B", assembler, "--inputs", inputs, "--environment", environment, "--output", image],
      { stdio: "ignore" },
    );
    assert.ifError(result.error);
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(image), false);
    assert.deepEqual(readdirSync(directory).toSorted(), ["environment", "inputs"]);
  });
}

for (const kind of ["file symlink", "directory symlink", "producer symlink", "hardlink"] as const) {
  test(`input trees cannot import external files through a ${kind}`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), "guest-files-escape-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const inputs = join(directory, "inputs");
    const external = join(directory, "external");
    const environment = join(directory, "environment");
    const image = join(directory, "seed.img");
    mkdirSync(inputs);
    mkdirSync(external);
    writeFileSync(join(external, "secret"), "host-only-fixture");
    writeFileSync(environment, "{}");
    if (kind === "producer symlink") {
      symlinkSync(external, join(inputs, "integration"));
    } else {
      const parent = join(inputs, "integration/root");
      mkdirSync(parent, { recursive: true });
      if (kind === "hardlink") linkSync(join(external, "secret"), join(parent, "leak"));
      else
        symlinkSync(
          kind === "file symlink" ? join(external, "secret") : external,
          join(parent, "leak"),
        );
    }
    const result = spawnSync(
      "python3",
      ["-B", assembler, "--inputs", inputs, "--environment", environment, "--output", image],
      { stdio: "ignore" },
    );
    assert.ifError(result.error);
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(image), false);
    assert.deepEqual(readdirSync(directory).toSorted(), ["environment", "external", "inputs"]);
  });
}

test("shared directory permissions cannot depend on producer order", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "guest-files-modes-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const inputs = join(directory, "inputs");
  const environment = join(directory, "environment");
  const image = join(directory, "seed.img");
  writeFileSync(environment, "{}");
  for (const [producer, mode] of [
    ["core", 0o700],
    ["integration", 0o755],
  ] as const) {
    const root = join(inputs, producer, "root");
    mkdirSync(root, { recursive: true });
    chmodSync(root, mode);
    writeFileSync(join(root, producer), producer);
  }
  const result = spawnSync(
    "python3",
    ["-B", assembler, "--inputs", inputs, "--environment", environment, "--output", image],
    { stdio: "ignore" },
  );
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(image), false);
});

for (const [reserved, rejected] of [
  ["/run", "run/value"],
  ["/root/.config/builtin", "root/.config/builtin/value"],
  ["/root/.config/builtin", "root/.config"],
] as const) {
  test(`reserved guest path ${reserved} rejects ${rejected}, not unrelated files`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), "guest-files-reserved-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const inputs = join(directory, "inputs");
    const producer = join(inputs, "integration");
    const image = join(directory, "seed.img");
    const environment = join(directory, "environment");
    writeFileSync(environment, "{}");
    const allowed = join(producer, "root/.config/fixture/settings");
    mkdirSync(dirname(allowed), { recursive: true });
    writeFileSync(allowed, "allowed");
    const assemble = () =>
      spawnSync(
        "python3",
        [
          "-B",
          assembler,
          "--inputs",
          inputs,
          "--environment",
          environment,
          "--output",
          image,
          "--reserved-path",
          reserved,
        ],
        { stdio: "ignore" },
      );
    const accepted = assemble();
    assert.ifError(accepted.error);
    assert.equal(accepted.status, 0);
    assert.equal(existsSync(image), true);
    rmSync(image);
    rmSync(producer, { recursive: true });
    const forbidden = join(producer, rejected);
    mkdirSync(dirname(forbidden), { recursive: true });
    writeFileSync(forbidden, "unsupported");
    const denied = assemble();
    assert.ifError(denied.error);
    assert.notEqual(denied.status, 0);
    assert.equal(existsSync(image), false);
  });
}

test("publication requires a fresh output rather than replacing an existing snapshot", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "guest-files-existing-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const inputs = join(directory, "inputs");
  const environment = join(directory, "environment");
  const image = join(directory, "seed.img");
  mkdirSync(join(inputs, "core"), { recursive: true });
  writeFileSync(environment, "{}");
  writeFileSync(image, "existing-snapshot");
  const result = spawnSync(
    "python3",
    ["-B", assembler, "--inputs", inputs, "--environment", environment, "--output", image],
    { stdio: "ignore" },
  );
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(image, "utf8"), "existing-snapshot");
  assert.deepEqual(readdirSync(directory).toSorted(), ["environment", "inputs", "seed.img"]);
});

for (const fileProducer of ["core", "integration"]) {
  test(`file/directory conflicts fail when ${fileProducer} supplies the file`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), "guest-files-types-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const inputs = join(directory, "inputs");
    const environment = join(directory, "environment");
    const image = join(directory, "seed.img");
    writeFileSync(environment, "{}");
    for (const producer of ["core", "integration"]) {
      const path = join(inputs, producer, "etc/value");
      mkdirSync(dirname(path), { recursive: true });
      if (producer === fileProducer) writeFileSync(path, "file");
      else {
        mkdirSync(path);
        writeFileSync(join(path, "child"), "nested");
      }
    }
    const result = spawnSync(
      "python3",
      ["-B", assembler, "--inputs", inputs, "--environment", environment, "--output", image],
      { stdio: "ignore" },
    );
    assert.ifError(result.error);
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(image), false);
  });
}

test("a failing image tool cannot publish its partial artifact", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "guest-files-tool-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const inputs = join(directory, "inputs");
  const environment = join(directory, "environment");
  const image = join(directory, "seed.img");
  const bin = join(directory, "bin");
  mkdirSync(join(inputs, "core"), { recursive: true });
  mkdirSync(bin);
  writeFileSync(environment, "{}");
  // mkfs.erofs is an external tool boundary; its positional interface is DEST SOURCE.
  writeFileSync(
    join(bin, "mkfs.erofs"),
    `#!${process.execPath}
const fs = require("node:fs");
fs.writeFileSync(process.argv.at(-2), "partial-image");
process.exit(42);
`,
    { mode: 0o755 },
  );
  const result = spawnSync(
    "python3",
    ["-B", assembler, "--inputs", inputs, "--environment", environment, "--output", image],
    { stdio: "ignore", env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` } },
  );
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(image), false);
  assert.deepEqual(readdirSync(directory).toSorted(), ["bin", "environment", "inputs"]);
});

test("special nodes fail without opening a blocking input or publishing an image", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "guest-files-special-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const inputs = join(directory, "inputs");
  const parent = join(inputs, "integration/root");
  const environment = join(directory, "environment");
  const image = join(directory, "seed.img");
  mkdirSync(parent, { recursive: true });
  writeFileSync(environment, "{}");
  const fixture = spawnSync(
    "python3",
    ["-c", "import os, sys; os.mkfifo(sys.argv[1])", join(parent, "fifo")],
    { stdio: "inherit" },
  );
  assert.ifError(fixture.error);
  assert.equal(fixture.status, 0);
  const result = spawnSync(
    "python3",
    ["-B", assembler, "--inputs", inputs, "--environment", environment, "--output", image],
    { stdio: "ignore", timeout: 10000 },
  );
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(image), false);
  assert.deepEqual(readdirSync(directory).toSorted(), ["environment", "inputs"]);
});
