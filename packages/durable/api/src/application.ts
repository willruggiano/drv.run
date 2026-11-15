import assert from "node:assert/strict";
import { mkdir, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { AgentDoc } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { graphql, type GraphQLArgs } from "graphql";
import { Env, openHarness, SshExecutionEnv } from "durable-harness";
import { createSchema, type ResolverContext } from "../graphql/src/index.ts";
import { watch } from "durable-api/watch";
import type { DeploymentConfiguration } from "./configuration.ts";
import { createInventoryService } from "./inventory.ts";
import { Problem } from "./problem.ts";
import { Sessions } from "./sessions.ts";
import { openPush } from "./push.ts";
import { openAccounts } from "./accounts.ts";
import { createSettingsService } from "./settings.ts";

export async function openApplication(config: DeploymentConfiguration) {
  const models = builtinModels();
  const settings = createSettingsService(config);
  const inventory = createInventoryService(config);
  const environments = new Map<string, SshExecutionEnv>();
  const sessionDirectory = join(config.stateDirectory, "sessions");
  await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
  const schema = createSchema();
  const accounts = await openAccounts({
    directory: dirname(config.stateDirectory),
    origin: config.origin,
    servers: config.oauthServers,
    models,
  });

  const push = await openPush(dirname(config.stateDirectory), config.push).catch(
    async (error: unknown) => {
      await accounts.close();
      throw error;
    },
  );

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
      const configuration = await settings.harness.read(BACKGROUND_CONTEXT);
      const harness = await openHarness(
        storage,
        {
          models,
          parallelApiKeyFile: config.parallelApiKeyFile,
          settings: configuration,
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
      push.attach(harness, externalId);
      return harness;
    } catch (error) {
      await storage.close(BACKGROUND_CONTEXT).catch(() => {});
      throw error;
    }
  });

  const services = { accounts: accounts.service, push: push.service };
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
        return tokens;
      },
      async resolve(_externalId, address) {
        const token = [AgentDoc, Env].find(
          (candidate) =>
            candidate.definition.kind === address.kind &&
            candidate.definition.scope === address.scope.kind &&
            !("family" in candidate.definition),
        );
        return token ? { token } : undefined;
      },
    },
    settings,
    inventory,
    ...services,
  });

  return {
    api: {
      oauthCallback: accounts.callback,
      async graphql(
        request: Pick<GraphQLArgs, "source" | "operationName" | "variableValues">,
        signal: AbortSignal,
      ) {
        return await graphql({
          schema,
          ...request,
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
        await push.close().catch((error: unknown) => failures.push(error));
        try {
          await sessions.close();
        } catch (error) {
          failures.push(error);
        }
        const cleaned = await Promise.allSettled(
          [...environments.values()].map((environment) => environment.cleanup(BACKGROUND_CONTEXT)),
        );
        for (const result of cleaned)
          if (result.status === "rejected") failures.push(result.reason);
        await accounts.close().catch((error: unknown) => failures.push(error));
        if (failures.length) throw new AggregateError(failures, "Application shutdown failed");
      })();
      return closing;
    },
  };
}

type Query = Parameters<typeof watch>[0];

const externalIdPattern = /^[A-Za-z0-9_-]{1,128}$/;

const missing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";
