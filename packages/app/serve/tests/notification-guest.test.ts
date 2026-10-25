import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { Duplex } from "node:stream";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import dbus from "dbus-next";
import { Activity } from "../activity.ts";
import {
  NotificationOutbox,
  serveNotifications,
  notificationPath,
  type GuestPolicy,
} from "../notification-guest.ts";
import { NotificationRelay } from "../notification-relay.ts";
import { envelope, frames, sendFrame } from "../notification-wire.ts";

const policy: GuestPolicy = { queue: 132, active: 64, defaultTimeoutMs: 5000 };
const notification = {
  app: "fixture",
  summary: "Complete",
  body: "plain\ntext",
  urgency: 1 as const,
  expires: 0,
};
async function directory(t: TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "notifications-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 250; i++) {
    if (await predicate()) return;
    await delay(20);
  }
  assert.fail("State did not converge.");
}
function drain(outbox: NotificationOutbox) {
  const events = [];
  for (let item = outbox.first(); item; item = outbox.first()) {
    events.push(item);
    outbox.acknowledge(item.operation);
  }
  return events;
}
await test("D-Bus outbox replaces atomically, closes, expires and retains lifecycle history", async (t) => {
  const path = join(await directory(t), "queue.sqlite");
  const outbox = new NotificationOutbox(path, randomUUID(), policy);
  t.after(() => outbox.dispose());
  const id = outbox.notify(notification, 0, 100);
  assert.equal(id, 1);
  assert.equal(outbox.notify({ ...notification, body: "replacement", expires: 10 }, id, 101), id);
  assert.equal(outbox.active().length, 1);
  assert.deepEqual(outbox.expire(110), []);
  assert.deepEqual(outbox.expire(111), [id]);
  assert.equal(outbox.close(id), false);
  const second = outbox.notify(notification, id, 120);
  assert.notEqual(second, id);
  assert.equal(outbox.close(second), true);
  assert.deepEqual(outbox.active(), []);
  const events = drain(outbox);
  assert.deepEqual(
    events.map((item) => item.sequence),
    [1, 2, 3, 4, 5],
  );
  assert.deepEqual(
    events.map((item) => item.event.type),
    ["notify", "notify", "close", "notify", "close"],
  );
  assert.deepEqual(events[2].event, { type: "close", id, reason: 1 });
  assert.deepEqual(events[4].event, { type: "close", id: second, reason: 3 });
});
await test("durable queue survives server restart with distinct IDs; VM restart reports lost unaccepted work", async (t) => {
  const path = join(await directory(t), "queue.sqlite"),
    vm = randomUUID();
  let outbox = new NotificationOutbox(path, vm, policy);
  const firstServer = outbox.server;
  outbox.notify(notification);
  outbox.dispose();
  outbox = new NotificationOutbox(path, vm, policy);
  assert.notEqual(outbox.server, firstServer);
  assert.equal(outbox.notify(notification), 1);
  const replay = drain(outbox);
  assert.deepEqual(
    replay.map((item) => item.event.type),
    ["notify", "close", "retire", "notify"],
  );
  assert.deepEqual(
    replay.slice(0, 3).map((item) => item.server),
    [firstServer, firstServer, firstServer],
  );
  outbox.notify(notification);
  outbox.dispose();
  outbox = new NotificationOutbox(path, randomUUID(), policy);
  t.after(() => outbox.dispose());
  assert.deepEqual(outbox.active(), []);
  assert.deepEqual(outbox.first()?.event, { type: "gap" });
});
await test("full queues reject new requests but reserve closures and retirement", async (t) => {
  const path = join(await directory(t), "queue.sqlite"),
    vm = randomUUID();
  let outbox = new NotificationOutbox(path, vm, policy);
  const id = outbox.notify(notification);
  while (outbox.pendingCount() < policy.queue - 4) outbox.notify(notification, id);
  assert.throws(() => outbox.notify(notification, id), dbus.DBusError);
  assert.equal(outbox.close(id), true);
  outbox.dispose();
  outbox = new NotificationOutbox(path, vm, policy);
  t.after(() => outbox.dispose());
  assert(outbox.pendingCount() <= policy.queue);
  assert.deepEqual(drain(outbox).at(-1)?.event, { type: "retire" });
});

