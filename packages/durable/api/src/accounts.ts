/*
 * Imports
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, open } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import timers from "node:timers/promises";
import {
  BACKGROUND_CONTEXT,
  awaitWithContext,
  withAbortSignal,
  type Context,
} from "@earendil-works/chord/context";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import * as oauth from "oauth4webapi";
import Type from "typebox";
import Value from "typebox/value";
import type {
  AccountsService,
  AccountRecord,
  AuthorizationRecord,
  AuthorizationServerRecord,
} from "../graphql/src/graphql.ts";
import { Problem } from "./problem.ts";

/*
 * Exports: Accounts
 */

type Registration = Type.Static<typeof OAuthServers>[number];

const Text = Type.String({ minLength: 1 });

const Https = Type.String({ pattern: "^https://[^\\s]+$" });

export const OAuthServers = Type.Array(
  Type.Object(
    {
      id: Text,
      label: Text,
      provider: Text,
      metadata: Type.Object(
        {
          issuer: Https,
          authorization_endpoint: Type.Optional(Https),
          token_endpoint: Https,
          device_authorization_endpoint: Type.Optional(Https),
          revocation_endpoint: Type.Optional(Https),
          userinfo_endpoint: Type.Optional(Https),
          grant_types_supported: Type.Array(Text),
        },
        { additionalProperties: false },
      ),
      client_id: Text,
      clientSecretFile: Type.Optional(Text),
      scope: Type.Optional(Text),
    },
    { additionalProperties: false },
  ),
);

