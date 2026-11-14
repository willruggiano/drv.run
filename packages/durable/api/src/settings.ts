import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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

import type { Context } from "@earendil-works/chord/context";

const defaults = {
  web: {
    wrapCode: false,
    bottomAlign: true,
    hideThinkingBlock: false,
    showImages: true,
    defaultDeliveryMode: "followUp",
  },
  harness: {
    transport: "auto",
    steeringMode: "oneAtATime",
    followUpMode: "oneAtATime",
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
// Content identity implements expectedRevision without separate revision metadata.
const revision = (content: string | undefined) =>
  createHash("sha256")
    .update(content ?? "")
    .digest("base64url");

const WebOverrides = Type.Partial(WwwSettingsInput, { additionalProperties: false });
const HarnessOverrides = Type.Partial(
  Type.Object({
    ...HarnessSettingsInput.properties,
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
    retry: { ...defaults.harness.retry, ...value.retry },
    compaction: { ...defaults.harness.compaction, ...value.compaction },
  };
}

export function createSettingsService(config: DeploymentConfiguration): SettingsService {
  function configuration<T>(
    app: "web" | "harness",
    decode: (value: unknown) => T,
  ): Configuration<T> {
    const directory = join(config.configDirectory, app);
    const path = join(directory, "settings.json");
    let writes: Promise<void> = Promise.resolve();

    async function read() {
      let content: string | undefined;
      try {
        content = await readFile(path, "utf8");
      } catch (error) {
        if (!missing(error)) throw error;
      }
      return {
        revision: revision(content),
        settings: decode(content === undefined ? {} : JSON.parse(content)),
      };
    }

    async function replace(expectedRevision: string, settings: T) {
      const current = await read();
      if (current.revision !== expectedRevision) return undefined;
      const next = decode(settings);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = join(directory, `.settings.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, `${JSON.stringify(next)}\n`, { mode: 0o600, flag: "wx" });
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }
      return read();
    }

    return {
      read,
      replace(expectedRevision: string, settings: T, context: Context) {
        context.abortSignal?.throwIfAborted();
        // Serialize saves and compare the file revision inside the queue. Once
        // admitted, a write completes even if its requester disconnects.
        const operation = writes.then(async () => {
          context.abortSignal?.throwIfAborted();
          return replace(expectedRevision, settings);
        });
        writes = operation.then(
          () => undefined,
          () => undefined,
        );
        return operation;
      },
    };
  }

  return {
    web: configuration("web", webSettings),
    harness: configuration("harness", harnessSettings),
  };
}
