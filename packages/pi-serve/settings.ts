import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";

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
// Paths are Pi's settings.json keys, not a second preference store.
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
export type SettingValues = Record<SettingKey, string | number | boolean>;
export type GlobalSettings = {
  values: SettingValues;
  model: ModelRef | null;
  modelThinkingLevels: Record<string, ModelThinkingLevel>;
};