async function fixture(t: TestContext) {
  // Own a session bus: no desktop, network, login session or test-output parsing.
  const dir = await mkdtemp(join(tmpdir(), "notification-bus-"));
  const address = `unix:path=${dir}/bus`;
  // Nix's dbus-daemon expects /etc configuration, absent in a build sandbox.
  // This private bus needs no host configuration or activatable services.
  const config = join(dir, "bus.conf");
  await writeFile(
    config,
    `<busconfig>
    <type>session</type>
    <listen>${address.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</listen>
    <auth>EXTERNAL</auth>
    <policy context="default">
      <allow user="*"/>
      <allow own="*"/>
      <allow send_destination="*"/>
      <allow receive_sender="*"/>
    </policy>
  </busconfig>`,
  );
  const daemon = spawn("dbus-daemon", [`--config-file=${config}`, "--nofork"], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  const closed = new Promise<void>((resolve) => daemon.once("close", () => resolve()));
  const errors: unknown[] = [];
  daemon.on("error", (error) => errors.push(error));
  const vm = randomUUID();
  let service: Awaited<ReturnType<typeof serveNotifications>> | undefined;
  let bus: dbus.MessageBus | undefined;
  let relay: NotificationRelay | undefined;
  let activity: Activity | undefined;
  t.after(async () => {
    await relay?.close();
    activity?.close();
    bus?.disconnect();
    await service?.close();
    daemon.kill();
    await closed;
    await rm(dir, { recursive: true, force: true });
  });
  await until(async () => {
    if (errors.length) throw errors[0];
    assert.equal(daemon.exitCode, null, "D-Bus fixture exited before readiness.");
    assert.equal(daemon.signalCode, null, "D-Bus fixture was killed before readiness.");
    try {
      return (await stat(join(dir, "bus"))).isSocket();
    } catch {
      return false;
    }
  });
  service = await serveNotifications({
    database: join(dir, "queue.sqlite"),
    socket: join(dir, "events.sock"),
    vm,
    policy,
    busAddress: address,
    onError: (error) => errors.push(error),
  });
  bus = dbus.sessionBus({ busAddress: address, authMethods: ["EXTERNAL"] });
  bus.on("error", (error: unknown) => errors.push(error));
  const call = async (member: string, signature = "", body: unknown[] = []) => {
    const reply = await bus!.call(
      new dbus.Message({
        destination: "org.freedesktop.Notifications",
        path: notificationPath,
        interface: "org.freedesktop.Notifications",
        member,
        signature,
        body,
      }),
    );
    assert(reply);
    return reply.body as unknown[];
  };
  const instance = join(dir, "drv.run.fixture");
  await mkdir(instance);
  await writeFile(join(instance, "notification-incarnation"), `${vm}\n`, { mode: 0o600 });
  activity = new Activity(join(dir, "activity.sqlite"));
  const makeRelay = () =>
    new NotificationRelay(
      activity!,
      {
        runtimeDirectory: dir,
        sshConfigFile: "/unused-in-test",
        scanIntervalMs: 100,
        maxInstances: 2,
        eventsPerSecond: 1000,
      },
      (error) => errors.push(error),
      () => createConnection(join(dir, "events.sock")),
    );
  relay = makeRelay();
  return {
    dir,
    address,
    vm,
    service,
    call,
    errors,
    bus,
    get host() {
      return activity!;
    },
    get relay() {
      return relay!;
    },
    async restartHost() {
      await relay!.close();
      activity!.close();
      activity = new Activity(join(dir, "activity.sqlite"));
      relay = makeRelay();
      await relay.scan();
    },
  };
}
await test("notify-send works without a PTY; host binds identity, commits before ACK, retains inbox after closure", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.call("GetCapabilities"), [["body"]]);
  assert.deepEqual((await f.call("GetServerInformation")).slice(0, 2), ["drv.run", "drv.run"]);
  await promisify(execFile)(
    "notify-send",
    ["--app-name=fixture", "--expire-time=0", "Detached", "Plain <b>text</b>"],
    { env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: f.address } },
  );
  assert.equal(f.service.outbox.active().length, 1);
  assert.equal(f.service.outbox.pendingCount(), 1);
  await f.relay.scan();
  await until(() => f.host.history().length === 1 && f.service.outbox.pendingCount() === 0);
  const first = f.host.history()[0];
  assert.equal(first.source.instance, "drv.run.fixture");
  assert.equal(first.source.incarnation, f.vm);
  assert.equal(first.source.terminal, `dbus-root/${f.service.outbox.server}`);
  assert.equal(first.event.type, "notify");
  assert.equal(f.host.sources()[0].notifications.length, 1);
  await f.call("CloseNotification", "u", [1]);
  await until(() => f.host.history().length === 2);
  assert.deepEqual(f.host.history()[0].event, { type: "close", id: 1, reason: 3 });
  assert.equal(f.host.sources()[0].notifications.length, 0);
  await assert.rejects(f.call("CloseNotification", "u", [1]), dbus.DBusError);
  assert.deepEqual(f.errors, []);
});
await test("lost ACK replays once; retired VM incarnation cannot reattach", async (t) => {
  const f = await fixture(t);
  f.service.outbox.notify(notification);
  const socket = createConnection(join(f.dir, "events.sock"));
  const incoming = frames(socket);
  await incoming.next(); // hello
  const next = await incoming.next();
  assert(!next.done);
  const event = envelope(next.value, f.vm);
  const source = {
    instance: "drv.run.fixture",
    incarnation: f.vm,
    terminal: `dbus-root/${event.server}`,
  };
  f.host.accept(source, event.sequence, event.event);
  socket.destroy(); // Host committed, but guest did not receive an ACK.
  await f.relay.scan();
  await until(() => f.service.outbox.pendingCount() === 0);
  assert.equal(f.host.history().length, 1);
  await writeFile(join(f.dir, "drv.run.fixture/notification-incarnation"), `${randomUUID()}\n`);
  await f.relay.scan();
  assert.equal(f.host.sources()[0].retired, true);
  assert.equal(f.host.takePending(), undefined);
});
await test("wire rejects attribution fields, unsupported observations, stale incarnations and invalid ACKs", async (t) => {
  const f = await fixture(t);
  f.service.outbox.notify(notification);
  const event = f.service.outbox.first();
  assert(event);
  assert.throws(() => envelope({ ...event, owner: "another-user" }, f.vm), TypeError);
  assert.throws(() => envelope({ ...event, vm: randomUUID() }, f.vm), TypeError);
  assert.throws(
    () => envelope({ ...event, event: { type: "snapshot", records: [] } }, f.vm),
    TypeError,
  );
  const socket = createConnection(join(f.dir, "events.sock"));
  const incoming = frames(socket);
  await incoming.next();
  await incoming.next();
  await sendFrame(socket, { v: 1, operation: event.operation + 1 });
  assert.equal((await incoming.next()).done, true);
  assert.equal(f.service.outbox.pendingCount(), 1);
  assert.equal(f.service.outbox.active().length, 1);
});

