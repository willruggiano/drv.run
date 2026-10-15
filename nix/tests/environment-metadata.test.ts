import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

type PathInfo = {
  narHash: string;
  narSize: number;
  references: string[];
};

const check = fileURLToPath(
  new URL("../../nixosModules/guest/environment-metadata.jq", import.meta.url),
);
const a = "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-a";
const b = "/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-b";
const info: PathInfo = { narHash: "sha256-fixture", narSize: 42, references: [] };

const cases: {
  name: string;
  image: Record<string, PathInfo>;
  registered: Record<string, PathInfo>;
  accepted: boolean;
}[] = [
  { name: "fresh closure", image: { [a]: info }, registered: {}, accepted: true },
  {
    name: "identical overlap on restart",
    image: { [a]: info },
    registered: { [a]: info },
    accepted: true,
  },
  ...(["narHash", "narSize", "references"] as const).map((field) => ({
    name: `conflicting ${field}`,
    image: { [a]: info, [b]: info },
    registered: {
      [a]: { ...info, [field]: { narHash: "sha256-other", narSize: 43, references: [b] }[field] },
    },
    accepted: false,
  })),
  {
    name: "unrelated private store path",
    image: { [a]: info },
    registered: { [b]: info },
    accepted: true,
  },
  {
    name: "references are sets",
    image: { [a]: { ...info, references: [a, b] }, [b]: info },
    registered: { [a]: { ...info, references: [b, a] } },
    accepted: true,
  },
  {
    name: "incomplete closure",
    image: { [a]: { ...info, references: [b] } },
    registered: {},
    accepted: false,
  },
];

for (const { name, image, registered, accepted } of cases) {
  test(name, (t) => {
    const directory = mkdtempSync(join(tmpdir(), "environment-metadata-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const existing = join(directory, "registered.json");
    const manifest = join(directory, "image.json");
    writeFileSync(existing, JSON.stringify(registered));
    writeFileSync(manifest, JSON.stringify(image));
    const result = spawnSync(
      "jq",
      ["--exit-status", "--slurpfile", "registered", existing, "--from-file", check, manifest],
      { stdio: "ignore" },
    );
    assert.ifError(result.error);
    assert.equal(result.status, accepted ? 0 : 1);
  });
}
