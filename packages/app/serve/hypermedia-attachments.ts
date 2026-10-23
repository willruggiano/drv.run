import { composer, controls, report, updateSend } from "./hypermedia-dom.ts";
let previewRevision = 0;
export function previews() {
  const revision = ++previewRevision;
  const form = composer();
  if (!form) return;
  const container = form.querySelector("#previews")!;
  container.replaceChildren();
  for (const [index, file] of Array.from(controls(form).files.files ?? []).entries()) {
    if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) continue;
    const image = document.createElement("img");
    image.alt = file.name;
    const reader = new FileReader();
    reader.onload = () => {
      if (
        revision !== previewRevision ||
        !container.isConnected ||
        typeof reader.result !== "string"
      )
        return;
      image.src = reader.result;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.setAttribute("aria-label", `Remove ${file.name}`);
      remove.title = `Remove ${file.name}`;
      remove.addEventListener("click", () => {
        const transfer = new DataTransfer();
        Array.from(controls(form).files.files ?? [])
          .filter((_, i) => i !== index)
          .forEach((file) => transfer.items.add(file));
        controls(form).files.files = transfer.files;
        controls(form).files.dispatchEvent(new Event("input", { bubbles: true }));
        previews();
      });
      remove.append(image);
      container.append(remove);
    };
    reader.readAsDataURL(file);
  }
}
function addFiles(files: File[]) {
  const form = composer();
  if (!form) return;
  const input = controls(form).files;
  const selected = [...Array.from(input.files ?? []), ...files];
  if (
    selected.some((file) => !/^image\/(png|jpeg|gif|webp)$/.test(file.type)) ||
    selected.length > 4 ||
    selected.reduce((n, file) => n + file.size, 0) > 5 * 1024 * 1024
  ) {
    report("Attach up to four raster images, totaling at most 5 MiB.");
    return;
  }
  const transfer = new DataTransfer();
  selected.forEach((file) => transfer.items.add(file));
  input.files = transfer.files;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  previews();
}

export function installAttachments() {
  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
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
  document.addEventListener("change", (event) => {
    if (event.target instanceof HTMLInputElement && event.target.type === "file") {
      previews();
      updateSend();
    }
  });
  document.addEventListener("paste", (event) => {
    if (
      !(event.target instanceof Element) ||
      !event.target.closest("#composer") ||
      !event.clipboardData?.files.length
    )
      return;
    event.preventDefault();
    addFiles(Array.from(event.clipboardData.files));
  });
  document.addEventListener("dragover", (event) => {
    if (composer() && event.dataTransfer?.types.includes("Files")) event.preventDefault();
  });
  document.addEventListener("drop", (event) => {
    if (composer() && event.dataTransfer?.files.length) {
      event.preventDefault();
      addFiles(Array.from(event.dataTransfer.files));
    }
  });
  document.addEventListener("click", (event) => {
    const button =
      event.target instanceof Element &&
      event.target.closest<HTMLButtonElement>("button[data-file-picker]");
    if (button) document.getElementById(button.dataset.filePicker!)?.click();
  });
}
