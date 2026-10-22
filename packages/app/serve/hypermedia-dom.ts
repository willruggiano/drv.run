export function composer(): HTMLFormElement | null {
  return document.querySelector("#composer");
}
export function controls(form: HTMLFormElement) {
  return {
    text: form.querySelector<HTMLTextAreaElement>("textarea")!,
    files: form.querySelector<HTMLInputElement>('input[type="file"]')!,
    request: form.querySelector<HTMLInputElement>('[name="requestId"]')!,
  };
}
export function updateSend() {
  const form = composer();
  if (!form) return;
  const { text, files } = controls(form);
  const pending = form.dataset.submitting === "true";
  for (const button of document.querySelectorAll<HTMLButtonElement>("button[form=composer]"))
    button.disabled = pending || (!text.value.trim() && !files.files?.length);
  const create = form.querySelector<HTMLButtonElement>("#create");
  if (create) create.disabled = pending;
}
export function resizePrompt() {
  const text = composer()?.querySelector<HTMLTextAreaElement>('textarea[name="content"]');
  if (!text) return;
  text.style.height = "auto";
  text.style.height = `${text.scrollHeight}px`;
  updateSend();
}
export function report(message: string) {
  const output = document.querySelector("#request-error");
  if (output) output.textContent = message;
}
