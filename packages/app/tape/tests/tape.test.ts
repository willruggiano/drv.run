import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { defineDoc, LiveDoc } from "@earendil-works/pi-durable";
import { decode, PresentationDoc, viewer, maxBytes, maxFrames, live } from "../model.ts";
import { record, openState, initial, apply, Recorder } from "../state.ts";
import { options, selected, run } from "../main.ts";

async function directory(t: TestContext) {
  const path = await mkdtemp(join(tmpdir(), "tape-test-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

await test("controlled recording is deterministic, typed, ordered and portable", async (t) => {
  const first = await record(await directory(t), "session-settings");
  const second = await record(await directory(t), "session-settings");
  assert.deepEqual(first, second);
  assert.deepEqual(decode(JSON.stringify(first)), first);
  assert.deepEqual(
    first.frames.filter((frame) => frame.type === "capture").map((frame) => frame.name),
    ["conversation", "draft", "settings", "returned", "partial-response", "settled"],
  );
  assert(
    first.frames.some(
      (frame) =>
        frame.type === "commit" &&
        frame.changes.some((change) => change.kind === "pi.live" && change.value.generation),
    ),
  );
});

await test("decoder rejects unsupported execution, fields, versions and incomplete recordings", async (t) => {
  const tape = await record(await directory(t), "session-settings");
  for (const change of [
    { kind: "pi.live", version: 1, value: { run: { taskId: 5, inputs: [] } } },
    { kind: "pi.agent", version: 1, value: { instructions: "execute" } },
    { kind: "pi.live", version: 2, value: {} },
    { kind: "app.presentation", version: 1, key: "another-tab", value: initial.presentation },
  ])
    assert.throws(() =>
      decode(
        JSON.stringify({
          ...tape,
          frames: [
            { type: "commit", seq: 1, changes: [change] },
            { type: "capture", name: "done" },
          ],
        }),
      ),
    );
  for (const extra of [
    { complete: false },
    { version: 2 },
    { kind: "trace" },
    { scene: "../escape" },
    { execute: "code" },
  ])
    assert.throws(() => decode(JSON.stringify({ ...tape, ...extra })));
  assert.throws(() => decode(" ".repeat(maxBytes + 1)));
  assert.throws(() =>
    decode(
      JSON.stringify({
        ...tape,
        frames: [
          { type: "capture", name: "same" },
          { type: "capture", name: "same" },
        ],
      }),
    ),
  );
});

await test("commit sequence gaps are valid but reordering and duplicates are not", async (t) => {
  const tape = await record(await directory(t), "context");
  const frames = tape.frames.filter((frame) => frame.type === "commit");
  const candidate = {
    ...tape,
    frames: [
      { ...frames[0], seq: 10 },
      { ...frames[1], seq: 30 },
      { type: "capture", name: "done" },
    ],
  };
  assert.doesNotThrow(() => decode(JSON.stringify(candidate)));
  candidate.frames[1] = { ...frames[1], seq: 10 };
  assert.throws(() => decode(JSON.stringify(candidate)));
  candidate.frames[1] = { ...frames[1], seq: 9 };
  assert.throws(() => decode(JSON.stringify(candidate)));
});

await test("presentation is persisted per viewer but excluded from ConversationView", async (t) => {
  const state = await openState(await directory(t), initial);
  t.after(() => state.close());
  const other = { panel: "context" as const, draft: "Other viewer's draft" };
  await state.session.root.commit(async (tx) => {
    Object.assign(await tx.doc(PresentationDoc, "other", null), other);
  }, context);
  const watch = await state.session.root.watch(context);
  t.after(() => watch.stop());
  assert.equal(watch.value.docs[PresentationDoc.definition.kind], undefined);
  await apply(state.session, {
    type: "commit",
    seq: 1,
    changes: [
      {
        kind: "app.presentation",
        version: 1,
        key: viewer,
        value: { panel: "settings", draft: "Mine" },
      },
    ],
  });
  assert.deepEqual(await state.session.harness.snapshot(PresentationDoc, "other", context), other);
  assert.deepEqual(await state.session.harness.snapshot(PresentationDoc, viewer, context), {
    panel: "settings",
    draft: "Mine",
  });
  const latest = await state.session.root.watch(context);
  try {
    assert.equal(latest.value.docs[PresentationDoc.definition.kind], undefined);
  } finally {
    await latest.stop();
  }
  await state.check();
});

await test("recorder filters bookkeeping and surfaces invalid observations", async (t) => {
  const state = await openState(await directory(t), initial);
  t.after(() => state.close());
  const recorder = new Recorder(state.session);
  t.after(() => recorder.close());
  const Bookkeeping = defineDoc<{ frames: number }>({
    kind: "app.showcase.tape",
    version: 1,
    scope: "session",
    initial: () => ({ frames: 0 }),
    checkpointWhen: () => true,
  });
  await state.session.root.commit(async (tx) => {
    (await tx.doc(Bookkeeping)).frames++;
  }, context);
  assert.deepEqual(recorder.frames, []);
  await state.session.root.commit(async (tx) => {
    (await tx.doc(PresentationDoc, viewer, null)).draft = "Atomic update";
    Object.assign(await tx.doc(LiveDoc, state.session.root.id), { generation: { attempt: 2 } });
  }, context);
  assert.throws(() => recorder.finish("invalid", initial));
});

await test("recorder keeps a publication atomic and fails on overflow or use after finish", async (t) => {
  const state = await openState(await directory(t), initial);
  t.after(() => state.close());
  const recorder = new Recorder(state.session);
  t.after(() => recorder.close());
  const message = initial.entries[1].model[0];
  await state.session.root.commit(async (tx) => {
    (await tx.doc(PresentationDoc, viewer, null)).draft = "Both changes";
    Object.assign(
      await tx.doc(LiveDoc, state.session.root.id),
      live({ generation: { attempt: 1, message } }),
    );
  }, context);
  assert.equal(recorder.frames.length, 1);
  const [frame] = recorder.frames;
  assert(frame.type === "commit");
  assert.deepEqual(frame.changes.map((change) => change.kind).sort(), [
    "app.presentation",
    "pi.live",
  ]);
  recorder.capture("done");
  recorder.finish("atomic", initial);
  assert.throws(() => recorder.capture("late"));
  const bounded = new Recorder(state.session);
  t.after(() => bounded.close());
  for (let i = 0; i < maxFrames; i++) bounded.capture(`frame-${i}`);
  assert.throws(() => bounded.capture("overflow"));
});

await test("CLI rejects invalid selections without silently doing nothing", () => {
  assert.deepEqual(selected("*settings"), ["session-settings"]);
  assert.deepEqual(options(["--profile", "mobile"]).profiles, ["mobile"]);
  assert.throws(() => selected("missing"));
  for (const args of [
    ["--profile", "watch"],
    ["--out"],
    ["--scene"],
    ["--list", "--list"],
    ["--tape", "file", "--scene", "*"],
  ])
    assert.throws(() => options(args));
});

await test("record-only rejects cancellation before creating a run", async (t) => {
  const output = await directory(t);
  const reason = new Error("Cancelled before recording");
  await assert.rejects(
    run(["--record-only", "--output", output], AbortSignal.abort(reason)),
    (error) => error === reason,
  );
  assert.deepEqual(await readdir(output), []);
});

function manifestComplete(root: string) {
  const manifest: unknown = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  assert(
    manifest !== null &&
      typeof manifest === "object" &&
      "complete" in manifest &&
      typeof manifest.complete === "boolean",
  );
  return manifest.complete;
}

for (const stage of ["after-export", "before-complete", "after-save"] as const) {
  await test(`record-only cancellation ${stage} leaves an incomplete manifest`, async (t) => {
    const output = await directory(t);
    const controller = new AbortController();
    const reason = new Error(`Cancelled ${stage}`);
    const check = controller.signal.throwIfAborted.bind(controller.signal);
    // Abort at an observable artifact boundary, not after a timing-dependent sleep.
    t.mock.method(controller.signal, "throwIfAborted", () => {
      const [runDirectory] = readdirSync(output);
      if (runDirectory) {
        const root = join(output, runDirectory);
        const ready =
          stage === "after-export"
            ? existsSync(join(root, "session-settings", "tape.json"))
            : stage === "before-complete"
              ? existsSync(join(root, "index.html"))
              : existsSync(join(root, "manifest.json")) && manifestComplete(root);
        if (ready) controller.abort(reason);
      }
      check();
    });
    await assert.rejects(
      run(["--record-only", "--output", output], controller.signal),
      (error) => error === reason,
    );
    const directories = await readdir(output);
    assert.equal(directories.length, 1);
    assert.equal(manifestComplete(join(output, directories[0])), false);
  });
}
