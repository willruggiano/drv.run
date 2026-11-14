import assert from "node:assert/strict";
import { test } from "node:test";
import type { Harness } from "@earendil-works/pi-durable";
import { Sessions } from "../src/sessions.ts";
import { openHarness } from "./fixtures.ts";

void test("provisioning waits for a non-creating miss and then shares one acquisition", async (t) => {
  const { harness } = await openHarness(t);
  const reading = Promise.withResolvers<void>();
  const read = Promise.withResolvers<Harness | undefined>();
  const creating = Promise.withResolvers<void>();
  const create = Promise.withResolvers<Harness>();
  const calls: boolean[] = [];
  const sessions = new Sessions(async (id, context, provision) => {
    assert.equal(id, "test");
    assert.equal(context.abortSignal, undefined);
    calls.push(provision);
    if (provision) {
      creating.resolve();
      return create.promise;
    }
    reading.resolve();
    return read.promise;
  });
  t.after(async () => {
    read.resolve(undefined);
    create.resolve(harness);
    await sessions.close(Promise.resolve());
  });
  const absent = sessions.get("test");
  await reading.promise;
  const first = sessions.get("test", true);
  const second = sessions.get("test", true);
  read.resolve(undefined);
  await creating.promise;
  const lookup = sessions.get("test");
  create.resolve(harness);
  assert.equal(await absent, undefined);
  assert.equal(await first, harness);
  assert.equal(await second, harness);
  assert.equal(await lookup, harness);
  assert.deepEqual(calls, [false, true]);
});

void test("a refused provision is shared but not retried automatically or cached", async () => {
  const release = Promise.withResolvers<Harness | undefined>();
  let calls = 0;
  const sessions = new Sessions(async (_id, _context, create) => {
    assert.equal(create, true);
    calls++;
    return release.promise;
  });
  const first = sessions.get("test", true);
  const second = sessions.get("test", true);
  release.resolve(undefined);
  assert.equal(await first, undefined);
  assert.equal(await second, undefined);
  assert.equal(calls, 1);
  assert.equal(await sessions.get("test", true), undefined);
  assert.equal(calls, 2);
  await sessions.close(Promise.resolve());
});

void test("shutdown prevents provisioning after a pending non-creating lookup misses", async () => {
  const release = Promise.withResolvers<Harness | undefined>();
  const entered = Promise.withResolvers<void>();
  const calls: boolean[] = [];
  const sessions = new Sessions(async (_id, _context, create) => {
    calls.push(create);
    entered.resolve();
    return release.promise;
  });
  const read = sessions.get("test");
  await entered.promise;
  const create = sessions.get("test", true);
  const rejected = Promise.all(
    [read, create].map((request) => assert.rejects(request, { status: 503 })),
  );
  const closing = sessions.close(rejected.then(() => {}));
  release.resolve(undefined);
  await rejected;
  await closing;
  assert.deepEqual(calls, [false]);
});
