import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Activity, activityDefaults, observation, type ActivitySource } from "../activity.ts";

const source: ActivitySource = { instance: "a", incarnation: "boot1", terminal: "terminal1" };
function memory(t: { after: (fn: () => void) => void }): Activity {
  const activity = new Activity(":memory:");
  t.after(() => activity.close());
  return activity;
}
await test("replacement, inheritance, independent child records and subtree clear", (t) => {
  const activity = memory(t);
  activity.accept(source, 1, { type: "status", record: { id: "", state: "working", app: "pi" } });
  activity.accept(source, 2, {
    type: "status",
    record: { id: "build/tests", state: "blocked", kind: "permission", progress: 10 },
  });
  assert.equal(activity.sources()[0].records[1].app, "pi");
  activity.accept(source, 3, { type: "status", record: { id: "build/tests", state: "done" } });
  assert.deepEqual(activity.sources()[0].records[1], {
    id: "build/tests",
    state: "done",
    app: "pi",
  });
  assert.equal(activity.sources()[0].records[0].state, "working");
  activity.accept(source, 4, { type: "clear", id: "build" });
  assert.deepEqual(
    activity.sources()[0].records.map((r) => r.id),
    [""],
  );
  activity.accept(source, 5, { type: "clear", id: "" });
  assert.deepEqual(activity.sources()[0].records, []);
  assert.equal(activity.history().length, 2);
});
await test("exit/prompt remove transient records but preserve results; reading is not clear", (t) => {
  const activity = memory(t);
  for (const [i, state] of ["idle", "working", "blocked", "done", "error"].entries())
    activity.accept(source, i + 1, { type: "status", record: { id: state, state } });
  activity.accept(source, 6, { type: "boundary" });
  assert.deepEqual(
    activity.sources()[0].records.map((r) => r.state),
    ["done", "error"],
  );
  activity.read(activity.history()[0].id);
  assert.equal(activity.history()[0].read, true);
  assert.equal(activity.sources()[0].records.length, 2);
});
await test("progress and replay do not alert; a later run can finish again", (t) => {
  const activity = memory(t);
  activity.accept(source, 1, { type: "status", record: { id: "", state: "blocked", progress: 1 } });
  activity.accept(source, 2, { type: "status", record: { id: "", state: "blocked", progress: 2 } });
  assert.equal(activity.history().length, 1);
  assert.equal(
    activity.accept(source, 2, { type: "status", record: { id: "", state: "error" } }),
    false,
  );
  activity.accept(source, 3, { type: "status", record: { id: "", state: "working" } });
  assert.equal(activity.takePending(), undefined);
  activity.accept(source, 4, { type: "status", record: { id: "", state: "done" } });
  activity.accept(source, 5, { type: "status", record: { id: "", state: "working" } });
  activity.accept(source, 6, { type: "status", record: { id: "", state: "done" } });
  assert.equal(activity.history().length, 3);
  assert.equal(activity.history().filter((item) => item.delivery === "pending").length, 1);
});
await test("snapshot repairs state without alerting; gaps and outages remain visible", (t) => {
  const activity = memory(t);
  activity.accept(source, 5, { type: "snapshot", records: [{ id: "", state: "blocked" }] });
  assert.equal(activity.sources()[0].gap, true);
  assert.equal(activity.history().length, 0);
  activity.unavailable(source);
  assert.equal(activity.sources()[0].available, false);
  assert.equal(activity.sources()[0].records[0].state, "blocked");
  activity.accept(source, 6, { type: "retire" });
  assert.equal(
    activity.accept(source, 7, { type: "status", record: { id: "", state: "done" } }),
    false,
  );
  activity.accept({ ...source, incarnation: "boot2" }, 1, {
    type: "status",
    record: { id: "", state: "idle" },
  });
  assert.equal(activity.sources().length, 2);
  assert.equal(activity.sources()[0].retired, true);
});
await test("notification replacement and closure retain lifecycle; delivery is not closure", (t) => {
  const activity = memory(t);
  const notification = {
    id: 1,
    app: "notify-send",
    summary: "hello",
    body: "",
    urgency: 1,
    expires: 0,
  };
  activity.accept(source, 1, { type: "notify", notification });
  activity.accept(source, 2, {
    type: "notify",
    notification: { ...notification, summary: "updated" },
  });
  const id = activity.takePending();
  assert(id);
  activity.delivered(id, "failed");
  assert.equal(activity.history()[0].event.type, "notify");
  activity.accept(source, 3, { type: "close", id: 1, reason: 3 });
  assert.equal(activity.history().length, 3);
  assert.deepEqual(activity.history()[0].event, { type: "close", id: 1, reason: 3 });
  assert.equal(activity.takePending(), undefined);
});
await test("malformed reports do not mutate state or advance sequence", (t) => {
  const activity = memory(t);
  activity.accept(source, 1, { type: "status", record: { id: "", state: "working" } });
  for (const record of [
    { id: "bad//id", state: "clear" },
    { id: "", state: "unknown" },
    { id: "", state: "done", msg: "bad\x1btext" },
    { id: "", state: "done", title: "x".repeat(193) },
  ])
    assert.throws(() => activity.accept(source, 2, { type: "status", record }));
  assert.equal(activity.sources()[0].sequence, 1);
  assert.equal(activity.sources()[0].records[0].state, "working");
  assert.throws(() =>
    observation({
      type: "snapshot",
      records: [
        { id: "", state: "done" },
        { id: "", state: "error" },
      ],
    }),
  );
});
await test("least recently updated record is evicted and quotas are bounded", (t) => {
  const activity = new Activity(":memory:", {
    ...activityDefaults,
    records: 64,
    sources: 1,
    history: 3,
  });
  t.after(() => activity.close());
  for (let i = 1; i <= 65; i++)
    activity.accept(source, i, { type: "status", record: { id: `r${i}`, state: "done" } });
  const records = activity.sources()[0].records;
  assert.equal(records.length, 64);
  assert.equal(
    records.some((r) => r.id === "r1"),
    false,
  );
  assert.equal(activity.history().length, 3);
  assert.throws(() => activity.accept({ ...source, terminal: "other" }, 1, { type: "boundary" }));
  assert.equal(activity.sources().length, 1);
});
await test("accepted history, pending work, replay deduplication and rate limits survive restart", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "drv-activity-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "activity.sqlite");
  let activity = new Activity(path);
  activity.accept(source, 1, { type: "status", record: { id: "", state: "done" } }, 1000);
  const id = activity.takePending(1000);
  assert(id);
  activity.close();
  activity = new Activity(path);
  t.after(() => activity.close());
  assert.equal(activity.sources()[0].available, false);
  assert.equal(activity.history()[0].id, id);
  assert.equal(activity.takePending(1001), undefined);
  assert.equal(activity.takePending(10000), id);
  assert.equal(activity.attempts(id), 2);
  assert.equal(activity.accept(source, 1, { type: "boundary" }), false);
  activity.retireInstance(source.instance);
  assert.equal(activity.takePending(20000), undefined);
});

