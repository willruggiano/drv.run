let searchIndex = 0;
export function search(step = 0) {
  const input = document.querySelector<HTMLInputElement>("#search");
  if (!input) return;
  const value = document.querySelector<HTMLElement>("#search-bar")?.hidden
    ? ""
    : input.value.trim().toLocaleLowerCase();
  const nodes = Array.from(document.querySelectorAll<HTMLElement>("#transcript article"));
  const matches = nodes.filter((node) => {
    // Exclude nested archives and hidden copy-source controls from this entry's text.
    const own = Array.from(
      node.querySelectorAll<HTMLElement>(".text, pre, .thinking, .tool-command"),
    )
      .filter((part) => part.closest("article") === node)
      .map((part) => part.textContent)
      .join("\n");
    const matched = !!value && own.toLocaleLowerCase().includes(value);
    node.classList.toggle("search-hit", matched);
    node.classList.remove("search-current");
    return matched;
  });
  searchIndex = matches.length ? (searchIndex + step + matches.length) % matches.length : 0;
  const node = matches[searchIndex];
  if (node) {
    for (let parent = node.parentElement; parent; parent = parent.parentElement)
      if (parent instanceof HTMLDetailsElement) parent.open = true;
    for (const details of node.querySelectorAll("details"))
      if (details.textContent?.toLocaleLowerCase().includes(value)) details.open = true;
    node.classList.add("search-current");
    node.scrollIntoView({ block: "center" });
  }
  if (typeof Highlight !== "undefined" && CSS.highlights) {
    const highlight = new Highlight();
    if (value)
      for (const article of matches) {
        const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
        for (
          let node = walker.nextNode();
          node && highlight.size < 2000;
          node = walker.nextNode()
        ) {
          if (
            node.parentElement?.closest("header, button, textarea, .entry-actions") ||
            node.parentElement?.closest("article") !== article
          )
            continue;
          const text = (node.textContent ?? "").toLocaleLowerCase();
          for (
            let at = text.indexOf(value);
            at >= 0 && highlight.size < 2000;
            at = text.indexOf(value, at + value.length)
          ) {
            const range = document.createRange();
            range.setStart(node, at);
            range.setEnd(node, at + value.length);
            highlight.add(range);
          }
        }
      }
    CSS.highlights.set("pi-search", highlight);
  }
  const count = document.querySelector("#search-count");
  if (count) count.textContent = matches.length ? `${searchIndex + 1}/${matches.length}` : "0/0";
}

export function installSearch() {
  document.addEventListener("input", (event) => {
    if (event.target instanceof HTMLInputElement && event.target.id === "search") {
      searchIndex = 0;
      search();
    }
  });
  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLButtonElement>("button");
    if (button?.hasAttribute("data-search-toggle")) {
      const bar = document.querySelector<HTMLElement>("#search-bar");
      if (bar) {
        bar.hidden = !bar.hidden;
        for (const popup of document.querySelectorAll<HTMLElement>("nav:popover-open"))
          popup.hidePopover();
        if (!bar.hidden) bar.querySelector("input")?.focus();
      }
    }
    if (button?.dataset.searchStep) search(Number(button.dataset.searchStep));
  });
}
