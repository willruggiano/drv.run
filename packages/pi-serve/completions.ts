export const commands = [
  { name: "sessions", description: "Open sessions" },
  { name: "new", description: "Create a session with the selected target/model" },
  { name: "settings", description: "Session settings" },
  { name: "model", description: "Choose a model" },
  { name: "fork", description: "Open branches" },
  { name: "review", description: "Start a fresh-context review" },
  { name: "end-review", description: "Return, hand off, or fix selected findings" },
  { name: "compact", description: "Compact context · optional instructions" },
  { name: "reset", description: "Reset context · optional handoff (asks for confirmation)" },
  { name: "stop", description: "Stop the current run" },
  { name: "resume", description: "Resume interrupted work" },
  { name: "export", description: "Export conversation JSON" },
  { name: "search", description: "Find in conversation" },
] as const;

export type CompletionToken = {
  kind: "path" | "command";
  query: string;
  start: number;
  end: number;
};
export type Completion = { label: string; description?: string; value: string };

export function completionToken(text: string, caret: number): CompletionToken | undefined {
  const before = text.slice(0, caret);
  if (/^\/[a-z-]*$/i.test(before)) {
    const rest = text.slice(caret).match(/^[a-z-]*/i)![0];
    return { kind: "command", query: before.slice(1), start: 0, end: caret + rest.length };
  }
  const match = /(?:^|\s)@("(?:\\.|[^"\\])*|[^\s"@]*)$/.exec(before);
  if (!match) return;
  const raw = match[1];
  let query = raw;
  let rest: string;
  if (raw.startsWith('"')) {
    try {
      query = JSON.parse(`${raw}"`) as string;
    } catch {
      return;
    }
    rest = text.slice(caret).match(/^(?:\\.|[^"\\])*(?:"|\\?$)/)![0];
  } else rest = text.slice(caret).match(/^[^\s"]*/)![0];
  return { kind: "path", query, start: caret - raw.length - 1, end: caret + rest.length };
}

export function pathCompletion(path: string): Completion {
  const quoted = /[\s"@\\]/.test(path);
  const directory = path.endsWith("/");
  const encoded = quoted ? JSON.stringify(path) : path;
  return {
    label: `@${path}`,
    value: `@${directory && quoted ? encoded.slice(0, -1) : encoded}${directory ? "" : " "}`,
  };
}

export function commandCompletions(query: string): Completion[] {
  return commands
    .filter((command) => command.name.startsWith(query.toLowerCase()))
    .map((command) => ({
      label: `/${command.name}`,
      description: command.description,
      value: `/${command.name} `,
    }));
}

/** Keeps focus in the editor, so selection works with keyboards and touch keyboards alike. */
export function installCompletions(
  input: HTMLTextAreaElement,
  popup: HTMLElement,
  scope: () => string | undefined,
  loadPaths: (query: string) => Promise<string[]>,
): { close(): void } {
  let revision = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let token: CompletionToken | undefined;
  let items: Completion[] = [];
  let selected = 0;
  let composing = false;
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", popup.id);
  input.setAttribute("aria-haspopup", "listbox");

  function close() {
    revision++;
    clearTimeout(timer);
    token = undefined;
    items = [];
    popup.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }
  function highlight() {
    Array.from(popup.children).forEach((node, index) =>
      node.setAttribute("aria-selected", String(index === selected)),
    );
    const option = popup.children[selected];
    if (option) {
      input.setAttribute("aria-activedescendant", option.id);
      option.scrollIntoView({ block: "nearest" });
    }
  }
  function choose(index: number) {
    const item = items[index];
    if (!token || !item) return;
    if (
      input.selectionStart !== input.selectionEnd ||
      JSON.stringify(completionToken(input.value, input.selectionStart)) !== JSON.stringify(token)
    ) {
      update();
      return;
    }
    if (
      input.value.length - (token.end - token.start) + item.value.length > input.maxLength &&
      input.maxLength >= 0
    )
      return;
    input.setRangeText(item.value, token.start, token.end, "end");
    close();
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  function render(message?: string) {
    popup.replaceChildren();
    selected = 0;
    for (const [index, item] of items.entries()) {
      const option = document.createElement("button");
      option.type = "button";
      option.tabIndex = -1;
      option.id = `${popup.id}-${index}`;
      option.setAttribute("role", "option");
      const label = document.createElement("strong");
      label.textContent = item.label;
      option.append(label);
      if (item.description) {
        const detail = document.createElement("small");
        detail.textContent = item.description;
        option.append(detail);
      }
      option.onpointerdown = (event) => event.preventDefault();
      option.onclick = () => choose(index);
      popup.append(option);
    }
    if (!items.length) {
      const status = document.createElement("div");
      status.setAttribute("role", "status");
      status.textContent = message ?? "No matches";
      popup.append(status);
    }
    popup.hidden = false;
    input.setAttribute("aria-expanded", "true");
    if (items.length) highlight();
  }
  function update() {
    close();
    const currentScope = scope();
    if (
      !currentScope ||
      composing ||
      document.activeElement !== input ||
      input.selectionStart !== input.selectionEnd
    )
      return;
    token = completionToken(input.value, input.selectionStart);
    if (!token) return;
    if (token.kind === "command") {
      items = commandCompletions(token.query);
      render();
      return;
    }
    const query = token.query;
    const current = revision;
    const value = input.value;
    const caret = input.selectionStart;
    const valid = () =>
      current === revision &&
      scope() === currentScope &&
      input.value === value &&
      input.selectionStart === caret &&
      input.selectionEnd === caret &&
      document.activeElement === input;
    timer = setTimeout(() => {
      void loadPaths(query)
        .then((paths) => {
          if (!valid()) return;
          items = paths.map(pathCompletion);
          render();
        })
        .catch(() => {
          if (valid()) render("Path completion unavailable");
        });
    }, 100);
  }
  input.addEventListener("input", update);
  input.addEventListener("click", update);
  input.addEventListener("focus", update);
  input.addEventListener("blur", close);
  input.addEventListener("compositionstart", () => {
    composing = true;
    close();
  });
  input.addEventListener("compositionend", () => {
    composing = false;
    update();
  });
  input.addEventListener("keyup", (event) => {
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) update();
  });
  input.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.isComposing || composing) return;
    if (event.key === "Escape" && token) {
      event.preventDefault();
      close();
      return;
    }
    if (popup.hidden || event.altKey || event.metaKey || event.shiftKey) return;
    const direction = event.ctrlKey
      ? ({ j: 1, k: -1 }[event.key.toLowerCase()] ?? 0)
      : ({ ArrowDown: 1, ArrowUp: -1 }[event.key] ?? 0);
    if (direction && items.length) {
      event.preventDefault();
      selected = (selected + direction + items.length) % items.length;
      highlight();
    } else if (!event.ctrlKey && ["Enter", "Tab"].includes(event.key) && items.length) {
      event.preventDefault();
      choose(selected);
    }
  });
  close();
  return { close };
}
