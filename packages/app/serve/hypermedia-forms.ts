import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentState } from "@earendil-works/pi-durable";
import { escapeHTML as e, hidden, icon } from "./hypermedia-render.ts";
import type { Catalog, SessionInfo } from "./sessions.ts";
import { settingFields, thinkingLevels, type GlobalSettings } from "./settings.ts";

export const modelKey = (model: { provider: string; modelId: string }) =>
  JSON.stringify([model.provider, model.modelId]);
export const targetKey = (target: { provider: string; target: string }) =>
  JSON.stringify([target.provider, target.target]);
export function thinking(value: string): ModelThinkingLevel | undefined {
  return thinkingLevels.find((level) => level === value);
}
function option(value: string, label: string, selected: string, disabled = false): string {
  return `<option value="${e(value)}"${value === selected ? " selected" : ""}${disabled ? " disabled" : ""}>${e(label)}</option>`;
}
export function options(catalog: Catalog, values: URLSearchParams, existing?: SessionInfo): string {
  const selectedModel =
    values.get("model") ??
    (existing?.model
      ? modelKey(existing.model)
      : catalog.defaultModel
        ? modelKey(catalog.defaultModel)
        : catalog.models[0]
          ? modelKey(catalog.models[0])
          : "");
  const selectedTarget =
    values.get("target") ??
    (existing?.binding
      ? targetKey(existing.binding)
      : catalog.targets.find((item) => item.available)
        ? targetKey(catalog.targets.find((item) => item.available)!)
        : "");
  const model = catalog.models.find((item) => modelKey(item) === selectedModel);
  const target = catalog.targets.find((item) => targetKey(item) === selectedTarget);
  const level = values.get("thinkingLevel") ?? existing?.thinkingLevel ?? "";
  const directory =
    values.get("baseDirectory") ??
    (existing?.directoryRoot && existing.cwd.startsWith(existing.directoryRoot + "/")
      ? existing.cwd.slice(existing.directoryRoot.length + 1)
      : "");
  const session = !!existing || values.get("presentation") === "session";
  const update =
    'hx-get="/sessions/options" hx-include="#options" hx-target="#options" hx-select="#options" hx-swap="outerHTML" hx-sync="closest form:replace"';
  return `<div id="options">${session ? hidden("presentation", "session") : ""}<label><span>${session ? "Execution environment" : "Environment"}</span><select id="targets" name="target" required ${update}>${!target && selectedTarget ? option(selectedTarget, `${existing?.binding?.target ?? selectedTarget} (unavailable, keep)`, selectedTarget) : ""}${catalog.targets.map((item) => option(targetKey(item), item.label, selectedTarget, !item.available && targetKey(item) !== selectedTarget)).join("")}</select></label><label><span>Model</span><select id="models" name="model" required ${update}>${!model && selectedModel ? option(selectedModel, `${existing?.model?.modelId ?? selectedModel} (unavailable, keep)`, selectedModel) : ""}${catalog.models.map((item) => option(modelKey(item), `${item.provider} / ${item.name}`, selectedModel)).join("")}</select></label><label><span>${session ? "Thinking" : "Thinking level"}</span><select id="thinking" name="thinkingLevel">${option("", `Default (${model?.defaultThinkingLevel ?? "off"})`, level)}${(model?.thinkingLevels ?? thinkingLevels).map((item) => option(item, item, level)).join("")}${level && !model?.thinkingLevels.includes(thinking(level) ?? "off") ? option(level, `${level} (clamped by model)`, level) : ""}</select></label><label${target?.directoryRoot || existing?.directoryRoot ? "" : " hidden"}><span>Base directory</span><input id="base-directory" name="baseDirectory" value="${e(directory)}" maxlength="4096" placeholder="${e(target?.directoryRoot ?? existing?.directoryRoot ?? "/workspace")} (default)" list="directories" data-suggest="/sessions/directories"></label><datalist id="directories"></datalist></div>`;
}
export function sessionForm(
  path: string,
  catalog: Catalog,
  info: SessionInfo,
  agent: Pick<AgentState, "instructions">,
): string {
  return `<h1>Session settings</h1><form id="session-settings" method="post" action="${path}/settings" data-autosave hx-sync="this:queue last"><label><span>Session name</span><input name="name" maxlength="120" value="${e(info.name)}"></label>${options(catalog, new URLSearchParams(), info)}<label><span>Additional instructions</span><textarea name="instructions" rows="3" maxlength="100000">${e(agent.instructions ?? "")}</textarea></label><button>Save settings</button><output class="save-status" role="status"></output></form>`;
}
export function globalForm(
  catalog: Catalog,
  settings: GlobalSettings | undefined,
  modelValue?: string,
  path = "/sessions/settings",
): string {
  const selected = modelValue ?? (settings?.model ? modelKey(settings.model) : "");
  const model = catalog.models.find((item) => modelKey(item) === selected);
  const override =
    (model && settings?.modelThinkingLevels[`${model.provider}/${model.modelId}`]) || "";
  const fields = (group: string) =>
    settingFields
      .filter((field) => field.group === group)
      .map(
        (field) =>
          `<label><span>${e(field.label)}</span>${"readonly" in field ? `<input type="number" value="${e(settings?.values[field.key])}" readonly>` : `<select name="${field.key}">${("choices" in field ? field.choices : ["true", "false"]).map((value) => option(value, value === "true" ? "On" : value === "false" ? "Off" : value, String(settings?.values[field.key]))).join("")}</select>`}</label>`,
      )
      .join("");
  return `<h1>Global settings</h1>${settings ? `<form id="global-settings" method="post" action="${e(path)}" data-autosave hx-sync="this:queue last"><section class="settings-group"><h2>Model / thinking</h2><div id="model-defaults"><label><span>Default model</span><select name="model" hx-get="${e(path)}" hx-target="#model-defaults" hx-select="#model-defaults" hx-include="this" hx-swap="outerHTML">${option("", "Keep configured default", selected)}${catalog.models.map((item) => option(modelKey(item), `${item.provider} / ${item.name}`, selected)).join("")}</select></label><label><span>Thinking override for this model</span><select name="modelThinkingLevel">${option("", "Use global default", override)}${thinkingLevels.map((level) => option(level, level, override)).join("")}</select></label></div>${fields("Model / thinking")}</section>${["Execution", "Compaction", "Retries", "Display"].map((group) => `<section class="settings-group"><h2>${group}</h2>${fields(group)}</section>`).join("")}<button>Save defaults</button><output class="save-status" role="status"></output></form>` : "<p>Shared settings are not configured.</p>"}<label><span>Wrap code</span><select id="wrap-code" data-preference="wrap-code"><option value="false">Off</option><option value="true">On</option></select></label><button id="install" type="button" hidden>Install app</button><button id="update" type="button" hidden>Update app</button>`;
}
export function createForm(
  catalog: Catalog,
  id: string,
  picker = false,
  query = "",
  metadata = "",
): string {
  return `<footer id="app-footer" class="composer-area"><form id="composer" class="new-composer"${picker ? " data-picker" : ""} method="post" action="/sessions" enctype="multipart/form-data" hx-encoding="multipart/form-data" hx-sync="this:drop" data-completions="/sessions/completions">${hidden("id", id)}${hidden("requestId", id)}<details id="new-options"><summary aria-label="New session options" title="New session options">${icon("settings")}<span class="options-close" aria-hidden="true">×</span></summary>${options(catalog, new URLSearchParams())}</details><div class="compose-box"><textarea${picker ? " hidden" : ""} id="prompt" name="content" aria-label="Message" maxlength="100000" rows="2" placeholder="Ask Pi…"></textarea>${picker ? `<textarea id="session-filter" name="q" form="session-filter-form" aria-label="Filter sessions" rows="2" placeholder="Filter sessions…" autocomplete="off" hx-get="/sessions" hx-include="#session-filter-form" hx-trigger="input delay:150ms" hx-target="#session-list" hx-select="#session-list" hx-swap="outerMorph">${e(query)}</textarea>` : ""}<div id="completions" role="listbox" hidden></div><label class="attachment-picker">Images<input id="images" name="images" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple></label><div id="previews" aria-label="Attached images"></div><div class="actions">${picker ? '<button class="native-only" form="session-filter-form">Filter</button>' : ""}<button${picker ? " hidden" : ""} id="input-toggle" class="icon enhanced-only" type="button" data-file-picker="images" aria-label="Upload attachments">+</button><span class="spacer"></span><button id="create" class="icon" aria-label="Create session" title="New session">+</button></div></div><button hidden type="submit" name="command" value="new" data-command="new">New session</button></form>${metadata}</footer>`;
}