export async function openAccounts(options: {
  directory: string;
  origin: string | undefined;
  servers: readonly Registration[];
  models: MutableModels;
}) {
  const servers = new Map<string, Server>();
  for (const registration of options.servers) {
    assert(!servers.has(registration.id), "Duplicate authorization server");
    assert(options.models.getProvider(registration.provider), "Unknown model provider");
    const secret = registration.clientSecretFile
      ? (await readFile(registration.clientSecretFile, "utf8")).trim()
      : undefined;
    if (secret !== undefined) assert(secret, "Empty OAuth client secret");
    servers.set(registration.id, {
      ...registration,
      client: { client_id: registration.client_id },
      authenticate: secret === undefined ? oauth.None() : oauth.ClientSecretPost(secret),
    });
  }
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const path = join(options.directory, "accounts.sqlite");
  const file = await open(path, "a", 0o600);
  await file.close();
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, provider TEXT UNIQUE NOT NULL, data TEXT NOT NULL)",
  );
  const flows = new Map<string, Flow>();
  const locks = new Map<string, Promise<unknown>>();
  const stopped = new AbortController();
  const failures: unknown[] = [];
  let closing: Promise<void> | undefined;
  const redirect =
    options.origin === undefined ? undefined : new URL("/api/oauth/callback", options.origin).href;

  const serverRecord = (server: Server): AuthorizationServerRecord => ({
    id: server.id,
    label: server.label,
    authorization_endpoint: server.metadata.authorization_endpoint ?? null,
    token_endpoint: server.metadata.token_endpoint,
    device_authorization_endpoint: server.metadata.device_authorization_endpoint ?? null,
    revocation_endpoint: server.metadata.revocation_endpoint ?? null,
    grant_types_supported: server.metadata.grant_types_supported,
  });
  const service: AccountsService = {
    namespace: options.directory,
    async servers(limit, cursor) {
      return page(
        [...servers.values()].map(serverRecord).sort((a, b) => a.id.localeCompare(b.id)),
        "servers",
        limit,
        cursor,
      );
    },
    async server(id) {
      const server = servers.get(id);
      return server && serverRecord(server);
    },
    async accounts(serverId, limit, cursor) {
      return page(
        all()
          .filter((account) => serverId === undefined || account.serverId === serverId)
          .map(publicAccount),
        `accounts:${serverId ?? ""}`,
        limit,
        cursor,
      );
    },
    async account(id) {
      const account = stored(id);
      return account && publicAccount(account);
    },
    async authorizations(serverId, limit, cursor) {
      return page(
        [...flows.values()]
          .map(({ record }) => record)
          .filter((record) => record.serverId === serverId)
          .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
        `authorizations:${serverId}`,
        limit,
        cursor,
      );
    },
    async authorization(id) {
      return structuredClone(flows.get(id)?.record);
    },
    async authorize(serverId, accountId, context) {
      const server = servers.get(serverId);
      if (server && (!redirect || !server.metadata.authorization_endpoint))
        return { error: "BAD_REQUEST" };
      const result = admit(serverId, accountId, "authorization_code", context);
      if ("error" in result) return result;
      const { flow } = result;
      flow.verifier = oauth.generateRandomCodeVerifier();
      flow.state = oauth.generateRandomState();
      const challenge = await oauth.calculatePKCECodeChallenge(flow.verifier);
      const parameters = {
        response_type: "code",
        client_id: flow.server.client_id,
        redirect_uri: redirect!,
        state: flow.state,
        code_challenge: challenge,
        code_challenge_method: "S256",
        ...(flow.server.scope === undefined ? {} : { scope: flow.server.scope }),
      };
      const url = new URL(flow.server.metadata.authorization_endpoint!);
      for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
      flow.record = { ...flow.record, request: { ...parameters, url: url.href } };
      return { value: structuredClone(flow.record) };
    },
    async deviceAuthorization(serverId, accountId, context) {
      const server = servers.get(serverId);
      if (server && !server.metadata.device_authorization_endpoint) return { error: "BAD_REQUEST" };
      const result = admit(serverId, accountId, deviceGrant, context);
      if ("error" in result) return result;
      const { flow } = result;
      try {
        const response = await oauth.deviceAuthorizationRequest(
          flow.server.metadata,
          flow.server.client,
          flow.server.authenticate,
          flow.server.scope === undefined ? {} : { scope: flow.server.scope },
          request(flow.controller.signal),
        );
        const device = await oauth.processDeviceAuthorizationResponse(
          flow.server.metadata,
          flow.server.client,
          response,
        );
        flow.controller.signal.throwIfAborted();
        flow.record = {
          ...flow.record,
          deviceAuthorizationResponse: {
            user_code: device.user_code,
            verification_uri: device.verification_uri,
            verification_uri_complete: device.verification_uri_complete ?? null,
            expires_in: device.expires_in,
            interval: device.interval ?? null,
          },
        };
        void launch(flow, () => poll(flow, device)).catch((error: unknown) => {
          failures.push(error);
          console.error("OAuth polling failed", error);
        });
      } catch (error) {
        fail(flow, error);
        if (!(error instanceof oauth.ResponseBodyError)) throw error;
      }
      return { value: structuredClone(flow.record) };
    },
    async cancelAuthorization(id) {
      const flow = flows.get(id);
      if (!flow) return { error: "NOT_FOUND" };
      if (flow.record.status === "pending") {
        flow.record = { ...flow.record, status: "cancelled" };
        flow.controller.abort();
        await flow.work;
      }
      return { value: undefined };
    },
    async disconnect(id, context) {
      const account = stored(id);
      if (!account) return { error: "NOT_FOUND" };
      for (const flow of flows.values())
        if (flow.record.accountId === id)
          await service.cancelAuthorization(flow.record.id, context);
      await serial(account.provider, async () => {
        db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
      });
      return { value: undefined };
    },
    async revoke(id, hint, context) {
      const account = stored(id);
      if (!account) return { error: "NOT_FOUND" };
      const server = servers.get(account.serverId);
      if (!server?.metadata.revocation_endpoint) return { error: "BAD_REQUEST" };
      const token =
        hint === "access_token"
          ? account.access_token
          : hint === "refresh_token"
            ? account.refresh_token
            : (account.refresh_token ?? account.access_token);
      if (!token) return { error: "BAD_REQUEST" };
      try {
        const response = await oauth.revocationRequest(
          server.metadata,
          server.client,
          server.authenticate,
          token,
          {
            ...request(context.abortSignal ?? stopped.signal),
            ...(hint === undefined ? {} : { additionalParameters: { token_type_hint: hint } }),
          },
        );
        await oauth.processRevocationResponse(response);
        return { value: undefined };
      } catch (error) {
        if (error instanceof oauth.ResponseBodyError) return { protocolError: protocolCode(error) };
        throw error;
      }
    },
  };

  for (const providerId of new Set(options.servers.map((server) => server.provider))) {
    const provider = options.models.getProvider(providerId)!;
    options.models.setProvider({
      ...provider,
      auth: {
        apiKey: {
          name: "Linked account",
          async check(input) {
            const account = all().find((item) => item.provider === providerId);
            if (account)
              return account.status === "reauthorizationRequired"
                ? undefined
                : { source: "Linked account", type: "oauth" };
            if (provider.auth.apiKey?.check) return provider.auth.apiKey.check(input);
            return (await provider.auth.apiKey?.resolve(input)) ? { type: "api_key" } : undefined;
          },
          async resolve(input) {
            stopped.signal.throwIfAborted();
            input.signal.throwIfAborted();
            const work = serial(providerId, async () => {
              stopped.signal.throwIfAborted();
              input.signal.throwIfAborted();
              let account = all().find((item) => item.provider === providerId);
              if (!account) return provider.auth.apiKey?.resolve(input);
              if (account.expiresAt !== null && account.expiresAt <= Date.now()) {
                if (!account.refresh_token) {
                  save({ ...account, status: "reauthorizationRequired" });
                  throw new Error("Account requires reauthorization");
                }
                const server = servers.get(account.serverId);
                assert(server, "Authorization server is no longer configured");
                let tokens: oauth.TokenEndpointResponse;
                try {
                  const response = await oauth.refreshTokenGrantRequest(
                    server.metadata,
                    server.client,
                    server.authenticate,
                    account.refresh_token,
                    { signal: AbortSignal.timeout(30_000) },
                  );
                  tokens = await oauth.processRefreshTokenResponse(
                    server.metadata,
                    server.client,
                    response,
                  );
                } catch (error) {
                  save({
                    ...account,
                    status:
                      error instanceof oauth.ResponseBodyError && error.error === "invalid_grant"
                        ? "reauthorizationRequired"
                        : "temporarilyUnavailable",
                  });
                  throw new Error("Account credentials unavailable", { cause: error });
                }
                assert(tokens.token_type === "bearer");
                account = {
                  ...account,
                  access_token: tokens.access_token,
                  refresh_token: tokens.refresh_token ?? account.refresh_token,
                  expiresAt:
                    tokens.expires_in === undefined ? null : Date.now() + tokens.expires_in * 1000,
                  scope: tokens.scope ?? account.scope,
                  status: "usable",
                };
                save(account);
              }
              return { auth: { apiKey: account.access_token }, source: "Linked account" };
            });
            return awaitWithContext(work, withAbortSignal(input.signal, BACKGROUND_CONTEXT));
          },
        },
      },
    });
  }
  return {
    service,
    async callback(this: void, url: URL): Promise<void> {
      const state = url.searchParams.get("state");
      const flow = [...flows.values()].find((flow) => state !== null && flow.state === state);
      if (!flow || flow.record.status !== "pending" || flow.work) throw new Problem(400);
      if (url.origin + url.pathname !== redirect) throw new Problem(400);
      await launch(flow, async () => {
        const { server } = flow;
        const parameters = oauth.validateAuthResponse(
          server.metadata,
          server.client,
          url,
          flow.state,
        );
        const response = await oauth.authorizationCodeGrantRequest(
          server.metadata,
          server.client,
          server.authenticate,
          parameters,
          redirect!,
          flow.verifier!,
          request(flow.controller.signal),
        );
        await publish(
          flow,
          await oauth.processAuthorizationCodeResponse(server.metadata, server.client, response),
        );
      });
    },
    close(): Promise<void> {
      closing ??= (async () => {
        stopped.abort();
        for (const flow of flows.values()) flow.controller.abort();
        await Promise.allSettled(
          [...flows.values()].flatMap((flow) => (flow.work ? [flow.work] : [])),
        );
        await Promise.allSettled(locks.values());
        db.close();
        if (failures.length) throw new AggregateError(failures, "OAuth polling failed");
      })();
      return closing;
    },
  };

  /*
   * Helpers: Accounts
   */

  function page<T extends { id: string }>(
    items: T[],
    scope: string,
    limit: number,
    cursor: Parameters<AccountsService["accounts"]>[2],
  ) {
    let offset = 0;
    if (cursor !== undefined) {
      if (
        cursor.namespace !== options.directory ||
        cursor.scope !== scope ||
        typeof cursor.after !== "string"
      )
        return { invalidCursor: true } as const;
      offset = items.findIndex((item) => item.id === cursor.after) + 1;
      if (offset === 0) return { invalidCursor: true } as const;
    }
    const selected = items.slice(offset, offset + limit);
    return {
      items: structuredClone(selected),
      next:
        offset + limit < items.length
          ? { namespace: options.directory, scope, after: selected.at(-1)!.id }
          : null,
    };
  }

  function publicAccount(account: StoredAccount): AccountRecord {
    const { id, serverId, identifier, displayName, scope, status } = account;
    return { id, serverId, identifier, displayName, scope, status };
  }

  function all(): StoredAccount[] {
    return db
      .prepare("SELECT id FROM accounts ORDER BY id")
      .all()
      .map((row) => {
        assert(typeof row.id === "string");
        return stored(row.id)!;
      });
  }

  function stored(id: string): StoredAccount | undefined {
    const row = db.prepare("SELECT data FROM accounts WHERE id = ?").get(id);
    if (!row) return undefined;
    assert(typeof row.data === "string");
    const value: unknown = JSON.parse(row.data);
    Value.Assert(Stored, value);
    return value;
  }

  function admit(
    serverId: string,
    accountId: string | undefined,
    grant: string,
    context: Context,
  ): { flow: Flow } | { error: "BAD_REQUEST" | "NOT_FOUND" } {
    context.abortSignal?.throwIfAborted();
    stopped.signal.throwIfAborted();
    const server = servers.get(serverId);
    if (!server) return { error: "NOT_FOUND" } as const;
    if (!server.metadata.grant_types_supported.includes(grant))
      return { error: "BAD_REQUEST" } as const;
    const existing = accountId === undefined ? undefined : stored(accountId);
    if (accountId !== undefined && (!existing || existing.serverId !== serverId))
      return { error: "NOT_FOUND" } as const;
    if (accountId === undefined && all().some((account) => account.provider === server.provider))
      return { error: "BAD_REQUEST" } as const;
    const flow: Flow = {
      record: {
        id: randomUUID(),
        serverId,
        accountId: accountId ?? null,
        createdAt: Date.now(),
        status: "pending",
      },
      server,
      controller: new AbortController(),
    };
    flows.set(flow.record.id, flow);
    return { flow };
  }

  function request(signal: AbortSignal) {
    return { signal: AbortSignal.any([signal, stopped.signal, AbortSignal.timeout(30_000)]) };
  }

  async function poll(flow: Flow, device: oauth.DeviceAuthorizationResponse) {
    const { server } = flow;
    const expiresAt = flow.record.createdAt + device.expires_in * 1000;
    let interval = (device.interval ?? 5) * 1000;
    while (Date.now() < expiresAt) {
      await timers.setTimeout(Math.min(interval, expiresAt - Date.now()), undefined, {
        signal: flow.controller.signal,
      });
      if (Date.now() >= expiresAt) break;
      try {
        const response = await oauth.deviceCodeGrantRequest(
          server.metadata,
          server.client,
          server.authenticate,
          device.device_code,
          request(flow.controller.signal),
        );
        const tokens = await oauth.processDeviceCodeResponse(
          server.metadata,
          server.client,
          response,
        );
        if (Date.now() >= expiresAt) break;
        await publish(flow, tokens);
        return;
      } catch (error) {
        if (error instanceof oauth.ResponseBodyError && error.error === "authorization_pending")
          continue;
        if (error instanceof oauth.ResponseBodyError && error.error === "slow_down") {
          interval += 5000;
          continue;
        }
        if (error instanceof DOMException && error.name === "TimeoutError") {
          interval *= 2;
          continue;
        }
        throw error;
      }
    }
    flow.record = { ...flow.record, status: "failed", error: { error: "expired_token" } };
  }

  function launch(flow: Flow, fn: () => Promise<void>): Promise<void> {
    flow.work = fn().catch((error: unknown) => {
      fail(flow, error);
      if (
        error instanceof oauth.ResponseBodyError ||
        error instanceof oauth.AuthorizationResponseError
      )
        return;
      if (flow.controller.signal.aborted && error instanceof Error && error.name === "AbortError")
        return;
      throw error;
    });
    return flow.work;
  }

  function fail(flow: Flow, error: unknown) {
    if (flow.record.status !== "pending") return;
    flow.record = { ...flow.record, status: "failed", error: { error: protocolCode(error) } };
  }

  function serial<T>(provider: string, fn: () => Promise<T>): Promise<T> {
    const work = (locks.get(provider) ?? Promise.resolve()).then(fn, fn);
    locks.set(provider, work);
    void work
      .finally(() => {
        if (locks.get(provider) === work) locks.delete(provider);
      })
      .catch(() => {});
    return work;
  }

  function save(account: StoredAccount) {
    db.prepare(
      "INSERT INTO accounts VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data",
    ).run(account.id, account.provider, JSON.stringify(account));
  }

  async function publish(flow: Flow, tokens: oauth.TokenEndpointResponse) {
    assert(tokens.token_type === "bearer", "Unsupported token type");
    const { server } = flow;
    let identifier: string | null = null;
    let displayName: string | null = null;
    if (server.metadata.userinfo_endpoint) {
      const response = await oauth.userInfoRequest(
        server.metadata,
        server.client,
        tokens.access_token,
        request(flow.controller.signal),
      );
      const info = await oauth.processUserInfoResponse(
        server.metadata,
        server.client,
        oauth.skipSubjectCheck,
        response,
      );
      identifier = info.sub;
      displayName = typeof info.name === "string" ? info.name : null;
    }
    await serial(server.provider, async () => {
      flow.controller.signal.throwIfAborted();
      const existing = flow.record.accountId ? stored(flow.record.accountId) : undefined;
      if (flow.record.accountId) {
        assert(existing, "Account was disconnected");
        assert(
          existing.identifier === null || existing.identifier === identifier,
          "Account identity changed",
        );
      } else
        assert(!all().some((item) => item.provider === server.provider), "Provider already linked");
      const account: StoredAccount = {
        id: existing?.id ?? randomUUID(),
        serverId: server.id,
        provider: server.provider,
        identifier,
        displayName,
        scope: tokens.scope ?? null,
        status: "usable",
        access_token: tokens.access_token,
        ...(tokens.refresh_token === undefined ? {} : { refresh_token: tokens.refresh_token }),
        expiresAt: tokens.expires_in === undefined ? null : Date.now() + tokens.expires_in * 1000,
      };
      save(account);
      flow.record = { ...flow.record, accountId: account.id, status: "completed", error: null };
    });
  }
}

/*
 * Helpers: Accounts
 */

type Server = Registration & { client: oauth.Client; authenticate: oauth.ClientAuth };

type StoredAccount = Type.Static<typeof Stored>;

type Flow = {
  record: AuthorizationRecord;
  server: Server;
  controller: AbortController;
  verifier?: string;
  state?: string;
  work?: Promise<void>;
};

const Stored = Type.Object({
  id: Text,
  provider: Text,
  serverId: Text,
  identifier: Type.Union([Type.String(), Type.Null()]),
  displayName: Type.Union([Type.String(), Type.Null()]),
  scope: Type.Union([Type.String(), Type.Null()]),
  status: Type.Enum(["usable", "temporarilyUnavailable", "reauthorizationRequired"]),
  access_token: Text,
  refresh_token: Type.Optional(Text),
  expiresAt: Type.Union([Type.Number(), Type.Null()]),
});

const deviceGrant = "urn:ietf:params:oauth:grant-type:device_code";

const protocolCode = (error: unknown): string =>
  (error instanceof oauth.ResponseBodyError || error instanceof oauth.AuthorizationResponseError) &&
  /^[a-z][a-z0-9_]{0,63}$/.test(error.error)
    ? error.error
    : "server_error";
