import type { Snapshot } from "../pi-runtime/index.ts";
import type { AskView, AskResponse, ReviewState } from "../pi-runtime/workflows.ts";
import { installCompletions } from "./completions.ts";

type Host = {
  request(action: string, data: unknown): Promise<{ id?: number }>;
  navigate(id: number): void;
  showConversation(): Promise<boolean>;
  report(error: unknown): void;
  scope(): string | undefined;
  newId(): string;
  paths(query: string): Promise<string[]>;
};
function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  return result;
}
function button(text: string, run: () => void): HTMLButtonElement {
  const result = node("button", text);
  result.type = "button";
  result.onclick = run;
  return result;
}
function label(text: string, input: HTMLElement): HTMLLabelElement {
  const result = node("label");
  result.append(node("span", text), input);
  return result;
}

/** Feature DOM stays mounted across SSE frames, so streaming cannot overwrite edits. */
export function workflowPanels(host: Host) {
  const root = node("section");
  root.id = "workflows";
  root.setAttribute("aria-label", "Questions and review");
  let snapshot: Snapshot | undefined;
  let connected = false;
  let identity = "";
  let reviewSignature = "";
  let reviewPanel: HTMLElement | undefined;
  const asks = new Map<number, { signature: string; panel: HTMLElement }>();
  const start = document.getElementById("review-start") as HTMLButtonElement;
  const end = document.getElementById("review-end") as HTMLButtonElement;
  const dialog = node("dialog");
  dialog.id = "review-setup";
  dialog.setAttribute("aria-labelledby", "review-title");
  const heading = node("div");
  heading.className = "dialog-heading";
  const title = node("h2", "Start a review");
  title.id = "review-title";
  heading.append(
    title,
    button("Close", () => dialog.close()),
  );
  const form = node("form");
  const target = node("select");
  target.id = "review-target";
  for (const [value, text] of [
    ["uncommitted", "Uncommitted changes"],
    ["branch", "Compare to branch"],
    ["commit", "Commit"],
    ["paths", "Files and directories"],
  ])
    target.add(new Option(text, value));
  const ref = node("input");
  ref.id = "review-ref";
  ref.maxLength = 300;
  const refField = label("Reference", ref);
  const paths = node("textarea");
  paths.id = "review-paths";
  paths.rows = 3;
  paths.maxLength = 10000;
  const pathField = label("Paths · one per line", paths);
  const instructions = node("textarea");
  instructions.id = "review-instructions";
  instructions.rows = 3;
  instructions.maxLength = 10000;
  const submit = node("button", "Start review");
  submit.id = "review-submit";
  submit.type = "submit";
  const setupError = node("p");
  setupError.className = "workflow-error";
  setupError.setAttribute("role", "alert");
  setupError.hidden = true;
  const targetChanged = () => {
    refField.hidden = target.value !== "branch" && target.value !== "commit";
    pathField.hidden = target.value !== "paths";
    ref.required = !refField.hidden;
    paths.required = !pathField.hidden;
  };
  target.onchange = targetChanged;
  targetChanged();
  form.append(
    label("Target", target),
    refField,
    pathField,
    label("Additional instructions", instructions),
    setupError,
    submit,
  );
  dialog.append(heading, form);
  document.body.append(dialog);
  let starting = false;
  form.onsubmit = (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    const scope = host.scope();
    starting = true;
    controls();
    setupError.hidden = true;
    const selected =
      target.value === "uncommitted"
        ? { kind: target.value }
        : target.value === "paths"
          ? {
              kind: target.value,
              paths: paths.value
                .split("\n")
                .map((path) => path.trim())
                .filter(Boolean),
            }
          : { kind: target.value, ref: ref.value.trim() };
    void host
      .request("review", { target: selected, instructions: instructions.value })
      .then((result) => {
        if (scope !== host.scope()) return;
        if (result.id === undefined) throw new Error("Review start returned no conversation.");
        dialog.close();
        host.navigate(result.id);
      })
      .catch((error: unknown) => {
        if (scope !== host.scope()) return;
        setupError.textContent = error instanceof Error ? error.message : String(error);
        setupError.hidden = false;
      })
      .finally(() => {
        starting = false;
        controls();
      });
  };
  const openReview = async () => {
    if (!(await host.showConversation())) return;
    if (start.disabled)
      throw new Error("Connect to an idle coding conversation before starting a review.");
    setupError.hidden = true;
    dialog.showModal();
    target.focus();
  };
  const endReview = async () => {
    if (!(await host.showConversation())) return;
    if (!snapshot?.workflows?.review) throw new Error("Not a review conversation.");
    reviewPanel?.scrollIntoView({ block: "start" });
    reviewPanel?.querySelector<HTMLButtonElement>("button")?.focus();
  };
  start.onclick = () => void openReview().catch((error: unknown) => host.report(error));
  end.onclick = () => void endReview().catch((error: unknown) => host.report(error));

  function controls() {
    const disabled = !connected || !snapshot || snapshot.session.needsResume;
    const live = snapshot?.view.docs["pi.live"];
    start.disabled = disabled || !!live?.run || !!snapshot?.workflows?.review || starting;
    end.hidden = !snapshot?.workflows?.review;
    end.disabled = !connected;
    submit.disabled = start.disabled;
    for (const fieldset of root.querySelectorAll<HTMLFieldSetElement>("fieldset[data-actionable]"))
      fieldset.disabled =
        disabled || fieldset.dataset.actionable !== "true" || fieldset.dataset.sending === "true";
  }

  function editor(name: string, parent: HTMLElement): HTMLTextAreaElement {
    const input = node("textarea");
    input.rows = 2;
    input.maxLength = 10000;
    input.setAttribute("aria-label", name);
    const popup = node("div");
    popup.className = "workflow-completions";
    popup.id = `completion-${host.newId()}`;
    popup.hidden = true;
    popup.setAttribute("role", "listbox");
    parent.append(label(name, input), popup);
    installCompletions(
      input,
      popup,
      () => host.scope(),
      (query) => host.paths(query),
    );
    return input;
  }

  function answerPreview(
    ask: AskView,
    current: AskResponse["answers"],
    pending: boolean,
  ): HTMLElement {
    const preview = node("div");
    for (const question of ask.request.questions) {
      const answer = current.find((item) => item.id === question.id);
      const selected = question.options
        .filter((option) => answer?.selected.includes(option.value))
        .map((option) => option.label);
      const section = node("section");
      section.append(node("h4", question.label ?? question.prompt));
      section.append(
        node("p", [...selected, answer?.text].filter(Boolean).join(" · ") || "Unanswered"),
      );
      if (answer?.note) section.append(node("p", answer.note));
      for (const note of answer?.optionNotes ?? [])
        section.append(
          node(
            "p",
            `Note on ${question.options.find((option) => option.value === note.value)!.label}: ${note.note}${!pending || answer?.selected.includes(note.value) ? "" : " (sent only with Request elaboration)"}`,
          ),
        );
      preview.append(section);
    }
    return preview;
  }

  function questionPanel(ask: AskView): HTMLElement {
    const panel = node("details");
    panel.className = "workflow-panel ask-panel";
    panel.dataset.askId = String(ask.id);
    panel.open = ask.actionable;
    const summary = node(
      "summary",
      `${ask.request.title ?? "Questions"} · ${ask.response ? (ask.response.action === "cancel" ? "Cancelled" : "Answered") : ask.actionable ? "Waiting for your input" : "Interrupted"}`,
    );
    panel.append(summary);
    if (ask.response || !ask.actionable) {
      if (ask.response && ask.response.action !== "cancel") {
        if (ask.response.action === "elaborate") panel.append(node("p", "Elaboration requested."));
        panel.append(answerPreview(ask, ask.response.answers, false));
      } else
        panel.append(
          node("p", ask.response ? "Question cancelled." : "This question is no longer active."),
        );
      return panel;
    }
    const form = node("form");
    const fields = node("fieldset");
    fields.dataset.actionable = "true";
    const questions = node("div");
    questions.className = "ask-questions";
    const readers: (() => AskResponse["answers"][number])[] = [];
    for (const question of ask.request.questions) {
      const field = node("fieldset");
      field.className = "ask-question";
      field.dataset.question = question.id;
      field.append(node("legend", question.label ?? question.prompt));
      if (question.label) field.append(node("p", question.prompt));
      const options: { value: string; selected: HTMLInputElement; note: HTMLTextAreaElement }[] =
        [];
      for (const option of question.options) {
        const choice = node("div");
        choice.className = "ask-option";
        const input = node("input");
        input.type = question.type === "single" ? "radio" : "checkbox";
        input.name = `${ask.id}-${question.id}`;
        input.value = option.value;
        const caption = node("label");
        caption.className = "choice-label";
        caption.append(input, node("span", option.label));
        if (option.recommended) caption.append(node("small", "Recommended"));
        choice.append(caption);
        if (option.description) choice.append(node("p", option.description));
        if (option.preview) {
          const preview = node("pre", option.preview);
          preview.className = "ask-preview";
          choice.append(preview);
        }
        const notes = node("details");
        notes.append(node("summary", `Note on ${option.label}`));
        const note = editor(`Note on ${option.label}`, notes);
        choice.append(notes);
        field.append(choice);
        options.push({ value: option.value, selected: input, note });
      }
      const custom = editor(`Your answer · ${question.label ?? question.id}`, field);
      const notes = node("details");
      notes.append(node("summary", "Question note"));
      const note = editor(`Question note · ${question.label ?? question.id}`, notes);
      field.append(notes);
      if (question.type === "single") {
        custom.addEventListener("input", () => {
          if (custom.value.trim()) for (const option of options) option.selected.checked = false;
        });
        for (const option of options)
          option.selected.addEventListener("change", () => {
            if (option.selected.checked) custom.value = "";
          });
      }
      readers.push(() => ({
        id: question.id,
        selected: options.filter((item) => item.selected.checked).map((item) => item.value),
        ...(custom.value ? { text: custom.value } : {}),
        ...(note.value ? { note: note.value } : {}),
        optionNotes: options
          .filter((item) => item.note.value)
          .map((item) => ({ value: item.value, note: item.note.value })),
      }));
      questions.append(field);
    }
    const confirmation = node("div");
    confirmation.hidden = true;
    confirmation.className = "answer-confirmation";
    confirmation.append(node("h3", "Review your answers"));
    const answers = () =>
      readers
        .map((read) => read())
        .filter(
          (item) =>
            item.selected.length ||
            item.text?.trim() ||
            item.note?.trim() ||
            item.optionNotes.length,
        );
    const preview = node("div");
    confirmation.append(preview);
    const error = node("p");
    error.className = "workflow-error";
    error.setAttribute("role", "alert");
    error.hidden = true;
    const respond = (action: AskResponse["action"]) => {
      if (fields.disabled) return;
      fields.dataset.sending = "true";
      controls();
      error.hidden = true;
      const response: AskResponse = { action, answers: action === "cancel" ? [] : answers() };
      const scope = host.scope();
      void host
        .request("answer", { id: ask.id, response })
        .catch((reason: unknown) => {
          if (scope !== host.scope()) return;
          error.textContent = `${reason instanceof Error ? reason.message : String(reason)} Refresh to check whether the response was accepted before retrying.`;
          error.hidden = false;
        })
        .finally(() => {
          fields.dataset.sending = "false";
          controls();
        });
    };
    const actions = node("div");
    actions.className = "workflow-actions";
    const review = button("Review answers", () => {
      preview.replaceChildren(answerPreview(ask, answers(), true));
      questions.hidden = true;
      confirmation.hidden = false;
      actions.hidden = true;
    });
    actions.append(
      review,
      button("Cancel question", () => respond("cancel")),
    );
    const confirmActions = node("div");
    confirmActions.className = "workflow-actions";
    confirmActions.append(
      button("Back", () => {
        questions.hidden = false;
        confirmation.hidden = true;
        actions.hidden = false;
      }),
      button("Submit answers", () => respond("submit")),
      button("Request elaboration", () => respond("elaborate")),
    );
    confirmation.append(confirmActions);
    fields.append(questions, confirmation, actions, error);
    form.append(fields);
    form.onsubmit = (event) => {
      event.preventDefault();
    };
    panel.append(form);
    return panel;
  }

  function reviewView(review: ReviewState): HTMLElement {
    const panel = node("section");
    panel.className = "workflow-panel review-panel";
    const targetLabel =
      review.target.kind === "paths"
        ? review.target.paths.join(", ")
        : review.target.kind === "uncommitted"
          ? "Uncommitted changes"
          : `${review.target.kind}: ${review.target.ref}`;
    panel.append(node("h2", "Code review"), node("p", review.report?.scope ?? targetLabel));
    const info = node("p", `Workspace: ${review.cwd} · fresh context · normal tool access`);
    info.className = "workflow-meta";
    panel.append(info);
    const fields = node("fieldset");
    fields.dataset.actionable = "true";
    const chosen: { id: string; input: HTMLInputElement }[] = [];
    if (review.report) {
      panel.append(node("h3", `Verdict: ${review.report.verdict}`));
      if (!review.report.findings.length) panel.append(node("p", "No actionable findings."));
      for (const finding of review.report.findings) {
        const card = node("section");
        card.className = "review-finding";
        const input = node("input");
        input.type = "checkbox";
        input.value = finding.id;
        const select = node("label");
        select.className = "choice-label";
        const priority = node("strong", finding.priority);
        priority.className = "finding-priority";
        priority.dataset.priority = finding.priority;
        select.append(input, priority, node("span", finding.title));
        card.append(
          select,
          node("code", `${finding.file}:${finding.startLine}–${finding.endLine}`),
          node("p", finding.explanation),
        );
        if (finding.suggestion) card.append(node("pre", finding.suggestion));
        fields.append(card);
        chosen.push({ id: finding.id, input });
      }
      const callouts = node("section");
      callouts.className = "review-callouts";
      callouts.append(node("h3", "Human reviewer callouts · non-blocking"));
      for (const callout of review.report.callouts) {
        const paragraph = node("p");
        paragraph.append(node("strong", callout));
        callouts.append(paragraph);
      }
      if (!review.report.callouts.length) callouts.append(node("p", "None."));
      fields.append(callouts);
    } else
      panel.append(node("p", "No report yet. The transcript shows review progress or errors."));
    const error = node("p");
    error.className = "workflow-error";
    error.hidden = true;
    error.setAttribute("role", "alert");
    const finish = (action: "handoff" | "fix") => {
      const scope = host.scope();
      fields.dataset.sending = "true";
      controls();
      error.hidden = true;
      void host
        .request("end-review", {
          action,
          findings:
            action === "fix"
              ? chosen.filter((item) => item.input.checked).map((item) => item.id)
              : [],
          requestId: host.newId(),
        })
        .then((result) => {
          if (scope === host.scope() && result.id !== undefined) host.navigate(result.id);
        })
        .catch((reason: unknown) => {
          if (scope !== host.scope()) return;
          error.textContent = `${reason instanceof Error ? reason.message : String(reason)} Check the origin before retrying an uncertain handoff or fix submission.`;
          error.hidden = false;
        })
        .finally(() => {
          fields.dataset.sending = "false";
          controls();
        });
    };
    const actions = node("div");
    actions.className = "workflow-actions";

    if (review.report) {
      const fix = button("Fix selected findings", () => finish("fix"));
      fix.disabled = true;
      for (const item of chosen)
        item.input.onchange = () => {
          fix.disabled = !chosen.some((item) => item.input.checked);
        };
      actions.append(
        button("Handoff report", () => finish("handoff")),
        fix,
      );
    }
    fields.append(actions, error);
    panel.append(fields);
    const navigation = node("div");
    navigation.className = "workflow-actions";
    navigation.append(button("Return to origin", () => host.navigate(review.origin)));
    panel.append(navigation);
    return panel;
  }

  return {
    root,
    openReview,
    endReview,
    connection(value: boolean) {
      connected = value;
      controls();
    },
    reset() {
      snapshot = undefined;
      identity = "";
      asks.clear();
      reviewSignature = "";
      reviewPanel = undefined;
      root.replaceChildren();
      form.reset();
      targetChanged();
      dialog.close();
      controls();
    },
    render(value: Snapshot) {
      snapshot = value;
      const key = `${value.session.id}/${value.view.conversation.id}`;
      if (key !== identity) {
        asks.clear();
        reviewSignature = "";
        reviewPanel = undefined;
        root.replaceChildren();
        identity = key;
      }
      const ids = new Set<number>();
      for (const ask of value.workflows?.asks ?? []) {
        ids.add(ask.id);
        const signature = JSON.stringify(ask);
        const old = asks.get(ask.id);
        if (old?.signature === signature) continue;
        const panel = questionPanel(ask);
        if (old) old.panel.replaceWith(panel);
        else root.append(panel);
        asks.set(ask.id, { panel, signature });
      }
      for (const [id, old] of asks)
        if (!ids.has(id)) {
          old.panel.remove();
          asks.delete(id);
        }
      const review = value.workflows?.review;
      const signature = JSON.stringify(review) ?? "";
      if (signature !== reviewSignature) {
        reviewPanel?.remove();
        reviewPanel = review ? reviewView(review) : undefined;
        if (reviewPanel) root.append(reviewPanel);
        reviewSignature = signature;
      }
      root.hidden = !root.childElementCount;
      controls();
    },
  };
}
