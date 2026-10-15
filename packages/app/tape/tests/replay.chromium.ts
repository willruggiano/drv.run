import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { buildAssets } from "../../serve/build.ts";
import { record } from "../state.ts";
import { decode, digest } from "../model.ts";
import { replay } from "../browser.ts";

await test(
  "CDP replays a portable tape twice and across profiles through the real app",
  { timeout: 90_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "tape-browser-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const assets = join(directory, "assets");
    await buildAssets(fileURLToPath(new URL("../../serve/", import.meta.url)), assets);
    const tape = await record(join(directory, "record"), "session-settings");
    const signal = t.signal;
    const first = await replay(tape, "mobile", assets, join(directory, "first"), signal);
    const second = await replay(tape, "mobile", assets, join(directory, "second"), signal);
    // Pixel comparison proves the fixture/environment, not a baseline UI gate.
    assert.deepEqual(first.captures, second.captures);
    const desktop = await replay(tape, "desktop", assets, join(directory, "desktop"), signal);
    assert.deepEqual(
      first.captures.map(({ name, stateHash }) => ({ name, stateHash })),
      desktop.captures.map(({ name, stateHash }) => ({ name, stateHash })),
    );
  },
);

await test(
  "imported live Markdown and multiple text blocks acknowledge the rendered DOM",
  { timeout: 90_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "tape-markdown-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const assets = join(directory, "assets");
    await buildAssets(fileURLToPath(new URL("../../serve/", import.meta.url)), assets);
    const source = await record(join(directory, "record"), "session-settings");
    for (const [index, blocks] of [
      ["**bold** and `inline code`"],
      ["First block", "Second block"],
      ["# Heading\n\n**Explanation**", "```ts\nconst ready = true;\n```"],
    ].entries()) {
      await t.test(`content case ${index}`, async () => {
        const candidate = structuredClone(source);
        let replaced = false;
        for (const frame of candidate.frames) {
          if (frame.type !== "commit") continue;
          for (const change of frame.changes) {
            if (change.kind !== "pi.live" || !change.value.generation?.message) continue;
            change.value.generation.message.content = blocks.map((text) => ({
              type: "text",
              text,
            }));
            replaced = true;
          }
        }
        assert(replaced);
        const tape = decode(JSON.stringify(candidate));
        const result = await replay(
          tape,
          "mobile",
          assets,
          join(directory, `case-${index}`),
          t.signal,
        );
        assert.equal(
          result.captures.length,
          tape.frames.filter((frame) => frame.type === "capture").length,
        );
      });
    }
  },
);

for (const scene of ["context", "default-preferences"] as const)
  await test(
    `returning from ${scene} and changing or clearing the draft needs one commit`,
    { timeout: 90_000 },
    async (t) => {
      const directory = await mkdtemp(join(tmpdir(), "tape-context-draft-"));
      t.after(() => rm(directory, { recursive: true, force: true }));
      const assets = join(directory, "assets");
      await buildAssets(fileURLToPath(new URL("../../serve/", import.meta.url)), assets);
      const source = await record(join(directory, "record"), scene);
      for (const draft of ["A changed draft on return", ""]) {
        await t.test(draft ? "change" : "clear", async () => {
          const candidate = structuredClone(source);
          let previous = candidate.initial.presentation.panel;
          let replaced = false;
          for (const frame of candidate.frames) {
            if (frame.type !== "commit") continue;
            for (const change of frame.changes) {
              if (change.kind !== "app.presentation") continue;
              if (
                previous === (scene === "context" ? "context" : "defaults") &&
                change.value.panel === "conversation"
              ) {
                change.value.draft = draft;
                replaced = true;
              }
              previous = change.value.panel;
            }
          }
          assert(replaced);
          const tape = decode(JSON.stringify(candidate));
          const result = await replay(
            tape,
            "mobile",
            assets,
            join(directory, draft ? "changed" : "cleared"),
            t.signal,
          );
          const returned = result.captures.find((capture) => capture.name === "returned");
          assert(returned);
          assert.equal(
            returned.stateHash,
            digest(JSON.stringify({ presentation: { panel: "conversation", draft }, live: {} })),
          );
        });
      }
    },
  );
