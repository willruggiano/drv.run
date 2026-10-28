import type { Context } from "@earendil-works/chord/context";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Conversation, ModelRef } from "@earendil-works/pi-durable";
import {
  resolveBaseDirectory,
  configureSession,
  sessionInfo,
  type Session,
  SessionError,
  type Choices,
  type SessionInfo,
  type Sessions,
} from "./sessions.ts";

export const thinkingLevels: readonly ModelThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

// Only settings with an implemented web/Durable equivalent belong here.
export const settingFields = [
  {
    key: "defaultThinkingLevel",
    label: "Default thinking",
    choices: thinkingLevels,
    group: "Model / thinking",
  },
  {
    key: "transport",
    label: "Transport",
    choices: ["auto", "sse", "websocket", "websocket-cached"],
    group: "Execution",
  },
  {
    key: "defaultDeliveryMode",
    label: "Default delivery mode",
    choices: ["steering", "follow-up"],
    group: "Execution",
  },
  {
    key: "steeringMode",
    label: "Steering delivery",
    choices: ["one-at-a-time", "all"],
    group: "Execution",
  },
  {
    key: "followUpMode",
    label: "Follow-up delivery",
    choices: ["one-at-a-time", "all"],
    group: "Execution",
  },
  {
    key: "compaction.enabled",
    label: "Automatic compaction",
    type: "boolean",
    group: "Compaction",
  },
  {
    key: "compaction.reserveTokens",
    label: "Reserve tokens",
    type: "number",
    readonly: true,
    group: "Compaction",
  },
  {
    key: "compaction.keepRecentTokens",
    label: "Keep recent tokens",
    type: "number",
    readonly: true,
    group: "Compaction",
  },
  { key: "retry.enabled", label: "Retry failed generations", type: "boolean", group: "Retries" },
  {
    key: "retry.maxRetries",
    label: "Maximum retries",
    type: "number",
    readonly: true,
    group: "Retries",
  },
  {
    key: "retry.baseDelayMs",
    label: "Base delay (ms)",
    type: "number",
    readonly: true,
    group: "Retries",
  },
  {
    key: "retry.maxAgentDelayMs",
    label: "Maximum agent delay (ms)",
    type: "number",
    readonly: true,
    group: "Retries",
  },
  { key: "hideThinkingBlock", label: "Hide thinking text", type: "boolean", group: "Display" },
  {
    key: "terminal.showImages",
    label: "Show transcript images",
    type: "boolean",
    group: "Display",
  },
] as const;

export type SettingKey = (typeof settingFields)[number]["key"];
export type SettingValues = {
  [Field in (typeof settingFields)[number] as Field["key"]]: Field extends {
    choices: readonly (infer Choice)[];
  }
    ? Choice
    : Field extends { type: "boolean" }
      ? boolean
      : number;
};
export type GlobalSettings = {
  values: SettingValues;
  model: ModelRef | null;
  modelThinkingLevels: Record<string, ModelThinkingLevel>;
};

export const modelKey = (model: ModelRef) => JSON.stringify([model.provider, model.modelId]);
export const targetKey = (target: { provider: string; target: string }) =>
  JSON.stringify([target.provider, target.target]);

export type Selection = {
  model: string;
  target: string;
  thinkingLevel: string;
  baseDirectory: string;
};

function baseDirectory(current: SessionInfo): string {
  return current.directoryRoot && current.cwd.startsWith(current.directoryRoot + "/")
    ? current.cwd.slice(current.directoryRoot.length + 1)
    : "";
}

