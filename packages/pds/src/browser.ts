// Presentation only. Conversation state and rendering stay on the server.

// Datastar 1.0.5's fetch event contract; the pinned bundle has no TypeScript declarations.
declare global {
  interface DocumentEventMap {
    "datastar-fetch": CustomEvent<{
      type: string;
      el: Element;
      argsRaw: Record<string, string>;
    }>;
  }
}

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
  const { type, el } = event.detail;
  if (el === stream && ["error", "retrying", "retries-failed", "finished"].includes(type)) {
    const connection = document.getElementById("connection")!;
    connection.classList.remove("sr-only");
    connection.textContent =
      type === "retries-failed"
        ? "Disconnected. Reload to reconnect."
        : "Disconnected. Reconnecting…";
  } else if (
    el !== stream &&
    el.id !== "composer" &&
    el.id !== "recover-admission" &&
    (type === "error" || type === "retries-failed")
  ) {
    document.getElementById("notice")!.textContent =
      document.getElementById("page")?.dataset.view === "login"
        ? "Request failed. Reload login status before trying again."
        : "Request failed. Your draft has been kept; check the conversation before resending.";
  }
});
// Only transient form identity lives here. Receipts and execution state stay native.
const composer = document.querySelector<HTMLFormElement>("#composer");
if (composer) {
  const identity = composer.querySelector<HTMLInputElement>('[name="requestId"]')!;
  const recovery = document.getElementById("recovery")!;
  const lookup = document.querySelector<HTMLAnchorElement>("#recover-admission")!;
  const fields = composer.querySelector<HTMLFieldSetElement>("fieldset")!;
  let pending: { requestId: string; scope: string } | undefined;
  let attempted = false;
  const newIdentity = () => {
    identity.value = crypto.randomUUID();
  };
  composer.addEventListener(
    "submit",
    (event) => {
      if (pending) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      pending = { requestId: identity.value, scope: composer.dataset.scope! };
      attempted = true;
      recovery.hidden = true;
      const notice = document.getElementById("notice")!;
      for (const attribute of ["data-invalid-request", "data-issue", "data-field"])
        notice.removeAttribute(attribute);
      notice.replaceChildren();
    },
    true,
  );
  composer.addEventListener("formdata", (event) => {
    if (!pending) return;
    // Retain the serialized key, including FormData's Unicode scalar conversion.
    const requestId = event.formData.get("requestId");
    if (typeof requestId !== "string") throw new Error("The composer requires a text request ID.");
    pending.requestId = requestId;
    lookup.href = `${pending.scope}/submissionByRequest?${new URLSearchParams({ requestId })}`;
    // The entry list is complete. Disabling fields before this event would omit them.
    fields.disabled = true;
  });
  for (const name of ["input", "change"])
    composer.addEventListener(name, (event) => {
      if (attempted && !pending) {
        if (event.target !== identity) newIdentity();
        attempted = false;
      }
    });
  composer.addEventListener("reset", () => {
    pending = undefined;
    attempted = false;
    recovery.hidden = true;
    fields.disabled = false;
    queueMicrotask(newIdentity);
  });
  document.getElementById("edit-draft")!.addEventListener("click", () => {
    pending = undefined;
    attempted = false;
    recovery.hidden = true;
    newIdentity();
    fields.disabled = false;
  });
  document.addEventListener("datastar-fetch", (event) => {
    const { el, type, argsRaw } = event.detail;
    if (!pending || (el !== composer && el !== lookup)) return;
    const status = argsRaw.status;
    if (
      el === composer &&
      type === "error" &&
      ["400", "403", "404", "405", "409", "413", "415"].includes(status ?? "")
    ) {
      pending = undefined;
      fields.disabled = false;
      document.getElementById("notice")!.textContent =
        `Request rejected (${status}). Your draft and files have been kept.`;
      return;
    }
    if (type !== "datastar-patch-elements" && type !== "finished") return;
    if (
      el === composer &&
      document.getElementById("notice")?.dataset.invalidRequest ===
        encodeURIComponent(pending.requestId)
    ) {
      pending = undefined;
      fields.disabled = false;
      return;
    }
    // The pinned Datastar watcher applies its patch before this listener runs.
    const receipt = document.getElementById("admission")!;
    if (
      receipt.dataset.scope === pending.scope &&
      receipt.dataset.requestId === encodeURIComponent(pending.requestId) &&
      receipt.dataset.type === "input" &&
      receipt.dataset.submissionId !== undefined &&
      (receipt.dataset.result === "admitted" || receipt.dataset.result === "present")
    ) {
      const destination = composer.dataset.home ? pending.scope : undefined;
      composer.reset();
      if (destination) window.location.assign(destination);
      return;
    }
    if (el === composer && type === "finished") {
      fields.disabled = true;
      recovery.hidden = false;
      // Read after an uncertain response; never replay the write.
      lookup.click();
    }
  });
}

document.addEventListener("click", (event) => {
  const button =
    event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("#notice [data-select-model]")
      : null;
  if (!button) return;
  const model = document.querySelector<HTMLSelectElement>("#model");
  if (!model || model.matches(":disabled")) return;
  const value = button.dataset.selectModel!;
  const choice =
    Array.from(model.options).find((item) => item.value === value) ??
    new Option(button.textContent ?? value, value);
  choice.dataset.thinking = button.dataset.thinking!;
  if (!choice.parentElement) model.add(choice);
  model.value = value;
  model.dispatchEvent(new Event("change", { bubbles: true }));
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
        attachments.dispatchEvent(new Event("change", { bubbles: true }));
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
    attachments.dispatchEvent(new Event("change", { bubbles: true }));
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

// Submit a compatible thinking value only when the user's model change requires one.
document.addEventListener(
  "change",
  (event) => {
    const select = event.target;
    if (
      !(select instanceof HTMLSelectElement) ||
      select.id !== "model" ||
      select.form?.id !== "configuration-model"
    )
      return;
    select.form.querySelector('input[name="thinking"]')?.remove();
    const current = document.querySelector<HTMLSelectElement>("#thinking")?.value;
    const levels = select.selectedOptions[0]?.dataset.thinking?.split(" ");
    if (levels?.length && current && !levels.includes(current)) {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = "thinking";
      input.value = levels[0]!;
      select.form.append(input);
    }
  },
  true,
);
