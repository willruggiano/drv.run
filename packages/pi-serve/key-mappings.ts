// Unmodified mnemonic keys belong to the sessions dialog, never to text entry
// or native select type-ahead. Keep native controls in charge of their own keys.
export function installPickerKeyMappings(picker: HTMLDialogElement): void {
  picker.addEventListener("keydown", (event) => {
    if (
      !picker.open || event.defaultPrevented || event.isComposing || event.repeat ||
      event.ctrlKey || event.metaKey || event.altKey || event.shiftKey ||
      (event.target instanceof Element &&
        event.target.closest("input, textarea, select, [contenteditable]:not([contenteditable=false])"))
    ) return;
    const id = { t: "targets", m: "models", n: "create" }[event.key];
    if (!id) return;
    const control = picker.querySelector<HTMLSelectElement | HTMLButtonElement>(`#${id}`);
    if (!control || control.disabled) return;
    event.preventDefault();
    if (control instanceof HTMLSelectElement) {
      control.focus();
      // Older browsers lack showPicker; focus still permits native keyboard use.
      try { control.showPicker?.(); } catch { /* Unsupported platform or activation. */ }
    } else control.click();
  });
}