/** Creation requires available choices; editing may retain an unavailable selection. */
export function resolveSelection(
  sessions: Sessions,
  choices: Choices,
  values: Selection,
  current?: SessionInfo,
) {
  const target = choices.targets.find(
    (item) => targetKey(item) === values.target && item.available,
  );
  const model = choices.models.find((item) => modelKey(item) === values.model);
  const level = thinkingLevels.find((level) => level === values.thinkingLevel);
  if (values.thinkingLevel && !level) throw new SessionError("invalid", "Invalid thinking level.");
  if (!model && (!current?.model || modelKey(current.model) !== values.model))
    throw new SessionError("unavailable", "Model is unavailable.");
  if (!target && (!current?.binding || targetKey(current.binding) !== values.target))
    throw new SessionError("unavailable", "Target is unavailable.");
  if (!target && current && values.baseDirectory !== baseDirectory(current))
    throw new SessionError("unavailable", "Target is unavailable.");
  if (!current && !target?.directoryRoot && values.baseDirectory)
    throw new SessionError("invalid", "This target does not support base directories.");
  return {
    target,
    model,
    thinkingLevel: model ? sessions.resolveThinking(model, level) : level,
    cwd: target?.directoryRoot
      ? resolveBaseDirectory(target.directoryRoot, values.baseDirectory)
      : (target?.cwd ?? current?.cwd ?? ""),
  };
}

/** Validate the whole selection before admitting one durable settings mutation. */
export async function saveSessionSettings(
  sessions: Sessions,
  session: Session,
  conversation: Conversation,
  values: Selection & { name: string },
  context: Context,
): Promise<void> {
  const choices = await sessions.choices(context);
  const current = await sessionInfo(session, conversation, choices.targets, context);
  const { target, model, thinkingLevel, cwd } = resolveSelection(
    sessions,
    choices,
    values,
    current,
  );
  await configureSession(
    session,
    conversation,
    {
      name: values.name,
      binding: target,
      model: model ? { provider: model.provider, modelId: model.modelId } : undefined,
      thinkingLevel,
      cwd,
    },
    context,
  );
}

/** Shared choice projection for creation and conversation settings. */
export function selectionOptions(choices: Choices, current?: SessionInfo) {
  const model = current
    ? current.model
      ? modelKey(current.model)
      : ""
    : choices.defaultModel
      ? modelKey(choices.defaultModel)
      : choices.models[0]
        ? modelKey(choices.models[0])
        : "";
  const available = choices.targets.find((item) => item.available);
  const target = current
    ? current.binding
      ? targetKey(current.binding)
      : ""
    : available
      ? targetKey(available)
      : "";
  return {
    name: current?.name ?? "",
    model,
    target,
    thinking: current?.thinkingLevel ?? "",
    directory: current ? baseDirectory(current) : "",
    models: [
      ...(!choices.models.some((item) => modelKey(item) === model) && current?.model
        ? [
            {
              key: model,
              label: `${current.model.modelId} (unavailable, keep)`,
              summary: current.model.modelId,
              levels: thinkingLevels,
              default: "off",
            },
          ]
        : []),
      ...choices.models.map((item) => ({
        key: modelKey(item),
        label: `${item.provider} / ${item.name}`,
        summary: item.modelId,
        levels: item.thinkingLevels,
        default: item.defaultThinkingLevel,
      })),
    ],
    targets: [
      ...(!choices.targets.some((item) => targetKey(item) === target) && current?.binding
        ? [
            {
              key: target,
              label: `${current.binding.target} (unavailable, keep)`,
              summary: current.binding.provider === "local" ? "local" : current.binding.target,
              disabled: false,
              root: current.directoryRoot ?? "",
              cwd: current.cwd,
            },
          ]
        : []),
      ...choices.targets.map((item) => ({
        key: targetKey(item),
        label: item.label,
        summary: item.provider === "local" ? "local" : item.target,
        disabled: !item.available && (!current || targetKey(item) !== target),
        root: item.directoryRoot ?? "",
        cwd: item.cwd,
      })),
    ],
  };
}

export async function directoryCompletions(
  sessions: Sessions,
  key: string | null,
  query: string,
  context: Context,
): Promise<string[]> {
  const target = ((await sessions.options.targets?.(context)) ?? []).find(
    (item) => targetKey(item) === key && item.available,
  );
  if (!target) throw new SessionError("unavailable", "Execution target is unavailable.");
  return sessions.completeDirectories(target, query, context);
}
