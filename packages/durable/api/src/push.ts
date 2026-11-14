import assert from "node:assert/strict";
import { createECDH } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness, CommitObservation, ConversationId } from "@earendil-works/pi-durable";
import { sendNotification, WebPushError, type PushSubscription } from "web-push";
import Type from "typebox";
import Value from "typebox/value";
import type { PushBinding } from "../graphql/src/graphql.ts";

export type PushConfiguration = {
  origins: readonly string[];
  subject: string;
  privateKeyFile: string;
};
const Key = Type.Object({
  kty: Type.Literal("EC"),
  crv: Type.Literal("P-256"),
  x: Type.String(),
  y: Type.String(),
  d: Type.String(),
});
const Subscription = Type.Object({
  endpoint: Type.String(),
  keys: Type.Object({ p256dh: Type.String(), auth: Type.String() }),
});
function bytes(value: string, length: number): Buffer {
  const decoded = Buffer.from(value, "base64url");
  assert(decoded.length === length && decoded.toString("base64url") === value, "Invalid push key");
  return decoded;
}
function endpoint(value: string, origins: readonly string[]): URL {
  const url = new URL(value);
  assert(
    url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.hash &&
      !value.includes("#") &&
      origins.includes(url.origin),
    "Push origin is not permitted",
  );
  return url;
}
function subscription(value: unknown, origins: readonly string[]): PushSubscription {
  Value.Assert(Subscription, value);
  endpoint(value.endpoint, origins);
  const publicKey = bytes(value.keys.p256dh, 65);
  assert(publicKey[0] === 4, "Expected uncompressed P-256 key");
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  ecdh.computeSecret(publicKey);
  bytes(value.keys.auth, 16);
  return value;
}

export async function openPush(directory: string, config: PushConfiguration | undefined) {
  let vapid: { subject: string; publicKey: string; privateKey: string } | undefined;
  if (config) {
    const value: unknown = JSON.parse(await readFile(config.privateKeyFile, "utf8"));
    Value.Assert(Key, value);
    const key = createECDH("prime256v1");
    key.setPrivateKey(bytes(value.d, 32));
    const publicKey = Buffer.concat([Buffer.from([4]), bytes(value.x, 32), bytes(value.y, 32)]);
    assert(key.getPublicKey().equals(publicKey), "VAPID key mismatch");
    const subject = new URL(config.subject);
    assert(
      subject.protocol === "mailto:" || subject.protocol === "https:",
      "Invalid VAPID subject",
    );
    for (const origin of config.origins) assert(endpoint(origin, config.origins).origin === origin);
    vapid = {
      subject: config.subject,
      publicKey: publicKey.toString("base64url"),
      privateKey: value.d,
    };
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "push.sqlite");
  const file = await open(path, "a", 0o600);
  await file.close();
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE IF NOT EXISTS subscriptions (endpoint TEXT PRIMARY KEY, data TEXT NOT NULL)",
  );
  const observers = new Set<CommitObservation>();
  const sending = new Set<Promise<void>>();
  let closing: Promise<void> | undefined;
  const service: PushBinding = {
    async applicationServerKey() {
      return vapid?.publicKey;
    },
    async registered(endpoint) {
      return {
        value:
          db.prepare("SELECT 1 FROM subscriptions WHERE endpoint = ?").get(endpoint) !== undefined,
      };
    },
    async register(value, context) {
      context.abortSignal?.throwIfAborted();
      let checked: PushSubscription;
      try {
        checked = subscription(value, config?.origins ?? []);
      } catch {
        return { error: "BAD_REQUEST" };
      }
      db.prepare(
        "INSERT INTO subscriptions VALUES (?, ?) ON CONFLICT(endpoint) DO UPDATE SET data = excluded.data",
      ).run(checked.endpoint, JSON.stringify(checked));
      return { value: undefined };
    },
    async remove(endpoint) {
      db.prepare("DELETE FROM subscriptions WHERE endpoint = ?").run(endpoint);
      return { value: undefined };
    },
  };
  async function deliver(
    externalId: string,
    conversationId: ConversationId,
    failed: boolean,
    harness: Harness,
  ) {
    assert(config);
    assert(vapid);
    const conversation = await harness.commit(
      (tx) => tx.conversation(conversationId),
      BACKGROUND_CONTEXT,
    );
    assert(conversation);
    if (conversation.owner) return;
    const url = `/sessions/${encodeURIComponent(externalId)}/conversations/${conversationId}`;
    const payload = JSON.stringify({
      title: failed ? "Conversation needs attention" : "Response ready",
      body: "Open the conversation to continue.",
      url,
      tag: url,
      timestamp: Date.now(),
    });
    for (const row of db.prepare("SELECT endpoint, data FROM subscriptions").all()) {
      assert(typeof row.endpoint === "string");
      assert(typeof row.data === "string");
      try {
        const target = subscription(JSON.parse(row.data), config.origins);
        await sendNotification(target, payload, {
          vapidDetails: vapid,
          TTL: 300,
          timeout: 10_000,
          contentEncoding: "aes128gcm",
        });
      } catch (error) {
        if (error instanceof WebPushError && (error.statusCode === 404 || error.statusCode === 410))
          db.prepare("DELETE FROM subscriptions WHERE endpoint = ? AND data = ?").run(
            row.endpoint,
            row.data,
          );
        else console.error("Push delivery failed");
      }
    }
  }
  return {
    service,
    attach(harness: Harness, externalId: string): void {
      if (!config || closing) return;
      const observer = harness.observeCommits({
        advance(publication) {
          const completed = new Map<ConversationId, boolean>();
          for (const change of publication.changes) {
            if (change.type !== "submission" || change.value.type === "write") continue;
            const submission = change.value;
            if (submission.status === "done") completed.set(submission.conversationId, false);
            if (submission.status === "unanswered" && submission.reason !== "aborted")
              completed.set(submission.conversationId, true);
          }
          for (const [id, failed] of completed) {
            // Commit observers never call the Session or await delivery. Dropping a
            // notification under load is preferable to blocking agent execution.
            if (sending.size >= 16) continue;
            const work = Promise.resolve()
              .then(async () => {
                if (!closing) await deliver(externalId, id, failed, harness);
              })
              .catch(() => {
                console.error("Push observation failed");
              });
            sending.add(work);
            void work.finally(() => sending.delete(work));
          }
        },
        end() {},
      });
      observers.add(observer);
      void harness.closed.then(() => observers.delete(observer));
    },
    close(): Promise<void> {
      closing ??= (async () => {
        for (const observer of observers) observer.detach();
        observers.clear();
        await Promise.all(sending);
        db.close();
      })();
      return closing;
    },
  };
}
