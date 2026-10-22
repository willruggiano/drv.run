import { composer, controls, report } from "./hypermedia-dom.ts";
function actionOwner(target: EventTarget | null): HTMLElement | null {
  if (
    !(target instanceof Element) ||
    target.closest("a, button, input, textarea, select, pre, code, img, [contenteditable]") ||
    getSelection()?.toString()
  )
    return null;
  return target.closest<HTMLElement>("#transcript .tool-call, #transcript article");
}
let activeActions:
  | { owner: HTMLElement; menu: HTMLElement; parent: HTMLDetailsElement }
  | undefined;
export function closeActions() {
  const active = activeActions;
  if (!active) return false;
  activeActions = undefined;
  if (active.menu.matches(":popover-open")) active.menu.hidePopover();
  active.menu.removeAttribute("popover");
  active.parent.open = false;
  if (active.parent.isConnected) active.parent.append(active.menu);
  else active.menu.remove();
  return true;
}
function revealActions(owner: HTMLElement, point?: { x: number; y: number }) {
  if (!owner.isConnected) return;
  closeActions();
  const parent = owner.querySelector<HTMLDetailsElement>(":scope > .entry-actions");
  const menu = parent?.querySelector<HTMLElement>(".action-menu");
  if (!parent || !menu) return;
  const rect = (
    owner.querySelector(":scope > summary, :scope > header") ?? owner
  ).getBoundingClientRect();
  activeActions = { owner, menu, parent };
  parent.open = true;
  menu.setAttribute("popover", "manual");
  document.querySelector("#page")!.append(menu);
  menu.ontoggle = () => {
    if (!menu.matches(":popover-open") && activeActions?.menu === menu) closeActions();
  };
  menu.showPopover();
  if (!point && matchMedia("(hover: none), (pointer: coarse)").matches)
    point = { x: rect.left + 16, y: rect.top + 16 };
  const trigger = parent.querySelector("summary")!.getBoundingClientRect();
  if (!point) {
    menu.style.left = `${Math.max(8, Math.min(innerWidth - menu.offsetWidth - 8, trigger.right - menu.offsetWidth))}px`;
    menu.style.top = `${Math.max(8, Math.min(innerHeight - menu.offsetHeight - 8, trigger.bottom + 4))}px`;
    return;
  }
  const x = point.x;
  const y = point.y;
  menu.style.left = `${Math.max(8, Math.min(innerWidth - menu.offsetWidth - 8, x + 12))}px`;
  menu.style.top = `${Math.max(8, Math.min(innerHeight - menu.offsetHeight - 8, point && y - menu.offsetHeight - 12 >= 8 ? y - menu.offsetHeight - 12 : y + 12))}px`;
}

let heldOwner: HTMLElement | undefined;
let hold:
  | { pointer: number; x: number; y: number; timer: ReturnType<typeof setTimeout> }
  | undefined;
function cancelHold() {
  clearTimeout(hold?.timer);
  hold = undefined;
}

export function installActions() {
  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    if (heldOwner?.contains(event.target)) {
      heldOwner = undefined;
      event.preventDefault();
      return;
    }
    const trigger = event.target.closest(".entry-actions > summary");
    if (trigger) {
      event.preventDefault();
      const owner = trigger.parentElement?.parentElement;
      if (owner) revealActions(owner);
      return;
    }
    const button = event.target.closest<HTMLButtonElement>("button");
    if (button?.dataset.copy) {
      const container = button.closest(".tool-call, article") ?? activeActions?.owner;
      const source = container?.querySelector<HTMLTextAreaElement>(
        `[data-copy-source="${CSS.escape(button.dataset.copy)}"]`,
      );
      if (source)
        void navigator.clipboard.writeText(source.value).catch((error) => report(String(error)));
    }
    if (button?.hasAttribute("data-quote")) {
      const source = (
        button.closest(".tool-call, article") ?? activeActions?.owner
      )?.querySelector<HTMLTextAreaElement>(
        `[data-copy-source="${CSS.escape(button.dataset.quote || "message")}"]`,
      );
      const form = composer();
      if (source && form) {
        const text = controls(form).text;
        const value = `${text.value}${text.value ? "\n\n" : ""}${source.value
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n")}\n\n`;
        if (value.length > text.maxLength) {
          report("Quote exceeds the message limit.");
          return;
        }
        text.value = value;
        text.focus();
        text.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }
    if (button?.dataset.copy || button?.hasAttribute("data-quote")) closeActions();
    const image = event.target.closest<HTMLImageElement>("img.transcript-image");
    if (image) {
      const dialog = document.createElement("dialog");
      dialog.id = "image-dialog";
      const close = document.createElement("button");
      close.textContent = "Close image";
      close.addEventListener("click", () => dialog.close());
      dialog.append(image.cloneNode(true), close);
      dialog.addEventListener("close", () => dialog.remove());
      document.body.append(dialog);
      dialog.showModal();
    }
  });
  document.addEventListener("pointerdown", (event) => {
    cancelHold();
    heldOwner = undefined;
    if (activeActions && event.target instanceof Node && !activeActions.menu.contains(event.target))
      closeActions();
    if (event.pointerType !== "touch" || !event.isPrimary) return;
    const owner = actionOwner(event.target);
    if (!owner) return;
    hold = {
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      timer: setTimeout(() => {
        const point = hold && { x: hold.x, y: hold.y };
        cancelHold();
        heldOwner = owner;
        revealActions(owner, point);
      }, 500),
    };
  });
  document.addEventListener("pointermove", (event) => {
    if (
      hold &&
      event.pointerId === hold.pointer &&
      Math.hypot(event.clientX - hold.x, event.clientY - hold.y) > 8
    )
      cancelHold();
  });
  for (const name of ["pointerup", "pointercancel"]) document.addEventListener(name, cancelHold);
  document.addEventListener("scroll", cancelHold, { capture: true, passive: true });
  window.addEventListener("blur", cancelHold);
  document.addEventListener("contextmenu", (event) => {
    const owner = actionOwner(event.target);
    if (owner) {
      event.preventDefault();
      cancelHold();
      revealActions(owner);
    }
  });
}
