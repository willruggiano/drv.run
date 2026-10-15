import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const script = readFileSync(new URL("../setup-notifications.sh", import.meta.url));
const tools = ["bash", "dirname", "mktemp", "ln", "rm", "jq"].map((name) => {
  const path = (process.env.PATH ?? "")
    .split(":")
    .map((directory) => join(directory, name))
    .find(existsSync);
  assert.ok(path, `${name} is required for the provisioning fixture`);
  return { name, path };
});

for (const mode of [
  "create",
  "encrypt-failure",
  "generate-failure",
  "existing",
  "symlink",
  "race",
  "no-recipient",
  "arguments",
] as const) {
  test(`VAPID provisioning: ${mode}`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), "setup-notifications-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const scripts = join(directory, "scripts");
    const secrets = join(directory, "examples/rock5b/secrets");
    const bin = join(directory, "bin");
    for (const path of [scripts, secrets, bin]) mkdirSync(path, { recursive: true });
    // No Nix or ambient executables: tests must not fetch dependencies.
    for (const { name, path } of tools) symlinkSync(path, join(bin, name));
    if (mode === "generate-failure") {
      // SOPS still succeeds: only pipefail can prevent publishing this result.
      writeFileSync(
        join(bin, "node"),
        `#!${join(bin, "bash")}\n"${process.execPath}" "$@"\nif [[ $1 != --version ]]; then exit 1; fi\n`,
        { mode: 0o755 },
      );
    } else {
      symlinkSync(process.execPath, join(bin, "node"));
    }
    const entry = join(scripts, "setup-notifications.sh");
    const secret = join(secrets, "notifications-vapid");
    const boundary = join(directory, "encryption.json");
    writeFileSync(entry, script);
    writeFileSync(
      join(secrets, "tailscale-auth-key"),
      JSON.stringify({
        sops: {
          age:
            mode === "no-recipient"
              ? []
              : [{ recipient: "age1host" }, { recipient: "age1operator" }],
        },
      }),
    );
    if (mode === "existing") writeFileSync(secret, JSON.stringify({ existing: true }));
    if (mode === "symlink") symlinkSync(join(directory, "absent"), secret);

    // Exercise real key generation; the SOPS boundary validates its input but
    // persists only public metadata and opaque fixture ciphertext, never the JWK.
    writeFileSync(
      join(bin, "sops"),
      `#!${process.execPath}
const assert = require("node:assert/strict");
const { createPrivateKey, createPublicKey, sign, verify } = require("node:crypto");
const { readFileSync, writeFileSync } = require("node:fs");
if (process.argv[2] === "--version") process.exit(0);
assert.deepEqual(process.argv.slice(2), [
  "--encrypt", "--age", "age1host,age1operator",
  "--input-type", "binary", "--output-type", "json", "/dev/stdin",
]);
const privateKey = createPrivateKey({ key: JSON.parse(readFileSync(0, "utf8")), format: "jwk" });
assert.equal(privateKey.asymmetricKeyType, "ec");
assert.equal(privateKey.asymmetricKeyDetails.namedCurve, "prime256v1");
const publicKey = createPublicKey(privateKey);
const message = Buffer.from("fixture");
assert.ok(verify("sha256", message, publicKey, sign("sha256", message, privateKey)));
writeFileSync(process.env.BOUNDARY, JSON.stringify(publicKey.export({ format: "jwk" })));
if (process.env.MODE === "race") {
  writeFileSync(process.env.SECRET, JSON.stringify({ existing: true }), { flag: "wx" });
}
process.stdout.write(JSON.stringify({ encrypted: true }));
if (process.env.MODE === "encrypt-failure") process.exitCode = 1;
`,
      { mode: 0o755 },
    );
    const result = spawnSync("bash", [entry, ...(mode === "arguments" ? ["unexpected"] : [])], {
      cwd: tmpdir(),
      env: {
        ...process.env,
        PATH: bin,
        MODE: mode,
        SECRET: secret,
        BOUNDARY: boundary,
      },
      stdio: "ignore",
      timeout: 10000,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status === 0, mode === "create");
    const encrypted = ["create", "encrypt-failure", "generate-failure", "race"].includes(mode);
    assert.equal(existsSync(boundary), encrypted);
    if (encrypted) {
      const publicKey = JSON.parse(readFileSync(boundary, "utf8"));
      assert.equal(publicKey.crv, "P-256");
      assert.equal(Object.hasOwn(publicKey, "d"), false);
    }
    if (mode === "create") {
      assert.deepEqual(JSON.parse(readFileSync(secret, "utf8")), { encrypted: true });
      assert.equal(statSync(secret).mode & 0o777, 0o600);
    } else if (mode === "existing" || mode === "race") {
      assert.deepEqual(JSON.parse(readFileSync(secret, "utf8")), { existing: true });
    } else if (mode === "symlink") {
      assert.equal(readlinkSync(secret), join(directory, "absent"));
      assert.equal(existsSync(join(directory, "absent")), false);
    } else {
      assert.equal(existsSync(secret), false);
    }
    assert.deepEqual(
      readdirSync(secrets).sort(),
      [
        "tailscale-auth-key",
        ...(["create", "existing", "symlink", "race"].includes(mode)
          ? ["notifications-vapid"]
          : []),
      ].sort(),
    );
  });
}
