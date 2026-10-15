import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, mkdir, chmod, rm } from "node:fs/promises";
import { createServer, createConnection, type Socket } from "node:net";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import dbus from "dbus-next";
import { object, observation, type Notification } from "./activity.ts";
import {
  incarnation,
  counter,
  envelope,
  frames,
  sendFrame,
  type Envelope,
  type NotificationEvent,
} from "./notification-wire.ts";

export type GuestPolicy = { queue: number; active: number; defaultTimeoutMs: number };
export class NotificationOutbox {
  private readonly db: DatabaseSync;
  readonly vm: string;
  readonly server = randomUUID();
  readonly policy: GuestPolicy;
  constructor(path: string, vm: string, policy: GuestPolicy) {
    this.vm = incarnation(vm);
    assert(Number.isInteger(policy.active) && policy.active >= 1 && policy.active <= 256);
    assert(
      Number.isInteger(policy.queue) &&
        policy.queue >= policy.active * 2 + 4 &&
        policy.queue <= 100000,
    );
    assert(
      Number.isInteger(policy.defaultTimeoutMs) &&
        policy.defaultTimeoutMs >= 0 &&
        policy.defaultTimeoutMs <= 0x7fffffff,
    );
    this.policy = policy;
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), vm TEXT NOT NULL, server TEXT NOT NULL, sequence INTEGER NOT NULL, next_id INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS active (id INTEGER PRIMARY KEY, value TEXT NOT NULL, deadline INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS queue (operation INTEGER PRIMARY KEY AUTOINCREMENT, server TEXT NOT NULL, sequence INTEGER NOT NULL, event TEXT NOT NULL);
    `);
    this.transaction(() => {
      const previous = this.db.prepare("SELECT * FROM meta").get();
      const lost = previous && previous.vm !== vm && this.pendingCount() > 0;
      if (previous?.vm === vm) {
        for (const item of this.active()) this.closeNotification(item.id, 4);
        if (previous.sequence !== 0) this.append({ type: "retire" });
      } else this.db.exec("DELETE FROM queue; DELETE FROM active;");
      this.db.prepare("INSERT OR REPLACE INTO meta VALUES(1,?,?,0,1)").run(vm, this.server);
      if (lost) this.append({ type: "gap" });
    });
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private append(event: NotificationEvent): void {
    const meta = this.db
      .prepare("UPDATE meta SET sequence=sequence+1 RETURNING server,sequence")
      .get();
    assert(meta && typeof meta.server === "string" && typeof meta.sequence === "number");
    this.db
      .prepare("INSERT INTO queue(server,sequence,event) VALUES(?,?,?)")
      .run(meta.server, meta.sequence, JSON.stringify(event));
  }
  pendingCount(): number {
    const n = this.db.prepare("SELECT count(*) AS n FROM queue").get()?.n;
    assert(typeof n === "number");
    return n;
  }
  active(): Notification[] {
    return this.db
      .prepare("SELECT value FROM active ORDER BY id")
      .all()
      .map((row) => {
        assert(typeof row.value === "string");
        const event = observation({
          type: "notify",
          notification: JSON.parse(row.value) as unknown,
        });
        assert(event.type === "notify");
        return event.notification;
      });
  }
  notify(input: Omit<Notification, "id" | "expiresAt">, replaces = 0, now = Date.now()): number {
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT id FROM active WHERE id=?").get(replaces);
      const active = this.active().length;
      // Reserve enough space for every close and the server's retirement.
      if (
        (!existing && active >= this.policy.active) ||
        this.pendingCount() + active + 3 >= this.policy.queue
      )
        throw new dbus.DBusError(
          "org.freedesktop.DBus.Error.LimitsExceeded",
          "Notification queue is full.",
        );
      const next = existing ? replaces : this.db.prepare("SELECT next_id FROM meta").get()?.next_id;
      assert(typeof next === "number");
      if (next > 0xffffffff)
        throw new dbus.DBusError(
          "org.freedesktop.DBus.Error.LimitsExceeded",
          "Notification IDs exhausted.",
        );
      const timeout = input.expires === -1 ? this.policy.defaultTimeoutMs : input.expires;
      const event = observation({
        type: "notify",
        notification: { ...input, id: next, expiresAt: timeout === 0 ? 0 : now + timeout },
      });
      assert(event.type === "notify");
      this.db
        .prepare("INSERT OR REPLACE INTO active VALUES(?,?,?)")
        .run(next, JSON.stringify(event.notification), event.notification.expiresAt ?? 0);
      if (!existing) this.db.exec("UPDATE meta SET next_id=next_id+1");
      this.append(event);
      return next;
    });
  }
  private closeNotification(id: number, reason: 1 | 3 | 4): boolean {
    const result = this.db.prepare("DELETE FROM active WHERE id=?").run(id);
    if (!result.changes) return false;
    this.append({ type: "close", id, reason });
    return true;
  }
  close(id: number): boolean {
    return this.transaction(() => this.closeNotification(id, 3));
  }
  expire(now = Date.now()): number[] {
    return this.transaction(() =>
      this.db
        .prepare("SELECT id FROM active WHERE deadline>0 AND deadline<=?")
        .all(now)
        .map((row) => {
          assert(typeof row.id === "number");
          this.closeNotification(row.id, 1);
          return row.id;
        }),
    );
  }
  first(): Envelope | undefined {
    const row = this.db.prepare("SELECT * FROM queue ORDER BY operation LIMIT 1").get();
    if (!row) return;
    assert(typeof row.event === "string");
    return envelope(
      {
        v: 1,
        vm: this.vm,
        server: row.server,
        operation: row.operation,
        sequence: row.sequence,
        event: JSON.parse(row.event) as unknown,
      },
      this.vm,
    );
  }
  acknowledge(operation: number): void {
    this.db.prepare("DELETE FROM queue WHERE operation=?").run(counter(operation));
  }
  dispose(): void {
    this.db.close();
  }
}

const busName = "org.freedesktop.Notifications";
export const notificationPath = "/org/freedesktop/Notifications";
/** https://specifications.freedesktop.org/notification-spec/latest/protocol.html */
class NotificationInterface extends dbus.interface.Interface {
  readonly outbox: NotificationOutbox;
  constructor(outbox: NotificationOutbox) {
    super(busName);
    this.outbox = outbox;
  }
  GetCapabilities(): string[] {
    return ["body"];
  }
  GetServerInformation(): string[] {
    return ["drv.run", "drv.run", "1", "1.2"];
  }
  Notify(
    app: string,
    replaces: number,
    _icon: string,
    summary: string,
    body: string,
    _actions: string[],
    hints: Record<string, dbus.Variant<unknown>>,
    expires: number,
  ): number {
    const hint = hints.urgency;
    const urgency = hint instanceof dbus.Variant && hint.signature === "y" ? hint.value : 1;
    try {
      const event = observation({
        type: "notify",
        notification: { id: 1, app, summary, body, urgency, expires },
      });
      assert(event.type === "notify");
      return this.outbox.notify(event.notification, replaces);
    } catch (error) {
      if (error instanceof TypeError)
        throw new dbus.DBusError("org.freedesktop.DBus.Error.InvalidArgs", error.message);
      throw error;
    }
  }
  CloseNotification(id: number): void {
    if (!this.outbox.close(id))
      throw new dbus.DBusError("org.freedesktop.DBus.Error.InvalidArgs", "");
    this.NotificationClosed(id, 3);
  }
  NotificationClosed(id: number, reason: number): number[] {
    return [id, reason];
  }
}
NotificationInterface.configureMembers({
  methods: {
    GetCapabilities: { outSignature: "as" },
    GetServerInformation: { outSignature: "ssss" },
    Notify: { inSignature: "susssasa{sv}i", outSignature: "u" },
    CloseNotification: { inSignature: "u" },
  },
  signals: { NotificationClosed: { signature: "uu" } },
});

export async function serveNotifications(options: {
  database: string;
  socket: string;
  vm: string;
  policy: GuestPolicy;
  busAddress?: string;
  onError: (error: unknown) => void;
  onTransportError?: (error: unknown) => void;
}): Promise<{ outbox: NotificationOutbox; close: () => Promise<void> }> {
  const bus = dbus.sessionBus({ busAddress: options.busAddress, authMethods: ["EXTERNAL"] });
  bus.on("error", options.onError);
  let outbox: NotificationOutbox;
  try {
    await mkdir(dirname(options.database), { recursive: true, mode: 0o700 });
    if (
      (await bus.requestName(busName, dbus.NameFlag.DO_NOT_QUEUE)) !==
      dbus.RequestNameReply.PRIMARY_OWNER
    )
      throw new Error("Another notification server owns the bus name.");
    outbox = new NotificationOutbox(options.database, options.vm, options.policy);
  } catch (error) {
    bus.disconnect();
    throw error;
  }
  const iface = new NotificationInterface(outbox);
  bus.export(notificationPath, iface);
  const clients = new Set<Socket>();
  const tasks = new Set<Promise<void>>();
  const server = createServer((socket) => {
    // One collector; a reconnect displaces the old stream, never the producer.
    for (const previous of clients) previous.destroy();
    clients.add(socket);
    // No ACK reader runs while the queue is idle; still handle transport resets.
    socket.on("error", () => socket.destroy());
    const abort = new AbortController();
    socket.on("close", () => {
      abort.abort();
      clients.delete(socket);
    });
    socket.on("timeout", () => socket.destroy());
    const task = (async () => {
      const replies = frames(socket);
      await sendFrame(socket, { v: 1, vm: outbox.vm, type: "hello" });
      while (!socket.destroyed) {
        const event = outbox.first();
        if (!event) {
          await delay(250, undefined, { signal: abort.signal });
          continue;
        }
        socket.setTimeout(120000);
        await sendFrame(socket, event);
        const reply = await replies.next();
        socket.setTimeout(0);
        if (reply.done) return;
        const ack = object(reply.value);
        if (ack.v !== 1 || ack.operation !== event.operation || Object.keys(ack).length !== 2)
          throw new Error("Invalid notification acknowledgement.");
        outbox.acknowledge(event.operation);
      }
      // A broken relay must not terminate the D-Bus producer or discard its queue.
    })()
      .catch((error: unknown) => {
        if (!abort.signal.aborted) options.onTransportError?.(error);
      })
      .finally(() => {
        socket.destroy();
        tasks.delete(task);
      });
    tasks.add(task);
  });
  const timer = setInterval(() => {
    try {
      for (const id of outbox.expire()) iface.NotificationClosed(id, 1);
    } catch (error) {
      options.onError(error);
    }
  }, 100);
  try {
    await mkdir(dirname(options.socket), { recursive: true, mode: 0o700 });
    await rm(options.socket, { force: true });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.socket, resolve);
    });
    await chmod(options.socket, 0o600);
  } catch (error) {
    clearInterval(timer);
    bus.disconnect();
    outbox.dispose();
    throw error;
  }
  return {
    outbox,
    close: async () => {
      clearInterval(timer);
      bus.unexport(notificationPath, iface);
      for (const socket of clients) socket.destroy();
      await Promise.all(tasks);
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      outbox.dispose();
      await rm(options.socket, { force: true });
      bus.disconnect();
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  if (process.argv[2] === "stream") {
    assert.equal(process.argv.length, 4);
    const socket = createConnection(process.argv[3]);
    try {
      await Promise.all([pipeline(process.stdin, socket), pipeline(socket, process.stdout)]);
    } finally {
      socket.destroy();
    }
  } else {
    assert.equal(process.argv.length, 3);
    const data = object(JSON.parse(await readFile(process.argv[2], "utf8")) as unknown);
    assert(
      typeof data.database === "string" &&
        typeof data.socket === "string" &&
        typeof data.incarnationFile === "string",
    );
    const policy = object(data.policy);
    assert(
      typeof policy.queue === "number" &&
        typeof policy.active === "number" &&
        typeof policy.defaultTimeoutMs === "number",
    );
    const service = await serveNotifications({
      database: data.database,
      socket: data.socket,
      vm: (await readFile(data.incarnationFile, "utf8")).trim(),
      policy: {
        queue: policy.queue,
        active: policy.active,
        defaultTimeoutMs: policy.defaultTimeoutMs,
      },
      onError: (error) => {
        console.error(error);
        process.exitCode = 1;
        process.kill(process.pid, "SIGTERM");
      },
    });
    const stopped = new Promise<void>((resolve) => {
      process.once("SIGTERM", resolve);
      process.once("SIGINT", resolve);
    });
    try {
      if (process.env.NOTIFY_SOCKET) await promisify(execFile)("systemd-notify", ["--ready"]);
      await stopped;
    } finally {
      await service.close();
    }
  }
}
