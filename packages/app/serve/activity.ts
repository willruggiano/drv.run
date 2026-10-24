import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

export type ProgramStatus = {
  id: string;
  state: "idle" | "working" | "blocked" | "done" | "error";
  app?: string;
  title?: string;
  msg?: string;
  kind?: "permission" | "question" | "auth";
  progress?: number;
};
export type Notification = {
  id: number;
  app: string;
  summary: string;
  body: string;
  urgency: 0 | 1 | 2;
  expires: number;
  expiresAt?: number;
};
export type Observation =
  | { type: "status"; record: ProgramStatus }
  | { type: "clear"; id: string }
  | { type: "boundary" }
  | { type: "snapshot"; records: ProgramStatus[] }
  | { type: "retire" }
  | { type: "gap" }
  | { type: "notify"; notification: Notification }
  | { type: "close"; id: number; reason: 1 | 2 | 3 | 4 };
/** The host binds instance/incarnation. `terminal` namespaces a producer within
 * that binding (API session or guest root bus/server), never an owner or recipient.
 */
export type ActivitySource = { instance: string; incarnation: string; terminal: string };
export type ActivityOptions = {
  records: number;
  sources: number;
  history: number;
  retentionDays: number;
  burst: number;
  intervalMs: number;
};
export const activityDefaults: ActivityOptions = {
  records: 256,
  sources: 1024,
  history: 10_000,
  retentionDays: 30,
  burst: 10,
  intervalMs: 60_000,
};
export type ActivityItem = {
  id: number;
  source: ActivitySource;
  record: string;
  event: Observation;
  received: number;
  read: boolean;
  delivery: string;
};
export type SourceView = {
  source: ActivitySource;
  available: boolean;
  retired: boolean;
  gap: boolean;
  sequence: number;
  records: ProgramStatus[];
  notifications: Notification[];
};

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Expected an object.");
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, multiline = false): string {
  if (
    typeof value !== "string" ||
    !value.isWellFormed() ||
    Buffer.byteLength(value) > max ||
    /[\p{Cc}\p{Cf}]/u.test(multiline ? value.replace(/[\n\t]/g, "") : value)
  )
    throw new TypeError("Invalid plain text.");
  return value;
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    throw new TypeError("Invalid integer.");
  return value;
}
export function recordId(value: unknown): string {
  const id = text(value, 128);
  if (
    id &&
    (id.split("/").length > 8 ||
      !id.split("/").every((part) => /^[A-Za-z0-9_.+-]{1,32}$/.test(part)))
  )
    throw new TypeError("Invalid record ID.");
  return id;
}
export function programStatus(value: unknown): ProgramStatus {
  const data = object(value);
  const state = data.state;
  if (
    state !== "idle" &&
    state !== "working" &&
    state !== "blocked" &&
    state !== "done" &&
    state !== "error"
  )
    throw new TypeError("Invalid program state.");
  const result: ProgramStatus = { id: recordId(data.id), state };
  if (data.app !== undefined) {
    const app = text(data.app, 32);
    if (!/^[A-Za-z0-9_.+-]{1,32}$/.test(app)) throw new TypeError("Invalid app.");
    result.app = app;
  }
  if (data.title !== undefined) result.title = text(data.title, 192);
  if (data.msg !== undefined) result.msg = text(data.msg, 2048);
  if (state === "blocked" && data.kind !== undefined) {
    if (data.kind !== "permission" && data.kind !== "question" && data.kind !== "auth")
      throw new TypeError("Invalid blocked kind.");
    result.kind = data.kind;
  }
  if ((state === "working" || state === "blocked") && data.progress !== undefined)
    result.progress = integer(data.progress, 0, 100);
  return result;
}
export function observation(value: unknown): Observation {
  const data = object(value);
  switch (data.type) {
    case "status":
      return { type: "status", record: programStatus(data.record) };
    case "clear":
      return { type: "clear", id: recordId(data.id) };
    case "boundary":
      return { type: "boundary" };
    case "retire":
      return { type: "retire" };
    case "gap":
      return { type: "gap" };
    case "snapshot": {
      if (!Array.isArray(data.records) || data.records.length > 256)
        throw new TypeError("Invalid snapshot.");
      const records = data.records.map(programStatus);
      if (new Set(records.map((r) => r.id)).size !== records.length)
        throw new TypeError("Duplicate record.");
      return { type: "snapshot", records };
    }
    case "notify": {
      const n = object(data.notification);
      const urgency = integer(n.urgency, 0, 2);
      assert(urgency === 0 || urgency === 1 || urgency === 2);
      return {
        type: "notify",
        notification: {
          id: integer(n.id, 1, 0xffffffff),
          app: text(n.app, 128),
          summary: text(n.summary, 1024),
          body: text(n.body, 4096, true),
          urgency,
          expires: integer(n.expires, -1, 0x7fffffff),
          ...(n.expiresAt === undefined
            ? {}
            : { expiresAt: integer(n.expiresAt, 0, Number.MAX_SAFE_INTEGER) }),
        },
      };
    }
    case "close": {
      const reason = integer(data.reason, 1, 4);
      assert(reason === 1 || reason === 2 || reason === 3 || reason === 4);
      return { type: "close", id: integer(data.id, 1, 0xffffffff), reason };
    }
    default:
      throw new TypeError("Unknown observation.");
  }
}
function sourceKey(source: ActivitySource): string {
  for (const part of [source.instance, source.incarnation, source.terminal]) {
    if (!text(part, 128)) throw new TypeError("Empty source identity.");
  }
  return JSON.stringify([source.instance, source.incarnation, source.terminal]);
}
function decodeSource(key: string): ActivitySource {
  const data: unknown = JSON.parse(key);
  assert(Array.isArray(data) && data.length === 3);
  const [instance, incarnation, terminal] = data;
  assert(
    typeof instance === "string" && typeof incarnation === "string" && typeof terminal === "string",
  );
  return { instance, incarnation, terminal };
}
function number(value: unknown): number {
  assert(typeof value === "number");
  return value;
}
function string(value: unknown): string {
  assert(typeof value === "string");
  return value;
}