await test("reconnect preserves pending work when the snapshot agrees with current state", (t) => {
  const activity = memory(t);
  const record = { id: "", state: "blocked", kind: "auth" };
  activity.accept(source, 1, { type: "status", record });
  const id = activity.history()[0].id;
  activity.unavailable(source);
  activity.accept(source, 2, { type: "snapshot", records: [record] });
  assert.equal(activity.history().length, 1);
  assert.equal(activity.takePending(), id);
  activity.accept(source, 3, { type: "snapshot", records: [{ id: "", state: "working" }] });
  assert.equal(activity.history()[0].delivery, "superseded");
});
await test("retention removes expired inbox items and their pending work", (t) => {
  const activity = memory(t);
  activity.accept(source, 1, { type: "status", record: { id: "", state: "done" } }, 1000);
  activity.prune(1000 + 31 * 86_400_000);
  assert.equal(activity.history().length, 0);
  assert.equal(activity.takePending(), undefined);
  assert.equal(activity.sources()[0].records[0].state, "done");
});
await test("push links can select retained activity outside the latest page", (t) => {
  const activity = memory(t);
  for (let i = 1; i <= 4; i++)
    activity.accept(source, i, { type: "status", record: { id: `r${i}`, state: "done" } });
  assert.deepEqual(
    activity.history(2).map((item) => item.id),
    [4, 3],
  );
  assert.deepEqual(
    activity.history(2, 1).map((item) => item.id),
    [1, 4, 3],
  );
  assert.deepEqual(
    activity.history(2, 4).map((item) => item.id),
    [4, 3],
  );
});

await test("expired D-Bus notifications cannot be pushed; retirement clears projections, not history", (t) => {
  const activity = memory(t);
  activity.accept(
    source,
    1,
    {
      type: "notify",
      notification: {
        id: 1,
        app: "fixture",
        summary: "Short lived",
        body: "",
        urgency: 1,
        expires: 10,
        expiresAt: 110,
      },
    },
    100,
  );
  assert.equal(activity.takePending(110), undefined);
  assert.equal(activity.history()[0].delivery, "expired");
  assert.equal(activity.sources()[0].notifications.length, 1);
  activity.retireInstance(source.instance);
  assert.equal(activity.sources()[0].retired, true);
  assert.equal(activity.sources()[0].notifications.length, 0);
  assert.equal(activity.history().length, 1);
  assert.equal(activity.accept(source, 2, { type: "close", id: 1, reason: 3 }), false);
});