await test("host restart restores active projections and reads, and accepts buffered notifications", async (t) => {
  const f = await fixture(t);
  f.service.outbox.notify(notification);
  await f.relay.scan();
  await until(() => f.service.outbox.pendingCount() === 0);
  const id = f.host.history()[0].id;
  f.host.read(id);
  await f.relay.close();
  assert.equal(f.host.sources()[0].available, false);
  f.service.outbox.notify({ ...notification, summary: "While offline" });
  assert.equal(f.service.outbox.pendingCount(), 1);
  await f.restartHost();
  await until(() => f.service.outbox.pendingCount() === 0);
  assert.equal(f.host.history().length, 2);
  assert.equal(f.host.history().find((item) => item.id === id)?.read, true);
  assert.equal(f.host.sources()[0].available, true);
  assert.equal(f.host.sources()[0].gap, false);
  assert.equal(f.host.sources()[0].notifications.length, 2);
  assert.deepEqual(f.errors, []);
});

await test("D-Bus methods replace IDs, reject controls, ignore unsupported hints, and emit closure reasons", async (t) => {
  const f = await fixture(t);
  await f.bus.call(
    new dbus.Message({
      destination: "org.freedesktop.DBus",
      path: "/org/freedesktop/DBus",
      interface: "org.freedesktop.DBus",
      member: "AddMatch",
      signature: "s",
      body: ["type='signal',interface='org.freedesktop.Notifications',member='NotificationClosed'"],
    }),
  );
  const closed: unknown[][] = [];
  f.bus.on("message", (message) => {
    if (
      message.interface === "org.freedesktop.Notifications" &&
      message.member === "NotificationClosed"
    )
      closed.push(message.body as unknown[]);
  });
  const notify = (id: number, body: string, timeout: number) =>
    f.call("Notify", "susssasa{sv}i", [
      "fixture",
      id,
      "file:///must-not-be-read",
      "Title",
      body,
      ["default", "Do not expose this action"],
      {
        urgency: new dbus.Variant("y", 2),
        "image-path": new dbus.Variant("s", "https://must-not-be-fetched.invalid/image"),
      },
      timeout,
    ]);
  const [id] = await notify(0, "Original", 0);
  assert.equal(typeof id, "number");
  assert.deepEqual(await notify(Number(id), "<b>Plain</b>", 0), [id]);
  assert.equal(f.service.outbox.active().length, 1);
  assert.deepEqual(f.service.outbox.active()[0], {
    id,
    app: "fixture",
    summary: "Title",
    body: "<b>Plain</b>",
    urgency: 2,
    expires: 0,
    expiresAt: 0,
  });
  await assert.rejects(notify(Number(id), "\x1b]bad", 0), dbus.DBusError);
  await f.call("CloseNotification", "u", [id]);
  await until(() => closed.length === 1);
  assert.deepEqual(closed[0], [id, 3]);
  const [expiring] = await notify(0, "Expires", 1);
  await until(() => closed.length === 2);
  assert.deepEqual(closed[1], [expiring, 1]);
  assert.equal(f.service.outbox.active().length, 0);
});

