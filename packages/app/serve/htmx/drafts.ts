import type { HtmxRequestCtx } from "htmx.org";
import { composer, controls, resizePrompt, updateSend, report } from "./dom.ts";
import { previews } from "./attachments.ts";
import { closeCompletions } from "./completions.ts";
type Draft = { text: string; files: File[]; requestId: string; creationId?: string };
const drafts = new Map<string, Draft>();
const requestPages = new WeakMap<HtmxRequestCtx, number>();
let pageRevision = 0;
const destinations = new WeakMap<HTMLFormElement, string>();
function saveDraft() {
  resizePrompt();
  const form = composer();
  if (!form) return;
  const { text, files, request } = controls(form);
  const draft = {
    text: text.value,
    files: Array.from(files.files ?? []),
    requestId: request.value,
    creationId: form.querySelector<HTMLInputElement>('[name="id"]')?.value,
  };
  storeDraft(form.action, draft);
}
function storeDraft(key: string, draft: Draft) {
  drafts.set(key, draft);
  try {
    if (draft.text)
      sessionStorage.setItem(
        `pi.html.draft:${key}`,
        JSON.stringify({
          text: draft.text,
          requestId: draft.requestId,
          creationId: draft.creationId,
        }),
      );
    else sessionStorage.removeItem(`pi.html.draft:${key}`);
  } catch {
    /* Storage can be disabled. In-memory drafts still work. */
  }
}
function deleteDraft(key: string) {
  drafts.delete(key);
  try {
    sessionStorage.removeItem(`pi.html.draft:${key}`);
  } catch {
    /* Storage can be disabled. */
  }
}
export function restoreDraft(form: HTMLFormElement) {
  let draft = drafts.get(form.action);
  if (!draft) {
    try {
      const saved: unknown = JSON.parse(
        sessionStorage.getItem(`pi.html.draft:${form.action}`) ?? "null",
      );
      if (
        saved &&
        typeof saved === "object" &&
        "text" in saved &&
        typeof saved.text === "string" &&
        "requestId" in saved &&
        typeof saved.requestId === "string"
      )
        draft = {
          text: saved.text,
          requestId: saved.requestId,
          files: [],
          creationId:
            "creationId" in saved && typeof saved.creationId === "string"
              ? saved.creationId
              : undefined,
        };
    } catch {
      /* Invalid or disabled draft storage is not authoritative. */
    }
    if (draft) drafts.set(form.action, draft);
  }
  if (draft) {
    const { text, files, request } = controls(form);
    text.value = draft.text;
    request.value = draft.requestId;
    const id = form.querySelector<HTMLInputElement>('[name="id"]');
    if (id && draft.creationId && (draft.text || draft.files.length)) id.value = draft.creationId;
    const transfer = new DataTransfer();
    draft.files.forEach((file) => transfer.items.add(file));
    files.files = transfer.files;
  }
}
// Commands activate the forms and links advertised by this representation.
// No endpoints or workflow response types are known here.
const commandRequests = new WeakMap<Element, { key: string; requestId: string }>();
const commandAcknowledgements = new WeakMap<HtmxRequestCtx, { key: string; requestId: string }>();

