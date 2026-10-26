import type { ActivityItem, SourceView } from "./activity.ts";

export type ActivitySnapshot = {
  sources: SourceView[];
  history: ActivityItem[];
  publicKey: string | null;
};
export function activityView(snapshot: ActivitySnapshot, root: string) {
  return {
    sources: snapshot.sources.map((source) => ({
      title: `${source.source.instance} · ${source.source.terminal} · ${source.source.incarnation}`,
      lines: [
        `${source.retired ? "Retired" : source.available ? "Available" : "Unavailable"}${source.gap ? " · observation gap" : ""}`,
        ...source.records.map(
          (record) =>
            `${record.id || "root"}: ${record.state}${record.kind ? ` (${record.kind})` : ""}${record.progress !== undefined ? ` · ${record.progress}%` : ""}${record.msg ? ` · ${record.msg}` : ""}`,
        ),
        ...source.notifications.map(
          (notification) =>
            `${notification.app}: ${notification.summary}${notification.expiresAt && notification.expiresAt <= Date.now() ? " · expired" : ""}`,
        ),
      ],
    })),
    history: snapshot.history.map((item) => ({
      id: item.id,
      label:
        item.event.type === "status"
          ? `${item.event.record.state}${item.event.record.msg ? ` · ${item.event.record.msg}` : ""}`
          : item.event.type === "notify"
            ? item.event.notification.summary
            : item.event.type,
      source: `${item.source.instance} · ${item.source.terminal} · ${new Date(item.received).toLocaleString()} · ${item.delivery}`,
      body: item.event.type === "notify" ? item.event.notification.body : "",
      path:
        item.source.instance === "host-pi" &&
        item.source.terminal === "api" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
          item.source.incarnation,
        ) &&
        /^[1-9][0-9]*(?:\/[1-9][0-9]*)?$/.test(item.record)
          ? `${root}/sessions/${item.source.incarnation}/conversations/${item.record.split("/")[0]}`
          : "",
      unavailable: item.source.terminal.startsWith("dbus-root/")
        ? "Guest notification. No terminal session is associated with this item."
        : "This source has no session link.",
      read: item.read,
    })),
  };
}
