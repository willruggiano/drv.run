import { activityView, type ActivitySnapshot } from "../activity-view.ts";
import {
  enablePush,
  installPwa,
  installPreferences,
  restorePreferences,
  installStatus,
} from "../pwa.ts";
import { installSelectKeyMappings, navigationDirection, moveFocus } from "../key-mappings.ts";

type Request =
  | { kind: "rendered" | "resize" | "activity" }
  | {
      kind: "draft";
      text: string;
      creation: string;
      missingFiles: boolean;
      options: Record<string, string>;
    }
  | { kind: "created" | "navigate"; path: string }
  | { kind: "push"; enabled: boolean };
declare const Elm: {
  Site: {
    init(options: {
      flags: {
        text: string;
        creation: string;
        missingFiles: boolean;
        options: Record<string, string>;
      };
    }): {
      ports: {
        siteBrowser: { subscribe(callback: (value: Request) => void): void };
        siteIncoming: { send(value: unknown): void };
      };
    };
  };
};
let draft: {
  text: string;
  creation: string;
  missingFiles: boolean;
  options: Record<string, string>;
} = {
  text: "",
  creation: crypto.randomUUID(),
  missingFiles: false,
  options: {},
};
try {
  const saved: unknown = JSON.parse(sessionStorage.getItem("pi.elm.creation") ?? "null");
  if (
    saved &&
    typeof saved === "object" &&
    "text" in saved &&
    typeof saved.text === "string" &&
    "creation" in saved &&
    typeof saved.creation === "string" &&
    /^[0-9a-f-]{36}$/.test(saved.creation)
  )
    draft = {
      text: saved.text,
      creation: saved.creation,
      missingFiles: "missingFiles" in saved && saved.missingFiles === true,
      options:
        "options" in saved && saved.options && typeof saved.options === "object"
          ? Object.fromEntries(
              Object.entries(saved.options).filter(
                (entry): entry is [string, string] => typeof entry[1] === "string",
              ),
            )
          : {},
    };
} catch {
  /* In-memory drafts remain usable. */
}
const app = Elm.Site.init({
  flags: draft,
});
document.body.classList.add("stacked-layout", "bottom-align");
installPwa();
installPreferences();
installSelectKeyMappings(document);
let events: EventSource | undefined;
let publicKey: string | null = null;
function resize() {
  const prompt = document.querySelector<HTMLTextAreaElement>("#prompt");
  if (prompt) {
    prompt.style.height = "auto";
    prompt.style.height = `${prompt.scrollHeight}px`;
  }
}
function status(value: string) {
  app.ports.siteIncoming.send({ kind: "status", value });
}
app.ports.siteBrowser.subscribe((request) => {
  switch (request.kind) {
    case "rendered":
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          restorePreferences();
          installStatus();
          resize();
          document.querySelectorAll<HTMLTimeElement>("time[data-date-only]").forEach((node) => {
            const date = new Date(node.dateTime);
            node.textContent = date.toLocaleDateString();
            node.title = date.toLocaleString();
          });
        }),
      );
      break;
    case "resize":
      requestAnimationFrame(resize);
      break;
    case "draft":
      try {
        sessionStorage.setItem("pi.elm.creation", JSON.stringify(request));
      } catch {
        /* Optional storage. */
      }
      break;
    case "navigate":
      location.assign(request.path);
      break;
    case "created":
      try {
        sessionStorage.removeItem("pi.elm.creation");
      } catch {
        /* Optional storage. */
      }
      location.assign(request.path);
      break;
    case "activity": {
      if (events) break;
      const selected = /^#activity-([1-9][0-9]*)$/.exec(location.hash)?.[1];
      events = new EventSource(`/elm/activity/events${selected ? `?item=${selected}` : ""}`);
      events.onmessage = (event: MessageEvent<string>) => {
        const snapshot = JSON.parse(event.data) as ActivitySnapshot;
        publicKey = snapshot.publicKey;
        app.ports.siteIncoming.send({ kind: "activity", value: activityView(snapshot, "/elm") });
      };
      events.onerror = () => app.ports.siteIncoming.send({ kind: "disconnected" });
      break;
    }
    case "push":
      void enablePush(request.enabled, publicKey)
        .then(status)
        .catch((error: unknown) =>
          status(error instanceof Error ? error.message : "Request failed."),
        );
      break;
  }
});
window.addEventListener("resize", resize);
window.addEventListener("pagehide", () => events?.close());
window.addEventListener("pageshow", (event) => {
  if (event.persisted) location.reload();
});
document.addEventListener("keydown", (event) => {
  if (event.defaultPrevented || event.isComposing) return;
  if (
    (event.metaKey || event.ctrlKey) &&
    event.key === "k" &&
    !event.shiftKey &&
    !navigationDirection(event)
  ) {
    event.preventDefault();
    app.ports.siteIncoming.send({ kind: "home" });
    return;
  }
  const direction = navigationDirection(event);
  const rows = Array.from(document.querySelectorAll<HTMLElement>("#session-list a"));
  if (direction && rows.length) {
    event.preventDefault();
    moveFocus(rows, direction);
    return;
  }
  if (
    event.target instanceof Element &&
    event.target.closest("input, textarea, select, [contenteditable]")
  )
    return;
  if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
  const id = { t: "targets", m: "models", n: "create" }[event.key];
  const control = id && document.getElementById(id);
  if (!control || control.matches(":disabled")) return;
  event.preventDefault();
  const details = control.closest("details");
  if (details) details.open = true;
  control.focus();
  if (control instanceof HTMLButtonElement) control.click();
  if (control instanceof HTMLSelectElement) {
    try {
      control.showPicker();
    } catch {
      /* Optional native picker. */
    }
  }
});

for (const name of ["paste", "drop"])
  document.addEventListener(name, (event) => {
    if (document.querySelector<HTMLButtonElement>("#input-toggle")?.disabled !== false) return;
    const files =
      event instanceof ClipboardEvent
        ? event.clipboardData?.files
        : event instanceof DragEvent
          ? event.dataTransfer?.files
          : undefined;
    if (files?.length) {
      event.preventDefault();
      app.ports.siteIncoming.send({ kind: "files", value: Array.from(files) });
    }
  });
