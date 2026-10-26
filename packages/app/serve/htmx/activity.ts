import { activityView, type ActivitySnapshot } from "../activity-view.ts";
import { activityPost, enablePush } from "../pwa.ts";
function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}
let publicKey: string | null = null;
const selected = /^#activity-([1-9][0-9]*)$/.exec(location.hash)?.[1];
const events = new EventSource(`/htmx/activity/events${selected ? `?item=${selected}` : ""}`);
const connection = document.querySelector<HTMLElement>("#connection")!;
events.onopen = () => {
  connection.textContent = "Connected";
};
events.onerror = () => {
  connection.textContent = "Disconnected; reconnecting…";
};
events.onmessage = (event: MessageEvent<string>) => {
  const data = JSON.parse(event.data) as ActivitySnapshot;
  publicKey = data.publicKey;
  const view = activityView(data, "/htmx");
  document.querySelector("#sources")!.replaceChildren(
    ...view.sources.map((source) => {
      const section = element("section");
      section.append(
        element("h3", source.title),
        ...source.lines.map((line) => element("p", line)),
      );
      return section;
    }),
  );
  document.querySelector("#inbox")!.replaceChildren(
    ...view.history.map((item) => {
      const article = element("article");
      article.id = `activity-${item.id}`;
      article.append(element("h3", item.label), element("p", item.source));
      if (item.body) {
        const body = element("p", item.body);
        body.className = "activity-body";
        article.append(body);
      }
      if (item.path) {
        const link = element("a", "Open conversation");
        link.href = item.path;
        article.append(link);
      } else article.append(element("p", item.unavailable));
      const button = element("button", item.read ? "Read" : "Mark read");
      button.disabled = item.read;
      button.addEventListener("click", () => {
        void activityPost("read", { id: item.id }).catch(showError);
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
for (const [id, enabled] of [
  ["enable-push", true],
  ["disable-push", false],
] as const)
  document.getElementById(id)!.addEventListener("click", () => {
    void enablePush(enabled, publicKey)
      .then((message) => {
        document.querySelector<HTMLElement>("#push-status")!.textContent = message;
      })
      .catch(showError);
  });
window.addEventListener("pagehide", () => events.close());

document.addEventListener("htmx:before:swap", (event) => {
  if (
    event.detail.ctx.target === document.getElementById("page") &&
    event.detail.ctx.swap !== "none"
  )
    events.close();
});
