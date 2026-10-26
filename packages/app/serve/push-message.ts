import { createHash } from "node:crypto";
import type { ActivityItem } from "./activity.ts";

export type PushMessage = {
  activity: number;
  title: string;
  body: string;
  url: string;
  tag: string;
  timestamp: number;
  icon: string;
  badge: string;
  dir: "auto";
  silent: boolean;
  renotify: boolean;
  requireInteraction: boolean;
  action: string;
};

/** Plain text only; bounds are UTF-8 bytes, never split a code point. */
export function previewText(value: string, max: number, multiline = false): string {
  const clean = value
    .toWellFormed()
    .replace(/[\p{Cc}\p{Cf}]/gu, (character) =>
      multiline && (character === "\n" || character === "\t") ? character : " ",
    )
    .trim();
  if (Buffer.byteLength(clean) <= max) return clean;
  let result = "";
  let bytes = 0;
  for (const character of clean) {
    bytes += Buffer.byteLength(character);
    if (bytes > max - 3) break;
    result += character;
  }
  return result + "…";
}

export function pushMessage(item: ActivityItem): PushMessage {
  const { event, source } = item;
  // Only host-native identities can select a conversation. Guest strings are never URLs.
  const conversation =
    source.instance === "host-pi" &&
    source.terminal === "api" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(source.incarnation)
      ? /^([1-9][0-9]*)(?:\/[1-9][0-9]*)?$/.exec(item.record)?.[1]
      : undefined;
  const status = event.type === "status" ? event.record : undefined;
  const notification = event.type === "notify" ? event.notification : undefined;
  const fallback =
    status?.state === "error"
      ? "Pi needs attention"
      : status?.state === "blocked"
        ? "Pi is waiting for you"
        : "Pi finished";
  const title = notification
    ? notification.summary || notification.app || "Guest notification"
    : status?.title || fallback;
  const body = notification
    ? notification.body ||
      notification.summary ||
      `${notification.app || "An application"} has an update.`
    : status?.msg ||
      (status?.state === "error"
        ? "Open the conversation to review the error."
        : "Ready for your next message.");
  const identity = JSON.stringify([source, conversation ?? item.record]);
  return {
    activity: item.id,
    title: previewText(title, 192),
    body: previewText(body, 2048, true),
    url: conversation
      ? `/sessions/${source.incarnation}/conversations/${conversation}`
      : "/sessions",
    tag: `drv-run-${createHash("sha256").update(identity).digest("hex")}`,
    timestamp: item.received,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    dir: "auto",
    silent: notification?.urgency === 0,
    renotify: notification?.urgency !== 0,
    requireInteraction:
      notification?.urgency === 2 || status?.state === "error" || status?.state === "blocked",
    action: conversation ? "Open conversation" : "Open sessions",
  };
}

/** 4096-byte push-service limit includes the 86-byte header, tag and delimiter. */
export function encodePushMessage(message: PushMessage): Buffer {
  const bounded = { ...message };
  let encoded = Buffer.from(JSON.stringify(bounded));
  while (encoded.length > 3993 && bounded.body.length) {
    bounded.body = previewText(
      bounded.body,
      Math.max(3, Buffer.byteLength(bounded.body) - 128),
      true,
    );
    if (bounded.body === "…") bounded.body = "";
    encoded = Buffer.from(JSON.stringify(bounded));
  }
  if (encoded.length > 3993) throw new TypeError("Push payload exceeds the single-record limit.");
  return encoded;
}
