import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { context } from "../src/application.ts";
import { suite } from "../bench/index.ts";
import type { Patch } from "../src/watch.ts";
import { fixture, form } from "./fixtures.ts";

await test("benchmark selects the largest stored conversation and builds all workloads without mutating the database", async (t) => {
  const { app, database, selection } = await fixture(t);
  const small = await app.createConversation(form(selection));
  const large = await app.createConversation(form(selection));
  const code = "```ts\nconst answer = 42;\n```";
  const first = await large.commit(async (tx) => {
    const call = await tx.appendEntry(large.id, {
      kind: "pi.assistant",
      model: [
        fauxAssistantMessage([
          { type: "text", text: code },
          fauxToolCall("read", { path: "note.txt" }, { id: "read-note" }),
        ]),
      ],
    });
    await tx.appendEntry(large.id, {
      kind: "pi.tool-result",
      model: [
        {
          role: "toolResult",
          toolCallId: "read-note",
          toolName: "read",
          content: [{ type: "text", text: "The complete tool output." }],
          isError: false,
          timestamp: 1,
        },
      ],
    });
    for (let index = 0; index < 100; index++)
      await tx.appendEntry(large.id, {
        kind: "pi.assistant",
        model: [fauxAssistantMessage("Answer.")],
      });
    const reset = await tx.appendEntry(large.id, { kind: "pi.reset", head: "self" });
    await tx.appendEntry(large.id, {
      kind: "pi.compaction",
      head: reset.id,
      model: [fauxAssistantMessage("Summary.")],
    });
    return call;
  }, context);
  const path = database;
  const before = await readFile(path);
  const automatic = suite(relative(process.cwd(), path));
  assert.equal(automatic.db, path);
  assert.equal(automatic.conversation, large.id);
  assert.equal(automatic.storedEntries, 104);
  assert.deepEqual(automatic.synthetic, {
    chunks: 16,
    responseEntry: first.id,
    toolCallEntry: first.id,
  });
  assert.deepEqual(
    automatic.cases.map(({ name, operations }) => [name, operations]),
    [
      ["initial-window", 1],
      ["history-pages", 3],
      ["entry-appends", 104],
      ["context-boundaries", 2],
      ["synthetic-response-and-finalization", 17],
      ["synthetic-tool-progress", 16],
    ],
  );
  // Exercise the work once for correctness, not timings or benchmark thresholds in CI.
  for (const scenario of automatic.cases) {
    const run = await scenario.setup();
    const frames: (readonly Patch[])[] = [];
    await run((patches) => frames.push(patches));
    assert.equal(frames.length, scenario.operations);
    assert(frames.some((patches) => patches.length > 0));
    if (scenario.name === "synthetic-tool-progress") {
      assert(frames.every((patches) => patches.length === 1));
      assert(frames.every((patches) => patches[0]?.mode === undefined));
    }
    if (scenario.name === "entry-appends")
      assert.equal(frames.flat().filter((patch) => patch.mode === "append").length, 102);
  }
  assert.deepEqual(await readFile(path), before);
  const explicit = suite(path, small.id);
  assert.equal(explicit.conversation, small.id);
  assert.equal(explicit.storedEntries, 0);
  assert.deepEqual(
    explicit.cases.map(({ name }) => name),
    ["initial-window"],
  );
  await app.close();
  assert.equal(suite(path).storedEntries, 104);
});

await test("benchmark selection is deterministic and invalid input cannot create a database", async (t) => {
  const { app, directory, database, selection } = await fixture(t);
  const path = database;
  assert.throws(() => suite(path));
  const first = await app.createConversation(form(selection));
  await app.createConversation(form(selection));
  assert.equal(suite(path).conversation, first.id);
  assert.throws(() => suite(path, -1));
  assert.throws(() => suite(path, 0.5));
  assert.throws(() => suite(path, Number.MAX_SAFE_INTEGER + 1));
  assert.throws(() => suite(path, Number.MAX_SAFE_INTEGER));
  const missing = join(directory, "missing.sqlite");
  assert.throws(() => suite(missing));
  await assert.rejects(stat(missing), { code: "ENOENT" });
  for (const args of [[], ["--db", path, "--conversation", "nope"], ["--db", path, "--unknown"]]) {
    const child = spawnSync(process.execPath, [
      new URL("../bench/index.ts", import.meta.url).pathname,
      ...args,
    ]);
    assert.equal(child.status, 1);
  }
});
