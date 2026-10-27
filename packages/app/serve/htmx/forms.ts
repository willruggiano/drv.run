import { html as h, type SafeHtml } from "../html.ts";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { composerBox, composerShell, footerDot, footerMetadata, hidden, icon } from "./render.ts";
import type { Catalog, SessionInfo } from "../sessions.ts";
import { settingFields, thinkingLevels, type GlobalSettings } from "../settings.ts";

export const modelKey = (model: { provider: string; modelId: string }) =>
  JSON.stringify([model.provider, model.modelId]);
export const targetKey = (target: { provider: string; target: string }) =>
  JSON.stringify([target.provider, target.target]);
export function thinking(value: string): ModelThinkingLevel | undefined {
  return thinkingLevels.find((level) => level === value);
}
function option(value: string, label: string, selected: string, disabled = false): SafeHtml {
  return h`<option value="${value}"${value === selected ? h` selected` : ""}${disabled ? h` disabled` : ""}>${label}</option>`;
}
export function options(
  catalog: Catalog,
  values: URLSearchParams,
  existing?: SessionInfo,
): SafeHtml {
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
  const update = h`hx-get="/htmx/options" hx-include="#options" hx-target="#options" hx-select="#options" hx-swap="outerHTML" hx-sync="#options:replace"`;
  const targetSelect = h`<label><span>Environment</span><select id="targets" name="target" required ${update}>${!target && selectedTarget ? option(selectedTarget, `${existing?.binding?.target ?? selectedTarget} (${session ? "unavailable, keep" : "unavailable"})`, selectedTarget, !session) : ""}${h`${catalog.targets.map((item) => option(targetKey(item), item.label, selectedTarget, !item.available && (!session || targetKey(item) !== selectedTarget)))}`}</select></label>`;
  const modelSelect = h`<label><span>Model</span><select id="models" name="model" required ${update}>${!model && selectedModel ? option(selectedModel, `${existing?.model?.modelId ?? selectedModel} (${session ? "unavailable, keep" : "unavailable"})`, selectedModel, !session) : ""}${h`${catalog.models.map((item) => option(modelKey(item), `${item.provider} / ${item.name}`, selectedModel))}`}</select></label>`;
  const thinkingSelect = h`<label><span>Thinking</span><select id="thinking" name="thinkingLevel">${option("", `Default (${model?.defaultThinkingLevel ?? "off"})`, level)}${h`${(model?.thinkingLevels ?? thinkingLevels).map((item) => option(item, item, level))}`}${level && !model?.thinkingLevels.includes(thinking(level) ?? "off") ? option(level, `${level} (clamped by model)`, level) : ""}</select></label>`;
  const directoryInput = h`<label${target?.directoryRoot || existing?.directoryRoot ? "" : h` hidden`}><span>Base directory</span><input id="base-directory" name="baseDirectory" value="${directory}" maxlength="4096" placeholder="${target?.directoryRoot ?? existing?.directoryRoot ?? "/workspace"} (default)" list="directories" data-suggest hx-get="/htmx/directories" hx-trigger="input changed delay:120ms" hx-include="#targets" hx-target="#directories" hx-select="#directories" hx-swap="outerHTML" hx-sync="this:replace"></label>`;
  const fields = session
    ? h`${hidden("presentation", "session")}${targetSelect}${modelSelect}${thinkingSelect}${directoryInput}`
    : footerMetadata({
        label: "New session settings",
        instance: h`<div id="footer-instance" class="model-summary selector-summary">${targetSelect}${footerDot}${directoryInput}</div>`,
        model: h`<div id="footer-model" class="model-summary selector-summary">${modelSelect}${footerDot}${thinkingSelect}</div>`,
      });
  return h`<div id="options">${fields}<datalist id="directories"></datalist></div>`;
}
export function sessionForm(path: string, catalog: Catalog, info: SessionInfo): SafeHtml {
  return h`<form aria-busy="false" method="post" action="${path}/settings" data-autosave hx-sync="this:queue last"><label><span>Session</span><input name="name" maxlength="120" value="${info.name}" placeholder="Untitled session"></label>${options(catalog, new URLSearchParams(), info)}<button>Save settings</button></form>`;
}
function toggle(key: string, title: string, selected: boolean, preference = false): SafeHtml {
  return h`<div class="setting-row"><span>${title}</span><div class="setting-toggle" role="radiogroup" aria-label="${title}">${h`${[false, true].map((enabled) => h`<label class="toggle-option"><input type="radio" name="${key}" value="${String(enabled)}"${selected === enabled ? h` checked` : ""}${preference ? h` data-preference="${key}"` : ""}><span>${enabled ? "On" : "Off"}</span></label>`)}`}</div></div>`;
}
export function globalForm(
  catalog: Catalog,
  settings: GlobalSettings | undefined,
  modelValue?: string,
  path = "/htmx/settings",
): SafeHtml {
  const selected = modelValue ?? (settings?.model ? modelKey(settings.model) : "");
  const model = catalog.models.find((item) => modelKey(item) === selected);
  const override =
    (model && settings?.modelThinkingLevels[`${model.provider}/${model.modelId}`]) || "";
  const fields = (group: string) =>
    h`${settingFields
      .filter((field) => field.group === group)
      .map((field) =>
        "type" in field && field.type === "boolean"
          ? toggle(field.key, field.label, settings?.values[field.key] === true)
          : h`<label><span>${field.label}</span>${"readonly" in field ? h`<input type="number" value="${settings?.values[field.key]}" readonly>` : h`<select name="${field.key}">${h`${field.choices.map((value) => option(value, value, String(settings?.values[field.key])))}`}</select>`}</label>`,
      )}`;
  const modelDefaults = h`<div id="model-defaults"><label><span>Default model</span><select name="model" hx-get="${path}" hx-target="#model-defaults" hx-select="#model-defaults" hx-include="this" hx-swap="outerHTML">${option("", "Keep configured default", selected)}${h`${catalog.models.map((item) => option(modelKey(item), `${item.provider} / ${item.name}`, selected))}`}</select></label><label><span>Thinking override for this model</span><select name="modelThinkingLevel">${option("", "Use global default", override)}${h`${thinkingLevels.map((level) => option(level, level, override))}`}</select></label></div>`;
  const preferences = h`${toggle("wrap-code", "Wrap code", false, true)}${toggle("bottom-align", "Bottom-align messages", true, true)}<button id="install" type="button" hidden>Install app</button><button id="update" type="button" hidden>Update app</button>`;
  return h`<h1>Global settings</h1>${settings ? h`<form aria-busy="false" method="post" action="${path}" data-autosave hx-sync="this:queue last"><section class="settings-group"><h2>Model / thinking</h2>${modelDefaults}${fields("Model / thinking")}</section>${h`${["Execution", "Compaction", "Retries", "Display"].map((group) => h`<section class="settings-group"><h2>${group}</h2>${fields(group)}</section>`)}`}<button>Save defaults</button></form>` : h`<p>Shared settings are not configured.</p>`}${preferences}`;
}
export function createForm(catalog: Catalog, id: string): SafeHtml {
  return h`<footer id="app-footer" class="composer-area"><form id="composer" class="new-composer" method="post" action="/htmx/" enctype="multipart/form-data" hx-encoding="multipart/form-data" hx-sync="this:drop">${hidden("id", id)}${hidden("requestId", id)}<fieldset id="new-options" aria-label="New session options">${options(catalog, new URLSearchParams())}</fieldset>${composerShell(composerBox(h`<textarea id="prompt" tabindex="1" name="content" aria-label="Message" data-completions hx-get="/htmx/completions" hx-trigger="input changed delay:120ms, compositionend delay:120ms" hx-target="#completions" hx-select="#completions" hx-swap="outerHTML" hx-sync="this:replace" maxlength="100000" rows="2" placeholder="Ask Pi…"></textarea><div id="completions" role="listbox" hidden></div><label class="attachment-picker">Images<input id="images" name="images" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple></label><div id="previews"></div>`, h`<div class="actions"><button id="input-toggle" class="icon enhanced-only" type="button" data-file-picker="images" aria-label="Upload attachments">+</button><span class="spacer"></span><button id="create" class="icon"${!catalog.models.length || !catalog.targets.some((target) => target.available) ? h` disabled` : ""} aria-label="Create session" title="New session">${icon("send")}</button></div>`))}<button hidden type="submit" name="command" value="new" data-command="new">New session</button></form></footer>`;
}
