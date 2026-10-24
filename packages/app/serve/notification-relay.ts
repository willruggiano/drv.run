import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { readdir, lstat, readFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { Duplex } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { Activity, object, type ActivitySource } from "./activity.ts";
import { incarnation, envelope, frames, sendFrame } from "./notification-wire.ts";

export type RelayPolicy = {
  runtimeDirectory: string;
  sshConfigFile: string;
  scanIntervalMs: number;
  maxInstances: number;
  eventsPerSecond: number;
};
export function relayPolicy(value: unknown): RelayPolicy {
  const p = object(value);
  assert(typeof p.runtimeDirectory === "string" && isAbsolute(p.runtimeDirectory));
  assert(typeof p.sshConfigFile === "string" && isAbsolute(p.sshConfigFile));
  assert(
    typeof p.scanIntervalMs === "number" &&
      Number.isInteger(p.scanIntervalMs) &&
      p.scanIntervalMs >= 100 &&
      p.scanIntervalMs <= 60000,
  );
  assert(
    typeof p.maxInstances === "number" &&
      Number.isInteger(p.maxInstances) &&
      p.maxInstances >= 1 &&
      p.maxInstances <= 64,
  );
  assert(
    typeof p.eventsPerSecond === "number" &&
      Number.isInteger(p.eventsPerSecond) &&
      p.eventsPerSecond >= 1 &&
      p.eventsPerSecond <= 1000,
  );
  return {
    runtimeDirectory: p.runtimeDirectory,
    sshConfigFile: p.sshConfigFile,
    scanIntervalMs: p.scanIntervalMs,
    maxInstances: p.maxInstances,
    eventsPerSecond: p.eventsPerSecond,
  };
}
type Instance = { name: string; incarnation: string };
const instanceName = /^drv\.run\.[A-Za-z0-9]+$/;
/** The host selects the SSH destination and identity. Guest envelopes cannot select either. */
export class NotificationRelay {
  private readonly activity: Activity;
  private readonly policy: RelayPolicy;
  private readonly connect: (instance: Instance) => Duplex;
  private readonly report: (error: unknown) => void;
  private readonly abort = new AbortController();
  private readonly connections = new Map<
    string,
    { instance: Instance; stream: Duplex; task: Promise<void> }
  >();
  private loop?: Promise<void>;
  private nextEventAt = 0;
  constructor(
    activity: Activity,
    policy: RelayPolicy,
    report: (error: unknown) => void,
    connect?: (instance: Instance) => Duplex,
  ) {
    this.activity = activity;
    this.policy = relayPolicy(policy);
    this.report = report;
    this.connect =
      connect ??
      ((instance) => {
        const child = spawn(
          "ssh",
          [
            "-F",
            policy.sshConfigFile,
            "-T",
            "-o",
            "ControlPath=none",
            "-o",
            "ServerAliveInterval=15",
            "-o",
            "ServerAliveCountMax=3",
            instance.name,
            "notifications-stream",
          ],
          { stdio: ["pipe", "pipe", "ignore"] },
        );
        const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
        child.on("error", (error) => stream.destroy(error));
        child.on("exit", (code) =>
          stream.destroy(code ? new Error(`Notification SSH exited (${code}).`) : undefined),
        );
        stream.once("close", () => {
          child.kill();
        });
        return stream;
      });
  }
  current(source: Pick<ActivitySource, "instance" | "incarnation">): boolean {
    if (!instanceName.test(source.instance)) return false;
    try {
      return (
        readFileSync(
          join(this.policy.runtimeDirectory, source.instance, "notification-incarnation"),
          "utf8",
        ) === `${source.incarnation}\n`
      );
    } catch {
      return false;
    }
  }
  start(): void {
    assert(!this.loop);
    this.loop = (async () => {
      while (!this.abort.signal.aborted) {
        try {
          await this.scan();
        } catch (error) {
          if (!this.abort.signal.aborted) this.report(error);
        }
        await delay(this.policy.scanIntervalMs, undefined, { signal: this.abort.signal });
      }
    })().catch((error: unknown) => {
      if (!this.abort.signal.aborted) this.report(error);
    });
  }
  async close(): Promise<void> {
    this.abort.abort();
    for (const { stream } of this.connections.values()) stream.destroy();
    await this.loop;
    await Promise.all([...this.connections.values()].map((connection) => connection.task));
  }
  async scan(): Promise<void> {
    const discovered = new Map<string, Instance>();
    for (const entry of await readdir(this.policy.runtimeDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !instanceName.test(entry.name)) continue;
      try {
        const path = join(this.policy.runtimeDirectory, entry.name, "notification-incarnation");
        const stat = await lstat(path);
        if (!stat.isFile() || stat.size !== 37) continue;
        const vm = incarnation((await readFile(path, "utf8")).trim());
        discovered.set(entry.name, { name: entry.name, incarnation: vm });
      } catch (error) {
        if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT")
          this.report(error);
      }
    }
    for (const name of new Set(this.activity.identities().map((source) => source.instance))) {
      if (!instanceName.test(name)) continue;
      this.activity.retireInstance(name, discovered.get(name)?.incarnation);
    }
    for (const [name, connection] of this.connections) {
      if (discovered.get(name)?.incarnation !== connection.instance.incarnation)
        connection.stream.destroy();
    }
    if (this.abort.signal.aborted) return;
    for (const instance of discovered.values()) {
      if (this.connections.has(instance.name)) continue;
      if (this.connections.size >= this.policy.maxInstances) break;
      const stream = this.connect(instance);
      const task = this.consume(instance, stream)
        .catch(() => {
          // Do not put malformed guest frames (or their parser errors) in logs.
          if (!this.abort.signal.aborted)
            this.report(new Error(`Notification relay disconnected: ${instance.name}`));
        })
        .finally(() => {
          stream.destroy();
          this.connections.delete(instance.name);
          for (const source of this.activity.identities())
            if (source.instance === instance.name && source.incarnation === instance.incarnation)
              this.activity.unavailable(source);
        });
      this.connections.set(instance.name, { instance, stream, task });
    }
  }
  private async consume(instance: Instance, stream: Duplex): Promise<void> {
    let greeted = false,
      previousOperation = 0;
    for await (const input of frames(stream)) {
      if (!this.current({ instance: instance.name, incarnation: instance.incarnation }))
        throw new Error("Instance authority expired.");
      if (!greeted) {
        const hello = object(input);
        if (
          hello.v !== 1 ||
          hello.type !== "hello" ||
          hello.vm !== instance.incarnation ||
          Object.keys(hello).length !== 3
        )
          throw new Error("Invalid notification greeting.");
        greeted = true;
        this.activity.availableInstance(instance.name, instance.incarnation);
        continue;
      }
      const event = envelope(input, instance.incarnation);
      if (event.operation <= previousOperation)
        throw new Error("Out-of-order notification operation.");
      previousOperation = event.operation;
      const now = Date.now();
      const wait = Math.max(0, this.nextEventAt - now);
      this.nextEventAt = Math.max(now, this.nextEventAt) + 1000 / this.policy.eventsPerSecond;
      if (wait) await delay(wait, undefined, { signal: this.abort.signal });
      const source: ActivitySource = {
        instance: instance.name,
        incarnation: instance.incarnation,
        terminal: `dbus-root/${event.server}`,
      };
      if (!this.current(source)) throw new Error("Instance authority expired.");
      const accepted = this.activity.accept(source, event.sequence, event.event);
      if (!accepted && this.activity.sequence(source) < event.sequence)
        throw new Error("Retired notification source.");
      // Activity.accept commits both inbox state and pending delivery before ACK.
      await sendFrame(stream, { v: 1, operation: event.operation });
    }
  }
}
