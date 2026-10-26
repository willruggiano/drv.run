import "../tree-view.ts";
import { resizePrompt } from "./dom.ts";
import { installDrafts } from "./drafts.ts";
import { installAttachments } from "./attachments.ts";
import { installCompletions } from "./completions.ts";
import { installSearch } from "./search.ts";
import { installKeys } from "./keys.ts";
import { installSettings } from "./settings.ts";
import { installPwa } from "../pwa.ts";
import { installStream } from "./stream.ts";

installDrafts();
installAttachments();
installCompletions();
installSearch();
installKeys();
installSettings();
installPwa();
installStream();

// Delegate so the control also works after navigation and metadata replacement.
document.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  const button = event.target.closest<HTMLButtonElement>("#footer-collapse");
  if (!button) return;
  const scroll = document.querySelector<HTMLElement>(".scrollport");
  const pinned = scroll && scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 32;
  const expanded = button.getAttribute("aria-expanded") !== "true";
  button.setAttribute("aria-expanded", String(expanded));
  const label = expanded ? "Collapse composer" : "Expand composer";
  button.setAttribute("aria-label", label);
  button.title = label;
  if (expanded) resizePrompt();
  if (pinned) scroll.scrollTop = scroll.scrollHeight;
});