await test("wire handles split frames and rejects oversize, truncated and invalid UTF-8 input", async () => {
  const read = async (chunks: Buffer[]) => {
    const result: unknown[] = [];
    for await (const value of frames(Duplex.from(chunks))) result.push(value);
    return result;
  };
  assert.deepEqual(await read([Buffer.from('{"v":'), Buffer.from("1}\n{}\n")]), [{ v: 1 }, {}]);
  await assert.rejects(read([Buffer.alloc(16385, 65)]), Error);
  await assert.rejects(read([Buffer.from('{"v":1}')]), Error);
  await assert.rejects(read([Buffer.from([0xff, 10])]), TypeError);
});

await test("closing a backpressured transport cancels the pending frame", async () => {
  const stream = new Duplex({
    writableHighWaterMark: 1,
    read() {},
    write() {
      // Keep the write pending until the peer closes.
    },
  });
  const pending = sendFrame(stream, { v: 1, operation: 1 });
  assert.equal(stream.writableNeedDrain, true);
  stream.destroy();
  await assert.rejects(pending, Error);
  assert.equal(stream.listenerCount("drain"), 0);
});

await test("a second D-Bus server cannot rotate the active producer's outbox", async (t) => {
  const f = await fixture(t);
  f.service.outbox.notify(notification);
  const pending = f.service.outbox.first();
  await assert.rejects(
    serveNotifications({
      database: join(f.dir, "queue.sqlite"),
      socket: join(f.dir, "events.sock"),
      vm: f.vm,
      policy,
      busAddress: f.address,
      onError: (error) => f.errors.push(error),
    }),
    Error,
  );
  assert.deepEqual(f.service.outbox.first(), pending);
  assert.equal(f.service.outbox.pendingCount(), 1);
  assert.equal(f.service.outbox.active().length, 1);
  assert.deepEqual(await f.call("GetCapabilities"), [["body"]]);
  assert.deepEqual(f.errors, []);
});