export function installDrafts() {
  document.addEventListener("input", (event) => {
    const form = composer();
    if (!form) return;
    const { text, files, request } = controls(form);
    if (event.target !== text && event.target !== files) return;
    request.value = crypto.randomUUID();
    saveDraft();
  });
  document.addEventListener("htmx:before:request", (event) => {
    requestPages.set(event.detail.ctx, pageRevision);
    const activation = commandRequests.get(event.detail.ctx.sourceElement);
    if (activation) {
      commandAcknowledgements.set(event.detail.ctx, activation);
      commandRequests.delete(event.detail.ctx.sourceElement);
    }
    const form = composer();
    if (!form || event.detail.ctx.sourceElement !== form) return;
    // FormData is already collected. Keep editing enabled; acknowledgements
    // clear only the submitted revision, never a newer draft.
    form.dataset.submitting = "true";
    saveDraft();
  });
  document.addEventListener("htmx:after:request", (event) => {
    const { response, sourceElement, text } = event.detail.ctx;
    if (response && response.status >= 400 && sourceElement.isConnected) {
      const fragment = document.createElement("template");
      fragment.innerHTML = text ?? "";
      report(
        fragment.content.querySelector("#request-error")?.textContent ||
          fragment.content.querySelector("p")?.textContent ||
          `Request failed (${response.status}).`,
      );
    }
    const activation = commandAcknowledgements.get(event.detail.ctx);
    if (activation && response && response.status < 400) {
      const draft = drafts.get(activation.key);
      if (draft?.requestId === activation.requestId) deleteDraft(activation.key);
      const form = composer();
      if (form?.action === activation.key && controls(form).request.value === activation.requestId)
        controls(form).text.value = "";
      commandAcknowledgements.delete(event.detail.ctx);
    }
    // A slow response from a page we left must not redirect or replace the new page.
    // HX-Trigger acknowledgements still run in htmx's finally block.
    if (requestPages.get(event.detail.ctx) !== pageRevision) event.preventDefault();
  });
  document.addEventListener("htmx:finally:request", (event) => {
    const { sourceElement, response } = event.detail.ctx;
    if (
      sourceElement instanceof HTMLFormElement &&
      sourceElement.getAttribute("id") === "composer"
    ) {
      delete sourceElement.dataset.submitting;
      updateSend();
    }
    if (!response && !event.detail.ctx.request.signal?.aborted && sourceElement.isConnected) {
      const error = document.querySelector("#request-error");
      if (error)
        error.textContent = "Connection lost. Your draft is retained; retry the same submission.";
    }
  });
  document.addEventListener("submitted", (event) => {
    if (!(event instanceof CustomEvent)) return;
    const { requestId, draftAction } = event.detail as { requestId: string; draftAction?: string };
    // A response from an old page may acknowledge its draft, never the new page's.
    for (const [key, draft] of drafts) if (draft.requestId === requestId) deleteDraft(key);
    const form = composer();
    if (draftAction && form && event.target === form)
      destinations.set(form, new URL(draftAction, location.href).href);
    if (!form || controls(form).request.value !== requestId) return;
    controls(form).text.value = "";
    controls(form).files.value = "";
    controls(form).request.value = crypto.randomUUID();
    const creation = form.querySelector<HTMLInputElement>('[name="id"]');
    if (creation) creation.value = crypto.randomUUID();
    previews();
    resizePrompt();
    const error = document.querySelector("#request-error");
    if (error) error.textContent = "";
  });
  document.addEventListener("htmx:before:swap", (event) => {
    if (
      event.detail.ctx.target === document.querySelector("#page") &&
      event.detail.ctx.swap !== "none"
    ) {
      saveDraft();
      const form = composer();
      const destination = form && destinations.get(form);
      if (form && destination) {
        const draft = drafts.get(form.action);
        if (draft && (draft.text || draft.files.length)) storeDraft(destination, draft);
        deleteDraft(form.action);
        destinations.delete(form);
      }
      pageRevision++;
    }
  });
  window.addEventListener("pagehide", () => {
    saveDraft();
  });

  document.addEventListener(
    "submit",
    (event) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement) || form.getAttribute("id") !== "composer") return;
      const { text, files, request } = controls(form);
      const match = /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(text.value.trim());
      if (!text.value.trimStart().startsWith("/")) return;
      if (match && event.submitter?.dataset.command === match[1]) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const control =
        match &&
        document.querySelector<HTMLElement>(
          `[data-command="${CSS.escape(match[1].toLowerCase())}"]`,
        );
      if (!control) {
        report("Command is not available here.");
        return;
      }
      if (files.files?.length) {
        report("Commands do not accept images.");
        return;
      }
      const argument = control.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        "[data-command-argument]",
      );
      if (match?.[2] && !argument) {
        report("This command does not accept arguments.");
        return;
      }
      if (argument) argument.value = match?.[2] ?? "";
      saveDraft();
      control.querySelectorAll<HTMLInputElement>("[data-command-request]").forEach((input) => {
        input.value = request.value;
      });
      if (!control.hasAttribute("data-command-deferred"))
        commandRequests.set(
          control instanceof HTMLButtonElement && control.form ? control.form : control,
          { key: form.action, requestId: request.value },
        );
      closeCompletions();
      if (control instanceof HTMLFormElement) control.requestSubmit();
      else if (control instanceof HTMLAnchorElement) {
        control.click();
        if (control.hasAttribute("download")) {
          text.value = "";
          saveDraft();
        }
      } else if (control instanceof HTMLButtonElement && control.type === "submit")
        setTimeout(() => control.form?.requestSubmit(control), 0);
      else {
        control.click();
        text.value = "";
        saveDraft();
      }
    },
    true,
  );
}
