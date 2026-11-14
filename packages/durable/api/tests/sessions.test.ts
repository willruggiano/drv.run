import assert from "node:assert/strict";
import { test } from "node:test";
import type { Harness } from "@earendil-works/pi-durable";
import { Problem } from "../src/problem.ts";
import { Sessions } from "../src/sessions.ts";

await test("sessions retry failed opens and promote a miss to a requested provision", async () => {
  const opened: boolean[] = [];
  const sessions = new Sessions(async (_id, _context, create) => {
    opened.push(create);
    if (opened.length === 1) throw new Error("open failed");
    return undefined;
  });
  await assert.rejects(sessions.get("failed"), /open failed/);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(await sessions.get("failed"), undefined);
  assert.deepEqual(opened, [false, false]);

  let finish!: (value: Harness | undefined) => void;
  const modes: boolean[] = [];
  const concurrent = new Sessions(async (_id, _context, create) => {
    modes.push(create);
    if (modes.length === 1)
      return await new Promise<Harness | undefined>((resolve) => {
        finish = resolve;
      });
    return undefined;
  });
  const lookup = concurrent.get("pending");
  const provision = concurrent.get("pending", true);
  await Promise.resolve();
  finish(undefined);
  assert.equal(await lookup, undefined);
  assert.equal(await provision, undefined);
  assert.deepEqual(modes, [false, true]);
});

await test("sessions reject acquisitions after close and aggregate Harness close failures", async () => {
  const closed = new Promise<never>(() => {}) as Harness["closed"];
  const failure = new Error("close failed");
  const harness = {
    closed,
    async close() {
      throw failure;
    },
  } as unknown as Harness;
  const sessions = new Sessions(async () => harness);
  assert.equal(await sessions.get("one"), harness);
  await assert.rejects(sessions.close(Promise.resolve()), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [failure]);
    return true;
  });
  await assert.rejects(sessions.get("two"), (error: unknown) => {
    assert.ok(error instanceof Problem);
    assert.equal(error.status, 503);
    return true;
  });
});

await test("sessions wait for drained requests before closing owners", async () => {
  let closeOwner!: () => void;
  const harness = {
    closed: new Promise<void>(() => {}),
    async close() {
      closeOwner();
    },
  } as unknown as Harness;
  const sessions = new Sessions(async () => harness);
  await sessions.get("one");
  let drain!: () => void;
  const drained = new Promise<void>((resolve) => {
    drain = resolve;
  });
  let done = false;
  const closing = sessions.close(drained).then(() => {
    done = true;
  });
  await Promise.resolve();
  assert.equal(done, false);
  closeOwner = () => {};
  drain();
  await closing;
  assert.equal(done, true);
  await assert.rejects(sessions.get("one"), Problem);
});
