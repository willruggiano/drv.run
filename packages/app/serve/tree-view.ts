import type { TreeData, TreeNode } from "./trees.ts";

function decode(source: string): TreeData {
  const value: unknown = JSON.parse(source);
  if (
    !value ||
    typeof value !== "object" ||
    !("kind" in value) ||
    !["branches", "entries"].includes(String(value.kind)) ||
    !("path" in value) ||
    typeof value.path !== "string" ||
    !/^\/sessions\/[^/]+\/conversations\/\d+$/.test(value.path) ||
    !("nodes" in value) ||
    !Array.isArray(value.nodes)
  )
    throw new Error("Invalid tree data");
  const ids = new Set<number>();
  for (const node of value.nodes) {
    if (
      !node ||
      typeof node !== "object" ||
      !Number.isSafeInteger(node.id) ||
      ids.has(node.id) ||
      !(node.parent === null || (Number.isSafeInteger(node.parent) && node.parent < node.id)) ||
      typeof node.text !== "string" ||
      !["user", "assistant", "tool", "event", "branch"].includes(node.role) ||
      !(
        node.state === null ||
        ["pending", "running", "completed", "failed", "cancelled", "unavailable"].includes(
          node.state,
        )
      ) ||
      !(node.timestamp === null || Number.isFinite(node.timestamp)) ||
      typeof node.active !== "boolean" ||
      typeof node.current !== "boolean" ||
      !(
        node.path === null ||
        (typeof node.path === "string" && /^\/sessions\/[^/]+\/conversations\/\d+$/.test(node.path))
      )
    )
      throw new Error("Invalid tree node");
    ids.add(node.id);
  }
  if (value.nodes.some((node) => node.parent !== null && !ids.has(node.parent)))
    throw new Error("Missing tree ancestor");
  return value as TreeData;
}
function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = "") {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

/** Elm owns the value attribute; this element owns its search, selection and DOM. */
class TreeExplorer extends HTMLElement {
  static observedAttributes = ["value"];
  private data?: TreeData;
  private visible: TreeNode[] = [];
  private selected: number | undefined;
  private initialized = false;

  private node<T extends HTMLElement = HTMLElement>(id: string): T {
    const node = this.querySelector<T>(`#${id}`);
    if (!node) throw new Error(`Missing explorer element: ${id}`);
    return node;
  }
  connectedCallback() {
    if (!this.initialized) {
      this.innerHTML = `<main id="main-area"><section id="tree-view" class="pane" aria-label="Tree"><div id="tree-rows"></div><p id="tree-empty" hidden>No matches.</p></section></main><footer id="app-footer" class="composer-area"><div class="composer-shell"><div class="compose-box"><form id="tree-composer"><textarea id="prompt" rows="2" tabindex="1" autocomplete="off" aria-label="Search tree"></textarea></form><div class="actions"><a id="tree-close" class="icon" data-return aria-label="Close tree" title="Close tree"><svg class="glyph" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"></path></svg></a><select id="tree-filter" class="submission-mode" aria-label="Entry filter"><option value="all">All entries</option><option value="no-tools">No tools</option><option value="user-only">User only</option></select><output id="tree-count" aria-live="polite"></output><span class="spacer"></span><button id="tree-prev" class="icon" type="button" aria-label="Previous entry">↑</button><button id="tree-next" class="icon" type="button" aria-label="Next entry">↓</button></div></div></div><a id="tree-sessions" data-command="sessions" hidden></a><p id="tree-error" role="alert" hidden>Tree unavailable. Close and reopen to retry.</p></footer>`;
      this.node("prompt").addEventListener("input", () => this.render());
      this.node("tree-filter").addEventListener("change", () => this.render());
      this.node("tree-prev").onclick = () => this.move(-1);
      this.node("tree-next").onclick = () => this.move(1);
      this.node("tree-composer").onsubmit = (event) => {
        event.preventDefault();
        event.stopPropagation();
      };
      this.addEventListener("keydown", (event) => {
        if (event.isComposing || event.defaultPrevented) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          this.node("tree-close").click();
        } else if (
          !(event.target instanceof HTMLSelectElement) &&
          !event.shiftKey &&
          !event.altKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          ["ArrowDown", "ArrowUp"].includes(event.key)
        ) {
          event.preventDefault();
          event.stopPropagation();
          this.move(event.key === "ArrowDown" ? 1 : -1);
        }
      });
      this.initialized = true;
    }
    this.update();
  }
  attributeChangedCallback() {
    if (this.isConnected && this.initialized) this.update();
  }
  private update() {
    const value = this.getAttribute("value");
    if (!value) return;
    try {
      const data = decode(value);
      const changed = this.data?.path !== data.path || this.data.kind !== data.kind;
      this.data = data;
      this.node("tree-error").hidden = true;
      if (changed) {
        this.node<HTMLTextAreaElement>("prompt").value = "";
        this.node<HTMLSelectElement>("tree-filter").value = "all";
        this.selected = data.nodes.find((node) => node.current)?.id;
      }
      if (this.selected === undefined) this.selected = data.nodes.find((node) => node.current)?.id;
      this.node<HTMLAnchorElement>("tree-sessions").href = "/";
      const branches = data.kind === "branches";
      this.node<HTMLAnchorElement>("tree-close").href = data.path;
      this.node("tree-filter").hidden = branches;
      this.node("tree-view").setAttribute(
        "aria-label",
        branches ? "Conversations" : "Session entries",
      );
      const prompt = this.node<HTMLTextAreaElement>("prompt");
      prompt.placeholder = branches ? "Search conversations…" : "Search session entries…";
      prompt.setAttribute(
        "aria-label",
        branches ? "Search conversations" : "Search session entries",
      );
      this.render();
      if (changed) this.reveal();
    } catch {
      this.node("tree-error").hidden = false;
    }
  }
  private reveal() {
    this.querySelector(`[data-id="${this.selected}"]`)?.scrollIntoView({ block: "nearest" });
  }
  private select(id: number | undefined) {
    this.selected = id;
    const branches = this.data?.kind === "branches";
    for (const row of this.querySelectorAll<HTMLElement>("[data-id]"))
      row.setAttribute(
        branches ? "data-selected" : "aria-pressed",
        String(Number(row.dataset.id) === id),
      );
    const index = this.visible.findIndex((node) => node.id === id);
    this.node<HTMLButtonElement>("tree-prev").disabled = index <= 0;
    this.node<HTMLButtonElement>("tree-next").disabled =
      index < 0 || index === this.visible.length - 1;
    this.node("tree-count").textContent = `${index + 1} / ${this.visible.length}`;
  }
  private move(delta: number) {
    const index = this.visible.findIndex((node) => node.id === this.selected);
    const node = this.visible[Math.max(0, Math.min(this.visible.length - 1, index + delta))];
    if (node) {
      this.select(node.id);
      this.reveal();
    }
  }
  private render() {
    if (!this.data) return;
    const branches = this.data.kind === "branches";
    const tokens = this.node<HTMLTextAreaElement>("prompt")
      .value.toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    const filter = this.node<HTMLSelectElement>("tree-filter").value;
    const source = new Map(this.data.nodes.map((node) => [node.id, node]));
    const matched = this.data.nodes.filter(
      (node) =>
        tokens.every((token) =>
          `${node.role} ${node.text} ${node.state ?? ""}`.toLowerCase().includes(token),
        ) &&
        (branches ||
          filter === "all" ||
          (filter === "user-only" ? node.role === "user" : node.role !== "tool")),
    );
    const ids = new Set(matched.map((node) => node.id));
    const children = new Map<number | null, TreeNode[]>();
    for (const node of matched) {
      let parent = node.parent;
      while (parent !== null && !ids.has(parent)) parent = source.get(parent)!.parent;
      const list = children.get(parent) ?? [];
      list.push(node);
      children.set(parent, list);
    }
    const rows = this.node("tree-rows");
    const focused = this.querySelector<HTMLElement>("[data-id]:focus")?.dataset.id;
    rows.replaceChildren();
    rows.className = branches ? "branch-panel" : "entry-tree";
    this.visible = [];
    const pending: {
      parent: number | null;
      node: TreeNode;
      index: number;
      count: number;
      list: HTMLElement;
      rails: boolean[];
    }[] = [];
    const append = (parent: number | null, container: HTMLElement, rails: boolean[]) => {
      const items = children.get(parent) ?? [];
      if (!items.length) return;
      const list = branches ? element("ul", "") : container;
      if (branches) container.append(list);
      for (let index = items.length - 1; index >= 0; index--)
        pending.push({ parent, node: items[index], index, count: items.length, list, rails });
    };
    append(null, rows, []);
    while (pending.length) {
      const job = pending.pop();
      if (!job) throw new Error("Missing tree traversal job");
      const { parent, node, index, count, list, rails } = job;
      this.visible.push(node);
      const last = index === count - 1;
      let next = list;
      if (branches) {
        const li = element("li", "");
        const row = element("div", "branch-row");
        const link = element("a", "");
        link.href = node.path ?? this.data!.path;
        link.dataset.id = String(node.id);
        link.dataset.parent = String(parent ?? "");
        link.setAttribute("aria-current", String(node.current));
        const glyph = element(
          "span",
          "tool-status",
          {
            completed: "✓",
            pending: "○",
            running: "⠿",
            failed: "×",
            cancelled: "−",
            unavailable: "?",
          }[node.state ?? "unavailable"],
        );
        if (node.state === "running") {
          glyph.textContent = "";
          for (let i = 0; i < 4; i++) glyph.append(element("span", ""));
        }
        glyph.dataset.state = node.state ?? "unavailable";
        glyph.setAttribute("aria-label", node.state ?? "unavailable");
        link.append(
          element("span", "branch-name", node.text),
          glyph,
          element(
            "time",
            "branch-time",
            node.timestamp === null
              ? "—"
              : new Date(node.timestamp).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                }),
          ),
        );
        link.onfocus = () => this.select(node.id);
        row.append(link);
        li.append(row);
        list.append(li);
        next = li;
      } else {
        const row = element("button", "entry-row");
        row.type = "button";
        row.dataset.id = String(node.id);
        row.dataset.parent = String(parent ?? "");
        const prefix = element("span", "entry-prefix");
        prefix.setAttribute("aria-hidden", "true");
        for (const line of rails) {
          const rail = element("span", "tree-rail");
          rail.dataset.line = String(line);
          prefix.append(rail);
        }
        if (count > 1) {
          const rail = element("span", "tree-rail");
          Object.assign(rail.dataset, {
            line: "true",
            connector: "true",
            first: String(index === 0),
            last: String(last),
          });
          prefix.append(rail);
        }
        const marker = element("span", "path-marker", node.active ? "•" : "");
        marker.setAttribute("aria-label", node.active ? "Open conversation history" : "");
        const copy = element("span", `entry-copy role-${node.role}`);
        if (node.role === "user" || node.role === "assistant")
          copy.append(element("span", `role-${node.role}`, `${node.role}: `));
        copy.append(
          element(
            "span",
            node.role === "tool" || node.role === "event" ? "" : "entry-text",
            node.text,
          ),
        );
        row.append(prefix, marker, copy);
        if (node.current) {
          row.setAttribute("aria-current", "true");
          row.append(element("span", "current-tag", "latest"));
        }
        row.title = node.text;
        row.onclick = () => this.select(node.id);
        list.append(row);
      }
      append(node.id, next, count > 1 ? [...rails, !last] : rails);
    }
    this.node("tree-empty").hidden = this.visible.length !== 0;
    if (!ids.has(this.selected ?? -1) && this.visible.length) this.selected = this.visible[0].id;
    this.select(this.selected);
    if (focused)
      this.querySelector<HTMLElement>(`[data-id="${focused}"]`)?.focus({ preventScroll: true });
  }
}
customElements.define("pi-tree", TreeExplorer);
