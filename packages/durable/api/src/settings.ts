/*
 * Imports
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Type from "typebox";
import Value from "typebox/value";
import {
  WwwSettingsInput,
  HarnessSettingsInput,
  type Configuration,
  type SettingsService,
} from "../graphql/src/graphql.ts";
import type { DeploymentConfiguration } from "./configuration.ts";

/*
 * Exports: Settings
 */

export function createSettingsService(config: DeploymentConfiguration): SettingsService {
  return {
    web: configuration("web", webSettings),
    harness: configuration("harness", harnessSettings),
  };

  /*
   * Helpers: Settings
   */

  function configuration<T>(
    app: "web" | "harness",
    decode: (value: unknown) => T,
  ): Configuration<T> {
    const directory = join(config.configDirectory, app);
    const path = join(directory, "settings.json");
    return {
      async read() {
        let content: string;
        try {
          content = await readFile(path, "utf8");
        } catch (error) {
          if (missing(error)) return decode({});
          throw error;
        }
        return decode(JSON.parse(content));
      },
      async replace(settings: T) {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(path, `${JSON.stringify(settings)}\n`, { mode: 0o600 });
        return settings;
      },
    };
  }
}

/*
 * Helpers: Settings
 */

const defaults = {
  web: {
    wrapCode: false,
    bottomAlign: true,
    hideThinkingBlock: false,
    showImages: true,
    defaultDeliveryMode: "followUp",
  },
  harness: {
    stream: { transport: "auto" },
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
    retry: { enabled: true, maxRetries: 3, baseDelayMs: 2000, maxAgentDelayMs: 60000 },
    compaction: {
      enabled: true,
      reserveTokens: 16384,
      keepRecentTokens: 20000,
      backgroundTokens: 32768,
    },
  },
} as const;

const missing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

const WebOverrides = Type.Partial(WwwSettingsInput, { additionalProperties: false });

const HarnessOverrides = Type.Partial(
  Type.Object({
    ...HarnessSettingsInput.properties,
    stream: Type.Partial(HarnessSettingsInput.properties.stream, { additionalProperties: false }),
    retry: Type.Partial(HarnessSettingsInput.properties.retry, { additionalProperties: false }),
    compaction: Type.Partial(HarnessSettingsInput.properties.compaction, {
      additionalProperties: false,
    }),
  }),
  { additionalProperties: false },
);

function webSettings(value: unknown): WwwSettingsInput {
  if (!Value.Check(WebOverrides, value)) throw new TypeError("Invalid web settings file");
  return { ...defaults.web, ...value };
}

function harnessSettings(value: unknown): HarnessSettingsInput {
  if (!Value.Check(HarnessOverrides, value)) throw new TypeError("Invalid harness settings file");
  return {
    ...defaults.harness,
    ...value,
    stream: { ...defaults.harness.stream, ...value.stream },
    retry: { ...defaults.harness.retry, ...value.retry },
    compaction: { ...defaults.harness.compaction, ...value.compaction },
  };
}
