import type { SyntaxRequest } from "../highlight.ts";

declare const Elm: {
  FileView: {
    init(options: { flags: unknown }): {
      ports: {
        fileBrowser: { subscribe(callback: (requests: SyntaxRequest[]) => void): void };
        fileIncoming: { send(value: unknown): void };
      };
    };
  };
};

const data = document.getElementById("file-data");
if (!data) throw new Error("Missing file viewer bootstrap.");
const app = Elm.FileView.init({
  flags: { ...JSON.parse(data.textContent ?? ""), fragment: location.hash },
});
const highlighterURL = "/highlight.js";
app.ports.fileBrowser.subscribe((requests) => {
  void import(highlighterURL)
    .then((module: typeof import("../highlight.ts")) =>
      app.ports.fileIncoming.send(module.tokenize(requests)),
    )
    .catch(() => app.ports.fileIncoming.send({ error: "Syntax highlighting failed." }));
});
