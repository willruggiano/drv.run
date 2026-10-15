import { tokenize } from "@speed-highlight/core";

type Owner = { epoch: number; attempt: number };
type Request = Owner &
  (
    | { kind: "watch"; url: string }
    | { kind: "close"; handle: EventSource }
    | { kind: "image"; id: number; mime: string; data: string }
    | { kind: "revoke"; url: string }
    | { kind: "selection"; id: string; caret: number }
    | { kind: "syntax"; requests: { id: number; language: string; source: string }[] }
  );
type App = {
  ports: {
    conversationBrowser: { subscribe(callback: (request: Request) => void): void };
    conversationEvents: { send(value: Owner & { kind: string; payload: unknown }): void };
    warnOnExit: { subscribe(callback: (warning: boolean) => void): void };
    pageVisibility: { send(hidden: boolean): void };
  };
};
declare const Elm: { Main: { init(options: { flags: string }): App } };

const app = Elm.Main.init({
  flags: Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join(""),
});

app.ports.conversationBrowser.subscribe((request) => {
  const reply = (kind: string, payload: unknown) =>
    app.ports.conversationEvents.send({
      epoch: request.epoch,
      attempt: request.attempt,
      kind,
      payload,
    });
  switch (request.kind) {
    case "watch": {
      const handle = new EventSource(request.url);
      handle.onmessage = (event: MessageEvent<string>) => reply("batch", event.data);
      handle.onerror = () => reply("connection", handle.readyState);
      // Opaque native handle: Elm owns its lifetime and returns it only to close.
      reply("opened", handle);
      break;
    }
    case "close":
      request.handle.close();
      break;
    case "image":
      try {
        const bytes = Uint8Array.from(atob(request.data), (character) => character.charCodeAt(0));
        reply("image", {
          id: request.id,
          url: URL.createObjectURL(new Blob([bytes], { type: request.mime })),
        });
      } catch {
        reply("image", { id: request.id, url: null });
      }
      break;
    case "revoke":
      URL.revokeObjectURL(request.url);
      break;
    case "selection": {
      const input = document.getElementById(request.id);
      if (input instanceof HTMLTextAreaElement)
        input.setSelectionRange(request.caret, request.caret);
      break;
    }
    case "syntax":
      void Promise.all(
        request.requests.map(async ({ id, language, source }) => {
          const tokens: { text: string; kind: string }[] = [];
          await tokenize(source, language, (text, kind) => tokens.push({ text, kind: kind ?? "" }));
          return { id, tokens };
        }),
      ).then(
        (result) => reply("syntax", result),
        () => reply("syntaxFailed", null),
      );
      break;
  }
});

window.addEventListener("pagehide", () => app.ports.pageVisibility.send(true));
window.addEventListener("pageshow", () => app.ports.pageVisibility.send(false));

let warnOnExit = false;
app.ports.warnOnExit.subscribe((warning) => {
  warnOnExit = warning;
});
window.addEventListener("beforeunload", (event) => {
  if (warnOnExit) event.preventDefault();
});
