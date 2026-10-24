import { installSelectKeyMappings, navigationDirection, moveFocus } from "./key-mappings.ts";
import { composer, controls } from "./dom.ts";
import {
  closeCompletions,
  completionItems,
  selectCompletion,
  applyCompletion,
  completionIndex,
} from "./completions.ts";
import { search } from "./search.ts";

export function installKeys() {
  installSelectKeyMappings(document);
  document.addEventListener("keydown", (event) => {
    if (event.isComposing || event.defaultPrevented) return;
    const form = composer();
    const text = form && controls(form).text;
    if (event.target === text && completionItems().length) {
      const direction = navigationDirection(event);
      if (direction || ["ArrowDown", "ArrowUp"].includes(event.key)) {
        event.preventDefault();
        selectCompletion(completionIndex + (direction || (event.key === "ArrowDown" ? 1 : -1)));
        return;
      }
      if (["Enter", "Tab"].includes(event.key)) {
        event.preventDefault();
        applyCompletion(completionItems()[completionIndex]);
        return;
      }
    }
    if (event.key === "Escape") {
      if (closeCompletions()) {
        event.preventDefault();
        return;
      }
      const popovers = document.querySelectorAll<HTMLElement>(":popover-open");
      if (popovers.length) {
        popovers.forEach((node) => node.hidePopover());
        event.preventDefault();
        return;
      }
      if (event.target instanceof HTMLElement && event.target.closest("#app-footer .compose-box")) {
        event.preventDefault();
        event.target.blur();
        return;
      }
      const bar = document.querySelector<HTMLElement>("#search-bar");
      if (bar && !bar.hidden) {
        bar.hidden = true;
        search();
        event.preventDefault();
      } else document.querySelector<HTMLAnchorElement>("[data-return]")?.click();
      return;
    }
    if (
      (event.ctrlKey || event.metaKey) &&
      !event.shiftKey &&
      event.key === "f" &&
      document.querySelector("#search-bar")
    ) {
      event.preventDefault();
      document.querySelector<HTMLButtonElement>("[data-search-toggle]")?.click();
      return;
    }
    const direction = navigationDirection(event);
    if (
      event.target instanceof HTMLInputElement &&
      event.target.id === "search" &&
      (direction || event.key === "Enter")
    ) {
      event.preventDefault();
      search(direction || (event.shiftKey ? -1 : 1));
      return;
    }
    const list = Array.from(
      document.querySelectorAll<HTMLElement>("#session-list a, #branches a"),
    ).filter((node) => node.checkVisibility() && node.getAttribute("aria-disabled") !== "true");
    if (direction && list.length && !(event.target instanceof HTMLSelectElement)) {
      event.preventDefault();
      moveFocus(list, direction);
      return;
    }
    if (event.target === text && event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      const submitter = document.querySelector<HTMLButtonElement>(
        event.altKey
          ? "button[form=composer][value=followUp]"
          : "#send, #composer button[type=submit]:not([hidden]), #composer button:not([type]):not([hidden])",
      );
      if (submitter && !submitter.disabled) form?.requestSubmit(submitter);
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "k" && !event.shiftKey) {
      event.preventDefault();
      document.querySelector<HTMLAnchorElement>('[data-command="sessions"]')?.click();
      return;
    }
    if (
      event.target instanceof Element &&
      event.target.closest("input, textarea, select, [contenteditable]")
    )
      return;
    if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
    const id = { t: "targets", m: "models", n: "create", "/": "session-filter" }[event.key];
    const control = id && document.getElementById(id);
    if (control && !control.matches(":disabled")) {
      event.preventDefault();
      const options = control.closest("details");
      if (options) options.open = true;
      control.focus();
      if (control instanceof HTMLSelectElement) {
        try {
          control.showPicker?.();
        } catch {
          /* Unsupported platform or activation. */
        }
      }
      if (control instanceof HTMLButtonElement) control.click();
    }
  });
}
