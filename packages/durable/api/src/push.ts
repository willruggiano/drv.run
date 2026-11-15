/*
 * Imports
 */

import assert from "node:assert/strict";
import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness, CommitObservation, ConversationId } from "@earendil-works/pi-durable";
import { sendNotification, WebPushError, type PushSubscription } from "web-push";
import { pushURL, pushSubscription, vapidKey, vapidPublic } from "push-policy";
import type { PushBinding } from "../graphql/src/graphql.ts";

/*
 * Exports: Push
 */

export type PushConfiguration = {
  origins: readonly string[];
  subject: string;
  privateKeyFile: string;
};

export async function openPush(directory: string, config: PushConfiguration | undefined) {
  let vapid: { subject: string; publicKey: string; privateKey: string } | undefined;
  if (config) {
    const value = vapidKey(JSON.parse(await readFile(config.privateKeyFile, "utf8")));
    const subject = new URL(config.subject);
    assert(
      subject.protocol === "mailto:" || subject.protocol === "https:",
      "Invalid VAPID subject",
    );
    for (const origin of config.origins) assert(pushURL(origin, config.origins).origin === origin);
    vapid = {
      subject: config.subject,
      publicKey: vapidPublic(value),
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
  const failures: unknown[] = [];
  let closing: Promise<void> | undefined;
  const service: PushBinding = {
    async applicationServerKey() {
      return vapid?.publicKey;
    },
    async registered(endpoint) {
      const row = db
        .prepare("SELECT endpoint, data FROM subscriptions WHERE endpoint = ?")
        .get(endpoint);
      if (row) stored(row);
      return { value: row !== undefined };
    },
    async register(value, context) {
      context.abortSignal?.throwIfAborted();
      let checked: PushSubscription;
      try {
        checked = pushSubscription(value, config?.origins ?? []);
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
            if (sending.size >= 16) continue;
            const work = Promise.resolve()
              .then(async () => {
                if (!closing) await deliver(externalId, id, failed, harness);
              })
              .catch((error: unknown) => {
                failures.push(error);
                console.error("Push observation failed", error);
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
        if (failures.length) throw new AggregateError(failures, "Push observation failed");
      })();
      return closing;
    },
  };

  /*
   * Helpers: HTTP server
   */

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
      const target = stored(row);
      if (!config.origins.includes(new URL(target.endpoint).origin)) continue;
      try {
        await sendNotification(target, payload, {
          vapidDetails: vapid,
          TTL: 300,
          timeout: 10_000,
          contentEncoding: "aes128gcm",
        });
      } catch (error) {
        if (error instanceof WebPushError && (error.statusCode === 404 || error.statusCode === 410))
          db.prepare("DELETE FROM subscriptions WHERE endpoint = ? AND data = ?").run(
            target.endpoint,
            row.data!,
          );
        else console.error("Push delivery failed", error);
      }
    }
  }
}

/*
 * Helpers: Push
 */

function stored(row: Record<string, SQLOutputValue>): PushSubscription {
  assert(typeof row.data === "string");
  const target = pushSubscription(JSON.parse(row.data));
  assert.equal(target.endpoint, row.endpoint);
  return target;
}
