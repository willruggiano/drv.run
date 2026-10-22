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
  const button = document.querySelector<HTMLButtonElement>("#send");
  if (form && button) {
    const { text, files } = controls(form);
    button.disabled = text.readOnly || (!text.value.trim() && !files.files?.length);
  }
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
