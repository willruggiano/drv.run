// Presentation only. Conversation state and rendering stay on the server.
const stream = document.getElementById("stream");
const latest = document.querySelector<HTMLButtonElement>("#latest");
if (stream && latest) {
  let following = true;
  let previousTop = stream.scrollTop;
  const follow = () => {
    // A DOM patch can arrive before the scroll event for a user's upward scroll.
    const maximum = stream.scrollHeight - stream.clientHeight;
    if (stream.scrollTop < Math.min(previousTop, maximum) - 1) following = false;
    if (following) stream.scrollTop = stream.scrollHeight;
    previousTop = stream.scrollTop;
    latest.disabled = following;
  };
  stream.addEventListener("scroll", () => {
    if (stream.scrollTop !== previousTop)
      following = stream.scrollHeight - stream.clientHeight - stream.scrollTop < 32;
    previousTop = stream.scrollTop;
    latest.disabled = following;
  });
  new MutationObserver(follow).observe(stream, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  stream.addEventListener("load", follow, true);
  new ResizeObserver(follow).observe(stream);
  latest.addEventListener("click", () => {
    following = true;
    previousTop = stream.scrollTop;
    follow();
  });
}
document.addEventListener("datastar-fetch", (event) => {
  const { type, el } = (event as CustomEvent<{ type: string; el: Element }>).detail;
  if (el === stream && ["error", "retrying", "retries-failed", "finished"].includes(type)) {
    const connection = document.getElementById("connection")!;
    connection.classList.remove("sr-only");
    connection.textContent =
      type === "retries-failed"
        ? "Disconnected. Reload to reconnect."
        : "Disconnected. Reconnecting…";
  } else if (el !== stream && (type === "error" || type === "retries-failed")) {
    document.getElementById("notice")!.textContent =
      document.getElementById("page")?.dataset.view === "login"
        ? "Request failed. Reload login status before trying again."
        : "Request failed. Your draft has been kept; check the conversation before resending.";
  }
});
const attachments = document.querySelector<HTMLInputElement>("#attachments");
const previews = document.getElementById("previews");
if (attachments && previews) {
  const urls: string[] = [];
  const refresh = () => {
    urls.splice(0).forEach((url) => URL.revokeObjectURL(url));
    previews.replaceChildren();
    Array.from(attachments.files!).forEach((file, index) => {
      const template = document.querySelector<HTMLTemplateElement>("#attachment-preview")!;
      const fragment = document.importNode(template.content, true);
      const button = fragment.querySelector("button")!;
      button.title = `Remove ${file.name}`;
      button.setAttribute("aria-label", `Remove ${file.name}`);
      if (["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.type)) {
        const image = button.querySelector("img")!;
        image.hidden = false;
        image.src = URL.createObjectURL(file);
        image.alt = file.name;
        urls.push(image.src);
      } else button.querySelector("span")!.textContent = file.name;
      button.addEventListener("click", () => {
        const transfer = new DataTransfer();
        Array.from(attachments.files!).forEach((item, current) => {
          if (current !== index) transfer.items.add(item);
        });
        attachments.files = transfer.files;
        attachments.dispatchEvent(new Event("change"));
      });
      previews.append(button);
    });
  };
  attachments.addEventListener("change", refresh);
  attachments.form!.addEventListener("reset", () => queueMicrotask(refresh));
  const add = (files: FileList) => {
    if (attachments.matches(":disabled")) return;
    const transfer = new DataTransfer();
    [...attachments.files!, ...files].forEach((file) => transfer.items.add(file));
    attachments.files = transfer.files;
    attachments.dispatchEvent(new Event("change"));
  };
  document
    .querySelector<HTMLElement>(".compose-box")!
    .addEventListener("dragover", (event) => event.preventDefault());
  document.querySelector<HTMLElement>(".compose-box")!.addEventListener("drop", (event) => {
    event.preventDefault();
    add(event.dataTransfer!.files);
  });
  document.getElementById("message")!.addEventListener("paste", (event) => {
    if (event.clipboardData!.files.length) {
      event.preventDefault();
      add(event.clipboardData!.files);
    }
  });
}
