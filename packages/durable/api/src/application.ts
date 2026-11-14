import assert from "node:assert/strict";
import { mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { AgentDoc } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { graphql } from "graphql";
import { Env, openHarness, SshExecutionEnv } from "durable-harness";
import { createSchema, type ResolverContext } from "durable-api/graphql";
import { watch } from "durable-api/watch";
import type { DeploymentConfiguration } from "./configuration.ts";
import { createInventoryService } from "./inventory.ts";
import { Problem } from "./problem.ts";
import { Sessions } from "./sessions.ts";
import { createSettingsService, readHarnessRuntimeSettings } from "./settings.ts";

type Query = Parameters<typeof watch>[0];
type Payload = {
  readonly query: string;
  readonly operationName?: string | null;
  readonly variables?: Record<string, unknown> | null;
};

const externalIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
const missing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

function noAccounts(namespace: string): ResolverContext["accounts"] {
  const page = (cursor: unknown) =>
    cursor === undefined ? { items: [], next: null } : { invalidCursor: true as const };
  return {
    namespace,
    async servers(_limit, cursor) {
      return page(cursor);
    },
    async accounts(_serverId, _limit, cursor) {
      return page(cursor);
    },
    async authorizations(_serverId, _limit, cursor) {
      return page(cursor);
    },
    async server() {
      return undefined;
    },
    async account() {
      return undefined;
    },
    async authorization() {
      return undefined;
    },
    async authorize() {
      return { error: "NOT_FOUND" as const };
    },
    async deviceAuthorization() {
      return { error: "NOT_FOUND" as const };
    },
    async cancelAuthorization() {
      return { error: "NOT_FOUND" as const };
    },
    async disconnect() {
      return { error: "NOT_FOUND" as const };
    },
    async revoke() {
      return { error: "NOT_FOUND" as const };
    },
  };
}

function noPush(): ResolverContext["push"] {
  const unavailable = () => {
    throw new Error("Push subscription persistence is not configured.");
  };
  return {
    async applicationServerKey() {
      return undefined;
    },
    async registered() {
      return unavailable();
    },
    async register() {
      return unavailable();
    },
    async remove() {
      return unavailable();
    },
  };
}

export async function openApplication(config: DeploymentConfiguration) {
  const models = builtinModels();
  const settings = createSettingsService(config);
  const inventory = createInventoryService(config);
  const environments = new Map<string, SshExecutionEnv>();
  const sessionDirectory = join(config.stateDirectory, "sessions");
  await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });

  const sessions = new Sessions(async (externalId, _context, create) => {
    if (!externalIdPattern.test(externalId)) throw new Problem(400);
    const path = join(sessionDirectory, `${externalId}.sqlite`);
    if (!create) {
      try {
        if (!(await stat(path)).isFile()) return undefined;
      } catch (error) {
        if (missing(error)) return undefined;
        throw error;
      }
    }
    const storage = await openNodeSqliteStorage(path);
    try {
      const runtimeSettings = await readHarnessRuntimeSettings(config);
      return await openHarness(
        storage,
        {
          models,
          settings: runtimeSettings,
          async env(target, context) {
            const selected = await target.read.snapshot(Env, target.conversationId, context);
            const native = selected?.env;
            if (!native) return undefined;
            const { type: _type, ...sshTarget } = native;
            assert(native.type === "ssh");
            const cwd = target.cwd ?? "/workspace";
            const key = JSON.stringify([sshTarget, cwd]);
            let environment = environments.get(key);
            if (!environment) {
              environment = new SshExecutionEnv({ target: sshTarget, cwd });
              environments.set(key, environment);
            }
            return environment;
          },
        },
        BACKGROUND_CONTEXT,
      );
    } catch (error) {
      await storage.close(BACKGROUND_CONTEXT).catch(() => {});
      throw error;
    }
  });

  const schema = createSchema();
  const services = { accounts: noAccounts(inventory.namespace), push: noPush() };
  let closing: Promise<void> | undefined;
  const context = (signal: AbortSignal): ResolverContext => ({
    context: withAbortSignal(signal, BACKGROUND_CONTEXT),
    isValidExternalId: (externalId) => externalIdPattern.test(externalId),
    session: (externalId, create = false) => sessions.get(externalId, create),
    async sessions() {
      const entries = await readdir(sessionDirectory, { withFileTypes: true });
      return entries
        .filter(
          (entry) =>
            entry.isFile() &&
            entry.name.endsWith(".sqlite") &&
            externalIdPattern.test(entry.name.slice(0, -7)),
        )
        .map((entry) => entry.name.slice(0, -7))
        .sort();
    },
    models: () => models,
    documents: {
      async definitions(_externalId, scope) {
        const tokens = [AgentDoc, Env].filter((token) => token.definition.scope === scope.kind);
        return tokens as unknown as Awaited<
          ReturnType<ResolverContext["documents"]["definitions"]>
        >;
      },
      async resolve(_externalId, address) {
        const token = [AgentDoc, Env].find(
          (candidate) =>
            candidate.definition.kind === address.kind &&
            candidate.definition.scope === address.scope.kind &&
            !("family" in candidate.definition),
        );
        return token
          ? ({ token } as unknown as Awaited<ReturnType<ResolverContext["documents"]["resolve"]>>)
          : undefined;
      },
    },
    settings,
    inventory,
    ...services,
  });

  return {
    api: {
      async graphql(payload: unknown, signal: AbortSignal) {
        const request = payload as Payload;
        return await graphql({
          schema,
          source: request.query,
          ...(request.operationName == null ? {} : { operationName: request.operationName }),
          ...(request.variables == null ? {} : { variableValues: request.variables }),
          contextValue: context(signal),
        });
      },
      watch(query: Query, signal: AbortSignal) {
        return watch(query, signal, {
          sessions,
          onEnd() {},
        });
      },
    },
    close() {
      closing ??= (async () => {
        const failures: unknown[] = [];
        try {
          await sessions.close(Promise.resolve());
        } catch (error) {
          failures.push(error);
        }
        const cleaned = await Promise.allSettled(
          [...environments.values()].map((environment) => environment.cleanup(BACKGROUND_CONTEXT)),
        );
        for (const result of cleaned)
          if (result.status === "rejected") failures.push(result.reason);
        if (failures.length) throw new AggregateError(failures, "Application shutdown failed");
      })();
      return closing;
    },
  };
}
