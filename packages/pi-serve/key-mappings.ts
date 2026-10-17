// Shared next/previous bindings. Meta+K remains the macOS open-dialog shortcut.
export function navigationDirection(event: KeyboardEvent): -1 | 0 | 1 {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    !event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.shiftKey
  )
    return 0;
  return event.key.toLowerCase() === "j" ? 1 : event.key.toLowerCase() === "k" ? -1 : 0;
}

export function moveFocus(items: HTMLElement[], direction: -1 | 1): void {
  if (!items.length) return;
  const index = items.findIndex((item) => item === document.activeElement);
  const next =
    index < 0
      ? direction === 1
        ? 0
        : items.length - 1
      : (index + direction + items.length) % items.length;
  items[next].focus();
}

// Native selects retain type-ahead and arrow keys, but share Ctrl+J/K navigation.
export function installSelectKeyMappings(root: Document): void {
  root.addEventListener("keydown", (event) => {
    const direction = navigationDirection(event);
    const select = event.target;
    if (!direction || !(select instanceof HTMLSelectElement) || select.disabled || select.multiple)
      return;
    event.preventDefault();
    const options = Array.from(select.options).filter(
      (option) =>
        !option.disabled &&
        !option.hidden &&
        !(option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled),
    );
    if (!options.length) return;
    const index = options.findIndex((option) => option.index === select.selectedIndex);
    const next =
      index < 0
        ? direction === 1
          ? 0
          : options.length - 1
        : (index + direction + options.length) % options.length;
    if (select.selectedIndex === options[next].index) return;
    select.selectedIndex = options[next].index;
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

// Unmodified mnemonic keys belong to the sessions dialog, never to text entry
// or native select type-ahead. Keep native controls in charge of their own keys.
export function installPickerKeyMappings(picker: HTMLDialogElement): void {
  picker.addEventListener("keydown", (event) => {
    const direction = navigationDirection(event);
    if (picker.open && direction && !(event.target instanceof HTMLSelectElement)) {
      event.preventDefault();
      moveFocus(
        Array.from(
          picker.querySelectorAll<HTMLButtonElement>(
            "#sessions button:not(:disabled):not([hidden])",
          ),
        ),
        direction,
      );
      return;
    }
    if (
      !picker.open ||
      event.defaultPrevented ||
      event.isComposing ||
      event.repeat ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.shiftKey ||
      (event.target instanceof Element &&
        event.target.closest(
          "input, textarea, select, [contenteditable]:not([contenteditable=false])",
        ))
    )
      return;
    const id = { t: "targets", m: "models", n: "create", "/": "session-filter" }[event.key];
    if (!id) return;
    const control = picker.querySelector<HTMLSelectElement | HTMLButtonElement | HTMLInputElement>(
      `#${id}`,
    );
    if (!control || control.disabled) return;
    event.preventDefault();
    if (control instanceof HTMLSelectElement) {
      control.focus();
      // Older browsers lack showPicker; focus still permits native keyboard use.
      try {
        control.showPicker?.();
      } catch {
        /* Unsupported platform or activation. */
      }
    } else if (control instanceof HTMLInputElement) control.focus();
    else control.click();
  });
}
