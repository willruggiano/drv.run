import type { Htmx, HtmxRequestCtx } from "htmx.org";
declare const htmx: Htmx;

import { installPreferences } from "../pwa.ts";

export function installSettings() {
  installPreferences();
  // Serialize autosaves and drain them before following a navigation link.
  const saves = new WeakMap<HTMLFormElement, Promise<boolean>>();
  const refreshedForms = new WeakMap<HtmxRequestCtx, HTMLFormElement>();
  document.addEventListener("htmx:before:request", (event) => {
    const source = event.detail.ctx.sourceElement;
    if (source instanceof HTMLSelectElement) {
      const form = source.closest<HTMLFormElement>("form[data-autosave]");
      if (form) refreshedForms.set(event.detail.ctx, form);
    }
  });
  async function saveForm(form: HTMLFormElement): Promise<boolean> {
    const pending = saves.get(form);
    if (pending) return pending;
    const task = (async () => {
      while (form.dataset.dirty === "true" && form.isConnected) {
        form.dataset.dirty = "false";
        form.dataset.failed = "false";
        const status = form.querySelector(".save-status");
        if (status) status.textContent = "Saving…";
        await htmx.ajax("POST", form.action, { source: form, target: form, swap: "none" });
        if (form.dataset.failed === "true") {
          form.dataset.dirty = "true";
          if (status) status.textContent = "Save failed";
          return false;
        }
        if (status) status.textContent = "Saved";
      }
      return true;
    })();
    saves.set(form, task);
    try {
      return await task;
    } finally {
      saves.delete(form);
    }
  }
  document.addEventListener("input", (event) => {
    if (event.target instanceof Element) {
      const form = event.target.closest<HTMLFormElement>("form[data-autosave]");
      if (form) form.dataset.dirty = "true";
    }
  });
  document.addEventListener("focusout", (event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
      const form = event.target.closest<HTMLFormElement>("form[data-autosave]");
      if (form) void saveForm(form);
    }
  });
  document.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement)) return;
    const form = target.closest<HTMLFormElement>("form[data-autosave]");
    if (form) {
      form.dataset.dirty = "true";
      if (!target.hasAttribute("hx-get")) void saveForm(form);
    }
  });
  document.addEventListener("htmx:finally:request", (event) => {
    const { sourceElement, response } = event.detail.ctx;
    if (sourceElement instanceof HTMLFormElement && sourceElement.hasAttribute("data-autosave"))
      sourceElement.dataset.failed = String(!response || response.status >= 400);
    const refreshed = refreshedForms.get(event.detail.ctx);
    if (refreshed?.isConnected && response && response.status < 400) {
      refreshed.dataset.dirty = "true";
      void saveForm(refreshed);
    }
  });
  const follow = new WeakSet<HTMLAnchorElement>();
  document.addEventListener(
    "click",
    (event) => {
      const link = event.target instanceof Element && event.target.closest("a");
      if (
        !link ||
        follow.has(link) ||
        event.ctrlKey ||
        event.metaKey ||
        link.hasAttribute("download")
      )
        return;
      const form = document.querySelector<HTMLFormElement>("form[data-autosave]");
      if (!form || (form.dataset.dirty !== "true" && !saves.has(form))) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void saveForm(form).then((saved) => {
        if (saved && link.isConnected) {
          follow.add(link);
          link.click();
          follow.delete(link);
        }
      });
    },
    true,
  );
}
