import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResolverContext } from "durable-api/graphql";
import type { DeploymentConfiguration } from "./configuration.ts";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

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
const revision = (content: string | undefined) =>
  createHash("sha256")
    .update(content ?? "")
    .digest("base64url");

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).every((key) => expected.includes(key));
}

function validSettings(app: "web" | "harness", value: unknown): boolean {
  if (!object(value)) return false;
  if (app === "web")
    return (
      exactKeys(value, Object.keys(defaults.web)) &&
      typeof value.wrapCode === "boolean" &&
      typeof value.bottomAlign === "boolean" &&
      typeof value.hideThinkingBlock === "boolean" &&
      typeof value.showImages === "boolean" &&
      (value.defaultDeliveryMode === "followUp" || value.defaultDeliveryMode === "steer")
    );
  if (
    !exactKeys(value, Object.keys(defaults.harness)) ||
    !["auto", "sse", "websocket", "websocketCached"].includes(String(value.transport)) ||
    !["oneAtATime", "all"].includes(String(value.steeringMode)) ||
    !["oneAtATime", "all"].includes(String(value.followUpMode)) ||
    !object(value.retry) ||
    !object(value.compaction)
  )
    return false;
  const integer = (item: unknown) =>
    Number.isInteger(item) && Number(item) >= 0 && Number(item) <= 2147483647;
  return (
    exactKeys(value.retry, Object.keys(defaults.harness.retry)) &&
    typeof value.retry.enabled === "boolean" &&
    integer(value.retry.maxRetries) &&
    integer(value.retry.baseDelayMs) &&
    integer(value.retry.maxAgentDelayMs) &&
    exactKeys(value.compaction, Object.keys(defaults.harness.compaction)) &&
    typeof value.compaction.enabled === "boolean" &&
    integer(value.compaction.reserveTokens) &&
    integer(value.compaction.keepRecentTokens) &&
    integer(value.compaction.backgroundTokens)
  );
}

function mergeSettings(app: "web" | "harness", value: unknown): unknown {
  if (!object(value)) throw new TypeError(`Invalid ${app} settings file`);
  const input = value;
  if (app === "web") {
    const result = { ...defaults.web, ...input };
    if (!validSettings(app, result)) throw new TypeError("Invalid web settings file");
    return result;
  }
  const retry = input.retry;
  const compaction = input.compaction;
  if (
    (retry !== undefined &&
      (retry === null || typeof retry !== "object" || Array.isArray(retry))) ||
    (compaction !== undefined &&
      (compaction === null || typeof compaction !== "object" || Array.isArray(compaction)))
  )
    throw new TypeError("Invalid harness settings file");
  const result = {
    ...defaults.harness,
    ...input,
    retry: { ...defaults.harness.retry, ...(retry as object | undefined) },
    compaction: { ...defaults.harness.compaction, ...(compaction as object | undefined) },
  };
  if (!validSettings(app, result)) throw new TypeError("Invalid harness settings file");
  return result;
}

export function createSettingsService(
  config: DeploymentConfiguration,
): ResolverContext["settings"] {
  async function read(app: "web" | "harness") {
    const path = join(config.configDirectory, `${app}.json`);
    let content: string | undefined;
    try {
      content = await readFile(path, "utf8");
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const settings =
      content === undefined ? defaults[app] : mergeSettings(app, JSON.parse(content) as unknown);
    return { revision: revision(content), settings };
  }

  async function replace(app: "web" | "harness", expectedRevision: string, settings: unknown) {
    const path = join(config.configDirectory, `${app}.json`);
    const current = await read(app);
    if (current.revision !== expectedRevision) return undefined;
    const next = mergeSettings(app, settings);
    await mkdir(config.configDirectory, { recursive: true, mode: 0o700 });
    const temporary = join(config.configDirectory, `.${app}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(next)}\n`, { mode: 0o600, flag: "wx" });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
    return read(app);
  }

  // One API process owns these files. Serialize replacements and reread the revision
  // inside the queue; a disconnected request does not cancel an admitted write.
  function configuration(app: "web" | "harness") {
    let writes: Promise<void> = Promise.resolve();
    return {
      read: async (_context: Parameters<ResolverContext["settings"]["web"]["read"]>[0]) =>
        read(app),
      replace: (
        expectedRevision: string,
        settings:
          | Parameters<ResolverContext["settings"]["web"]["replace"]>[1]
          | Parameters<ResolverContext["settings"]["harness"]["replace"]>[1],
        context: Parameters<ResolverContext["settings"]["web"]["replace"]>[2],
      ) => {
        context.abortSignal?.throwIfAborted();
        const operation = writes.then(async () => {
          context.abortSignal?.throwIfAborted();
          return replace(app, expectedRevision, settings);
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
    web: configuration("web") as ResolverContext["settings"]["web"],
    harness: configuration("harness") as ResolverContext["settings"]["harness"],
  };
}

export async function readHarnessRuntimeSettings(config: DeploymentConfiguration): Promise<{
  readonly stream: { readonly transport: "auto" | "sse" | "websocket" | "websocket-cached" };
  readonly steeringMode: "one-at-a-time" | "all";
  readonly followUpMode: "one-at-a-time" | "all";
  readonly retry: {
    readonly enabled: boolean;
    readonly maxRetries: number;
    readonly baseDelayMs: number;
    readonly maxAgentDelayMs: number;
  };
  readonly compaction: {
    readonly enabled: boolean;
    readonly reserveTokens: number;
    readonly keepRecentTokens: number;
    readonly backgroundTokens: number;
  };
}> {
  const { settings } = await createSettingsService(config).harness.read(BACKGROUND_CONTEXT);
  const value = settings as {
    readonly transport: string;
    readonly steeringMode: string;
    readonly followUpMode: string;
    readonly retry: {
      readonly enabled: boolean;
      readonly maxRetries: number;
      readonly baseDelayMs: number;
      readonly maxAgentDelayMs: number;
    };
    readonly compaction: {
      readonly enabled: boolean;
      readonly reserveTokens: number;
      readonly keepRecentTokens: number;
      readonly backgroundTokens: number;
    };
  };
  const transports = {
    auto: "auto",
    sse: "sse",
    websocket: "websocket",
    websocketCached: "websocket-cached",
  } as const;
  assert(Object.hasOwn(transports, value.transport));
  return {
    stream: { transport: transports[value.transport as keyof typeof transports] },
    steeringMode: value.steeringMode === "oneAtATime" ? "one-at-a-time" : "all",
    followUpMode: value.followUpMode === "oneAtATime" ? "one-at-a-time" : "all",
    retry: value.retry,
    compaction: value.compaction,
  };
}