/** One database per Unix owner. All acceptance and policy writes are one durable transaction. */
export class Activity {
  private readonly db: DatabaseSync;
  private readonly observers = new Set<() => void>();
  readonly options: ActivityOptions;
  constructor(path: string, options: ActivityOptions = activityDefaults) {
    this.options = { ...options };
    integer(options.records, 64, 256);
    integer(options.sources, 1, 100_000);
    integer(options.history, 1, 1_000_000);
    integer(options.retentionDays, 1, 3650);
    integer(options.burst, 1, 1000);
    integer(options.intervalMs, 1000, 86_400_000);
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS source (
        key TEXT PRIMARY KEY, sequence INTEGER NOT NULL, available INTEGER NOT NULL,
        retired INTEGER NOT NULL DEFAULT 0, gap INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS record (
        source TEXT NOT NULL REFERENCES source(key) ON DELETE CASCADE,
        id TEXT NOT NULL, value TEXT NOT NULL, sequence INTEGER NOT NULL,
        PRIMARY KEY(source,id)
      );
      CREATE TABLE IF NOT EXISTS activity (
        id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, record TEXT NOT NULL,
        event TEXT NOT NULL, received INTEGER NOT NULL, read INTEGER NOT NULL DEFAULT 0,
        delivery TEXT NOT NULL DEFAULT 'inbox'
      );
      CREATE TABLE IF NOT EXISTS pending (
        source TEXT NOT NULL, record TEXT NOT NULL, activity INTEGER NOT NULL REFERENCES activity(id) ON DELETE CASCADE,
        attempts INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(source,record)
      );
      CREATE TABLE IF NOT EXISTS notification (
        source TEXT NOT NULL REFERENCES source(key) ON DELETE CASCADE,
        id INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(source,id)
      );
      CREATE INDEX IF NOT EXISTS activity_received ON activity(received);
      CREATE TABLE IF NOT EXISTS subscription (endpoint TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS policy (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS rate (source TEXT PRIMARY KEY, started INTEGER NOT NULL, count INTEGER NOT NULL);
      UPDATE source SET available=0;
    `);
  }
  close(): void {
    this.db.close();
  }
  watch(observer: () => void): () => void {
    this.observers.add(observer);
    return () => {
      this.observers.delete(observer);
    };
  }
  private changed(): void {
    for (const observer of this.observers) observer();
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
  accept(source: ActivitySource, sequence: number, input: unknown, now = Date.now()): boolean {
    const key = sourceKey(source);
    integer(sequence, 1, Number.MAX_SAFE_INTEGER);
    const event = observation(input);
    if (event.type === "snapshot" && event.records.length > this.options.records)
      throw new TypeError("Snapshot exceeds record quota.");
    const accepted = this.transaction(() => {
      const previous = this.db.prepare("SELECT * FROM source WHERE key=?").get(key);
      if (previous && (previous.retired || sequence <= number(previous.sequence))) return false;
      if (!previous) {
        const count = number(this.db.prepare("SELECT count(*) AS n FROM source").get()?.n);
        if (count >= this.options.sources) throw new Error("Source quota exceeded.");
        this.db.prepare("INSERT INTO source(key,sequence,available) VALUES(?,0,1)").run(key);
      }
      const gap = sequence !== (previous ? number(previous.sequence) : 0) + 1;
      this.db
        .prepare("UPDATE source SET sequence=?,available=1,gap=MAX(gap,?) WHERE key=?")
        .run(sequence, Number(gap), key);
      const cancel = (id: string) => {
        this.db
          .prepare(
            "UPDATE activity SET delivery='superseded' WHERE id IN (SELECT activity FROM pending WHERE source=? AND record=?)",
          )
          .run(key, id);
        this.db.prepare("DELETE FROM pending WHERE source=? AND record=?").run(key, id);
      };
      const records = () =>
        this.db
          .prepare("SELECT id,value FROM record WHERE source=?")
          .all(key)
          .map((row) => programStatus(JSON.parse(string(row.value)) as unknown));
      const remove = (id: string) => {
        cancel(id);
        this.db.prepare("DELETE FROM record WHERE source=? AND id=?").run(key, id);
      };
      const replace = (record: ProgramStatus) => {
        this.db
          .prepare(
            "INSERT INTO record VALUES(?,?,?,?) ON CONFLICT(source,id) DO UPDATE SET value=excluded.value,sequence=excluded.sequence",
          )
          .run(key, record.id, JSON.stringify(record), sequence);
        const excess = this.db
          .prepare(
            "SELECT id FROM record WHERE source=? ORDER BY sequence DESC,id LIMIT -1 OFFSET ?",
          )
          .all(key, this.options.records);
        for (const row of excess) remove(string(row.id));
      };
      const append = (id: string, push: boolean) => {
        cancel(id);
        const rate = this.db.prepare("SELECT * FROM rate WHERE source=?").get(key);
        const started =
          rate &&
          now >= number(rate.started) &&
          now - number(rate.started) < this.options.intervalMs
            ? number(rate.started)
            : now;
        const recent = rate && started === number(rate.started) ? number(rate.count) : 0;
        this.db
          .prepare(
            "INSERT INTO rate VALUES(?,?,?) ON CONFLICT(source) DO UPDATE SET started=excluded.started,count=excluded.count",
          )
          .run(key, started, Math.min(recent + 1, this.options.burst));
        // Inbox storage is bounded even when sources ignore presentation rate limits.
        const delivery = !push ? "inbox" : recent < this.options.burst ? "pending" : "limited";
        const row = this.db
          .prepare("INSERT INTO activity(source,record,event,received,delivery) VALUES(?,?,?,?,?)")
          .run(key, id, JSON.stringify(event), now, delivery);
        if (delivery === "pending")
          this.db
            .prepare("INSERT INTO pending(source,record,activity) VALUES(?,?,?)")
            .run(key, id, row.lastInsertRowid);
      };
      switch (event.type) {
        case "gap":
          this.db.prepare("UPDATE source SET gap=1 WHERE key=?").run(key);
          break;
        case "status": {
          const before = records().find((r) => r.id === event.record.id);
          replace(event.record);
          const { state, kind } = event.record;
          if (state !== "blocked" && state !== "done" && state !== "error") cancel(event.record.id);
          else if (!before || before.state !== state || before.kind !== kind)
            append(event.record.id, true);
          break;
        }
        case "clear":
          for (const record of records())
            if (!event.id || record.id === event.id || record.id.startsWith(`${event.id}/`))
              remove(record.id);
          break;
        case "boundary":
          for (const record of records())
            if (record.state === "idle" || record.state === "working" || record.state === "blocked")
              remove(record.id);
          break;
        case "snapshot":
          for (const record of records()) {
            const next = event.records.find((r) => r.id === record.id);
            if (!next) remove(record.id);
            else if (next.state !== record.state || next.kind !== record.kind) cancel(record.id);
          }
          for (const record of event.records) replace(record);
          break;
        case "retire":
          this.retireKey(key);
          break;
        case "notify": {
          const count = number(
            this.db.prepare("SELECT count(*) AS n FROM notification WHERE source=?").get(key)?.n,
          );
          const existing = this.db
            .prepare("SELECT id FROM notification WHERE source=? AND id=?")
            .get(key, event.notification.id);
          if (!existing && count >= this.options.records)
            throw new Error("Notification quota exceeded.");
          this.db
            .prepare(
              "INSERT INTO notification VALUES(?,?,?) ON CONFLICT(source,id) DO UPDATE SET value=excluded.value",
            )
            .run(key, event.notification.id, JSON.stringify(event.notification));
          append(
            `notification/${event.notification.id}`,
            !event.notification.expiresAt || event.notification.expiresAt > now,
          );
          break;
        }
        case "close":
          cancel(`notification/${event.id}`);
          this.db.prepare("DELETE FROM notification WHERE source=? AND id=?").run(key, event.id);
          append(`notification/${event.id}`, false);
          break;
      }
      this.db
        .prepare(
          "DELETE FROM activity WHERE received<? OR id IN (SELECT id FROM activity ORDER BY id DESC LIMIT -1 OFFSET ?)",
        )
        .run(now - this.options.retentionDays * 86_400_000, this.options.history);
      return true;
    });
    if (accepted) this.changed();
    return accepted;
  }
  unavailable(source: ActivitySource): void {
    const result = this.db
      .prepare("UPDATE source SET available=0 WHERE key=? AND available=1")
      .run(sourceKey(source));
    if (result.changes) this.changed();
  }
  gap(source: ActivitySource): void {
    this.db.prepare("UPDATE source SET available=0,gap=1 WHERE key=?").run(sourceKey(source));
    this.changed();
  }
  private retireKey(key: string): void {
    this.db.prepare("UPDATE source SET available=0,retired=1 WHERE key=?").run(key);
    this.db
      .prepare(
        "UPDATE activity SET delivery='superseded' WHERE id IN (SELECT activity FROM pending WHERE source=?)",
      )
      .run(key);
    this.db.prepare("DELETE FROM pending WHERE source=?").run(key);
    this.db.prepare("DELETE FROM record WHERE source=?").run(key);
    this.db.prepare("DELETE FROM notification WHERE source=?").run(key);
  }
  retireInstance(instance: string, incarnation?: string): void {
    const changed = this.transaction(() => {
      const rows = this.db
        .prepare(
          "SELECT key FROM source WHERE retired=0 AND json_extract(key,'$[0]')=? AND (? IS NULL OR json_extract(key,'$[1]')!=?)",
        )
        .all(instance, incarnation ?? null, incarnation ?? null);
      for (const row of rows) this.retireKey(string(row.key));
      return rows.length > 0;
    });
    if (changed) this.changed();
  }
  availableInstance(instance: string, incarnation: string): void {
    this.db
      .prepare(
        "UPDATE source SET available=1 WHERE retired=0 AND json_extract(key,'$[0]')=? AND json_extract(key,'$[1]')=?",
      )
      .run(instance, incarnation);
    this.changed();
  }
  sequence(source: ActivitySource): number {
    const row = this.db.prepare("SELECT sequence FROM source WHERE key=?").get(sourceKey(source));
    return row ? number(row.sequence) : 0;
  }
  identities(): ActivitySource[] {
    return this.db
      .prepare("SELECT key FROM source")
      .all()
      .map((row) => decodeSource(string(row.key)));
  }
  sources(): SourceView[] {
    return this.db
      .prepare("SELECT * FROM source ORDER BY key")
      .all()
      .map((row) => {
        const key = string(row.key);
        const records = this.db
          .prepare("SELECT value FROM record WHERE source=? ORDER BY id")
          .all(key)
          .map((record) => programStatus(JSON.parse(string(record.value)) as unknown));
        return {
          source: decodeSource(key),
          available: Boolean(row.available),
          retired: Boolean(row.retired),
          gap: Boolean(row.gap),
          sequence: number(row.sequence),
          notifications: this.db
            .prepare("SELECT value FROM notification WHERE source=? ORDER BY id")
            .all(key)
            .map((n) => {
              const event = observation({
                type: "notify",
                notification: JSON.parse(string(n.value)) as unknown,
              });
              assert(event.type === "notify");
              return event.notification;
            }),
          records: records.map((record) => {
            if (record.app) return record;
            let id = record.id;
            while (id) {
              id = id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : "";
              const app = records.find((parent) => parent.id === id)?.app;
              if (app) return { ...record, app };
            }
            return record;
          }),
        };
      });
  }
  history(limit = 100, selected?: number): ActivityItem[] {
    integer(limit, 1, 1000);
    const rows = this.db.prepare("SELECT * FROM activity ORDER BY id DESC LIMIT ?").all(limit);
    if (selected !== undefined) {
      integer(selected, 1, Number.MAX_SAFE_INTEGER);
      if (!rows.some((row) => row.id === selected)) {
        const item = this.db.prepare("SELECT * FROM activity WHERE id=?").get(selected);
        if (item) rows.unshift(item);
      }
    }
    return rows.map((row) => ({
      id: number(row.id),
      source: decodeSource(string(row.source)),
      record: string(row.record),
      event: observation(JSON.parse(string(row.event)) as unknown),
      received: number(row.received),
      read: Boolean(row.read),
      delivery: string(row.delivery),
    }));
  }
  prune(now = Date.now()): void {
    const result = this.db
      .prepare("DELETE FROM activity WHERE received<?")
      .run(now - this.options.retentionDays * 86_400_000);
    if (result.changes) this.changed();
  }
  read(id: number): void {
    integer(id, 1, Number.MAX_SAFE_INTEGER);
    this.db.prepare("UPDATE activity SET read=1 WHERE id=?").run(id);
    this.changed();
  }
  /** Global owner rate limit persists across process restarts. */
  takePending(now = Date.now()): number | undefined {
    return this.transaction(() => {
      this.db
        .prepare(
          "UPDATE activity SET delivery='expired' WHERE id IN (SELECT activity FROM pending) AND json_extract(event,'$.notification.expiresAt')>0 AND json_extract(event,'$.notification.expiresAt')<=?",
        )
        .run(now);
      this.db.exec(
        "DELETE FROM pending WHERE activity IN (SELECT id FROM activity WHERE delivery='expired')",
      );
      const last = this.db.prepare("SELECT value FROM policy WHERE key='lastPush'").get();
      if (last && now - number(last.value) < this.options.intervalMs / this.options.burst) return;
      const row = this.db.prepare("SELECT activity FROM pending ORDER BY activity LIMIT 1").get();
      if (!row) return;
      this.db
        .prepare(
          "INSERT INTO policy VALUES('lastPush',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(now);
      this.db.prepare("UPDATE pending SET attempts=attempts+1 WHERE activity=?").run(row.activity);
      return number(row.activity);
    });
  }
  attempts(id: number): number {
    const row = this.db.prepare("SELECT attempts FROM pending WHERE activity=?").get(id);
    return row ? number(row.attempts) : 0;
  }
  delivered(id: number, result: "sent" | "failed" | "disabled"): void {
    this.transaction(() => {
      this.db.prepare("UPDATE activity SET delivery=? WHERE id=?").run(result, id);
      this.db.prepare("DELETE FROM pending WHERE activity=?").run(id);
    });
    this.changed();
  }
  subscriptions(): unknown[] {
    return this.db
      .prepare("SELECT value FROM subscription ORDER BY endpoint")
      .all()
      .map((row) => JSON.parse(string(row.value)) as unknown);
  }
  subscribe(endpoint: string, value: unknown): void {
    const count = number(this.db.prepare("SELECT count(*) AS n FROM subscription").get()?.n);
    if (
      count >= 32 &&
      !this.db.prepare("SELECT endpoint FROM subscription WHERE endpoint=?").get(endpoint)
    )
      throw new Error("Subscription quota exceeded.");
    this.db
      .prepare(
        "INSERT INTO subscription VALUES(?,?) ON CONFLICT(endpoint) DO UPDATE SET value=excluded.value",
      )
      .run(endpoint, JSON.stringify(value));
  }
  unsubscribe(endpoint: string): void {
    this.db.prepare("DELETE FROM subscription WHERE endpoint=?").run(endpoint);
  }
}
