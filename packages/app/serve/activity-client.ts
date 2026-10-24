import type { ActivityItem, SourceView } from "./activity.ts";

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}
async function post(path: string, value: unknown): Promise<void> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
  if (!response.ok) throw new Error(`Request failed (${response.status}).`);
}
let publicKey: string | null = null;
const selected = /^#activity-([1-9][0-9]*)$/.exec(location.hash)?.[1];
const events = new EventSource(`/activity/events${selected ? `?item=${selected}` : ""}`);
const connection = document.querySelector<HTMLElement>("#connection")!;
events.onopen = () => {
  connection.textContent = "Connected";
};
events.onerror = () => {
  connection.textContent = "Disconnected; reconnecting…";
};
events.onmessage = (event: MessageEvent<string>) => {
  const data = JSON.parse(event.data) as {
    sources: SourceView[];
    history: ActivityItem[];
    publicKey: string | null;
  };
  publicKey = data.publicKey;
  const sources = document.querySelector("#sources")!;
  sources.replaceChildren(
    ...data.sources.map((source) => {
      const section = element("section");
      section.append(
        element(
          "h3",
          `${source.source.instance} · ${source.source.terminal} · ${source.source.incarnation}`,
        ),
      );
      section.append(
        element(
          "p",
          `${source.retired ? "Retired" : source.available ? "Available" : "Unavailable"}${source.gap ? " · observation gap" : ""}`,
        ),
      );
      for (const record of source.records)
        section.append(
          element(
            "p",
            `${record.id || "root"}: ${record.state}${record.kind ? ` (${record.kind})` : ""}${record.progress !== undefined ? ` · ${record.progress}%` : ""}${record.msg ? ` · ${record.msg}` : ""}`,
          ),
        );
      for (const notification of source.notifications) {
        const expired = Boolean(notification.expiresAt && notification.expiresAt <= Date.now());
        section.append(
          element(
            "p",
            `${notification.app}: ${notification.summary}${expired ? " · expired" : ""}`,
          ),
        );
      }
      return section;
    }),
  );
  const inbox = document.querySelector("#inbox")!;
  inbox.replaceChildren(
    ...data.history.map((item) => {
      const article = element("article");
      article.id = `activity-${item.id}`;
      const event = item.event;
      const label =
        event.type === "status"
          ? `${event.record.state}${event.record.msg ? ` · ${event.record.msg}` : ""}`
          : event.type === "notify"
            ? event.notification.summary
            : event.type;
      article.append(
        element("h3", label),
        element(
          "p",
          `${item.source.instance} · ${item.source.terminal} · ${new Date(item.received).toLocaleString()} · ${item.delivery}`,
        ),
      );
      if (event.type === "notify") {
        const body = element("p", event.notification.body);
        body.style.whiteSpace = "pre-wrap";
        article.append(body);
      }
      // Only host-native identities produce app links. Guest text never supplies a URL.
      if (
        item.source.instance === "host-pi" &&
        /^[0-9a-f-]{36}$/.test(item.source.incarnation) &&
        /^\d+\/\d+$/.test(item.record)
      ) {
        const link = element("a", "Open conversation");
        link.href = `/sessions/${item.source.incarnation}/conversations/${item.record.split("/")[0]}`;
        article.append(link);
      } else
        article.append(
          element(
            "p",
            item.source.terminal.startsWith("dbus-root/")
              ? "Guest notification. No terminal session is associated with this item."
              : "This source has no session link.",
          ),
        );
      const button = element("button", item.read ? "Read" : "Mark read");
      button.disabled = item.read;
      button.addEventListener("click", () => {
        void post("/activity/read", { id: item.id }).catch(showError);
      });
      article.append(button);
      return article;
    }),
  );
};
function showError(error: unknown): void {
  document.querySelector<HTMLElement>("#push-status")!.textContent =
    error instanceof Error ? error.message : "Request failed.";
}
async function registration(): Promise<ServiceWorkerRegistration> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window))
    throw new Error("Web Push is unavailable in this browser.");
  await navigator.serviceWorker.register("/htmx/sw.js", { scope: "/" });
  return await navigator.serviceWorker.ready;
}
document.querySelector("#enable-push")!.addEventListener("click", () => {
  void (async () => {
    if (!publicKey) throw new Error("Push is disabled by host policy.");
    if (!("Notification" in window) || (await Notification.requestPermission()) !== "granted")
      throw new Error("Notification permission was not granted.");
    const worker = await registration();
    const key = Uint8Array.from(atob(publicKey.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
      c.charCodeAt(0),
    );
    let subscription = await worker.pushManager.getSubscription();
    const previous = subscription?.options.applicationServerKey;
    if (
      subscription &&
      (!previous ||
        new Uint8Array(previous).length !== key.length ||
        !new Uint8Array(previous).every((byte, index) => byte === key[index]))
    ) {
      await post("/activity/unsubscribe", { endpoint: subscription.endpoint });
      await subscription.unsubscribe();
      subscription = null;
    }
    subscription ??= await worker.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: key,
    });
    await post("/activity/subscribe", subscription.toJSON());
    document.querySelector<HTMLElement>("#push-status")!.textContent =
      "Push enabled on this device.";
  })().catch(showError);
});
document.querySelector("#disable-push")!.addEventListener("click", () => {
  void (async () => {
    const subscription = await (await registration()).pushManager.getSubscription();
    if (subscription) {
      await post("/activity/unsubscribe", { endpoint: subscription.endpoint });
      await subscription.unsubscribe();
    }
    document.querySelector<HTMLElement>("#push-status")!.textContent =
      "Push disabled on this device.";
  })().catch(showError);
});
