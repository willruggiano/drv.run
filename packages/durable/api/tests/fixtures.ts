import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
  Harness,
  MemoryStorage,
  createRegistry,
  type HarnessOptions,
  type Conversation,
  type ConversationView,
  type WatchEnd,
} from "@earendil-works/pi-durable";
import { createApi, type ApiOptions } from "../src/index.ts";

const unavailableConfiguration = {
  async read(): Promise<never> {
    throw new Error("settings service is not bound in this test");
  },
  async replace(): Promise<never> {
    throw new Error("settings service is not bound in this test");
  },
};
export const unavailableSettings: ApiOptions["settings"] = {
  web: unavailableConfiguration,
  harness: unavailableConfiguration,
};

export const unavailableInventory: ApiOptions["inventory"] = {
  namespace: "unbound",
  async list() {
    assert.fail("inventory service is not bound in this test");
  },
  async lookup() {
    assert.fail("inventory service is not bound in this test");
  },
  async flakeReference() {
    assert.fail("inventory service is not bound in this test");
  },
  async state() {
    assert.fail("inventory service is not bound in this test");
  },
  async timings() {
    assert.fail("inventory service is not bound in this test");
  },
};

async function unboundAccounts(): Promise<never> {
  assert.fail("accounts service is not bound in this test");
}
export const unavailableAccounts: ApiOptions["accounts"] = {
  namespace: "unbound",
  servers: unboundAccounts,
  accounts: unboundAccounts,
  authorizations: unboundAccounts,
  server: unboundAccounts,
  account: unboundAccounts,
  authorization: unboundAccounts,
  authorize: unboundAccounts,
  deviceAuthorization: unboundAccounts,
  cancelAuthorization: unboundAccounts,
  disconnect: unboundAccounts,
  revoke: unboundAccounts,
};

async function unboundPush(): Promise<never> {
  assert.fail("push service is not bound in this test");
}
export const unavailablePush: ApiOptions["push"] = {
  applicationServerKey: unboundPush,
  registered: unboundPush,
  register: unboundPush,
  remove: unboundPush,
};

export async function serve(
  t: TestContext,
  options: Omit<
    ApiOptions,
    | "models"
    | "listHarnesses"
    | "isValidExternalId"
    | "documents"
    | "settings"
    | "inventory"
    | "accounts"
    | "push"
  > & {
    models?: ApiOptions["models"];
    documents?: ApiOptions["documents"];
    settings?: ApiOptions["settings"];
    inventory?: ApiOptions["inventory"];
    accounts?: ApiOptions["accounts"];
    push?: ApiOptions["push"];
    isValidExternalId?: ApiOptions["isValidExternalId"];
    listHarnesses?: ApiOptions["listHarnesses"];
  },
) {
  const api = createApi({
    models: createModels(),
    settings: unavailableSettings,
    inventory: unavailableInventory,
    accounts: unavailableAccounts,
    push: unavailablePush,
    documents: { definitions: async () => [], resolve: async () => undefined },
    isValidExternalId: (id) => id.length > 0,
    listHarnesses: async () => ["test"],
    ...options,
  });
  const server = createServer(api.handle);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  t.after(async () => {
    await api.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  return { api, server, url: `http://127.0.0.1:${address.port}/api/s/test` };
}

export async function openHarness(
  t: TestContext,
  options: Partial<HarnessOptions> = {},
  storage = new MemoryStorage(),
): Promise<{
  harness: Harness;
  root: Conversation;
  faux: ReturnType<typeof fauxProvider>;
  registry: ReturnType<typeof createRegistry>;
  storage: MemoryStorage;
}> {
  const faux = fauxProvider({ models: [{ id: "test", reasoning: true }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  const harness = await Harness.open(
    storage,
    {
      models,
      registry,
      settings: { compaction: { backgroundTokens: 0 }, retry: { maxRetries: 0 } },
      ...options,
    },
    BACKGROUND_CONTEXT,
  );
  t.after(() => harness.close(BACKGROUND_CONTEXT));
  const root = await harness.root(BACKGROUND_CONTEXT, {
    agent: { model: { provider: "faux", modelId: "test" } },
  });
  return { harness, root, faux, registry, storage };
}

export async function* events(
  response: Response,
): AsyncGenerator<
  { type: "snapshot"; value: ConversationView } | { type: "end"; value: WatchEnd }
> {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert(response.body);
  let buffer = "";
  for await (const text of response.body.pipeThrough(new TextDecoderStream())) {
    buffer += text;
    let end: number;
    while ((end = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      if (frame.startsWith("data: ")) yield JSON.parse(frame.slice(6));
    }
  }
}

// In-memory service double. File persistence and XDG resolution belong to deployment.
export function settingsFixture(): ApiOptions["settings"] {
  function configuration<T>(initial: T) {
    let current = { revision: "absent", settings: initial };
    return {
      async read() {
        return structuredClone(current);
      },
      async replace(expectedRevision: string, settings: T) {
        if (expectedRevision !== current.revision) return undefined;
        current = {
          revision: createHash("sha256").update(JSON.stringify(settings)).digest("hex"),
          settings: structuredClone(settings),
        };
        return structuredClone(current);
      },
    };
  }
  return {
    web: configuration({
      wrapCode: false,
      bottomAlign: true,
      hideThinkingBlock: false,
      showImages: true,
      defaultDeliveryMode: "followUp",
    }),
    harness: configuration({
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
    }),
  };
}

export function inventoryFixture(namespace = "host/user"): ApiOptions["inventory"] {
  const rows = ["retained", "running", "starting"].map((id) => ({
    id,
    unit: `drv.run@${id}.service`,
  }));
  return {
    namespace,
    async list(limit, cursor) {
      let start = 0;
      if (cursor !== undefined) {
        if (cursor.namespace !== namespace) return { invalidCursor: true };
        const previous = rows.findIndex((row) => row.id === cursor.after);
        if (previous < 0) return { invalidCursor: true };
        start = previous + 1;
      }
      const items = rows.slice(start, start + limit);
      return {
        items,
        ...(start + items.length < rows.length
          ? { next: { namespace, after: items.at(-1)!.id } }
          : {}),
      };
    },
    async lookup(id) {
      return rows.find((row) => row.id === id);
    },
    async flakeReference(id) {
      return id === "starting" ? undefined : `github:owner/${id}`;
    },
    async state(id) {
      if (id === "retained") return undefined;
      return id === "starting"
        ? { activeState: "activating", subState: "start-pre" }
        : { activeState: "active", subState: "running", result: "success" };
    },
    async timings(id) {
      if (id === "retained") return undefined;
      if (id === "starting") return { invocation_id: "starting-invocation", host_phases: [] };
      return {
        invocation_id: "running-invocation",
        activation_us: 4294967296,
        worker_us: 1000000,
        boot_wait_us: 2000000,
        provision_us: 3000000,
        manager_gaps_us: 4288967296,
        host_phases: [
          { phase: "preparation-start", clock: "boottime", monotonic_s: 10.12, resolution_s: 0.01 },
          { phase: "preparation-ready", clock: "boottime", monotonic_s: 11.12, resolution_s: 0.01 },
        ],
        guest_phases: [
          { phase: "mounts-ready", clock: "boottime", monotonic_s: 0.25, resolution_s: 0.01 },
        ],
      };
    },
  };
}

type AccountFixtureRecord<K extends "server" | "account" | "authorization"> = NonNullable<
  Awaited<ReturnType<ApiOptions["accounts"][K]>>
>;
export function accountsFixture(namespace = "accounts/user"): {
  service: ApiOptions["accounts"];
  servers: Map<string, AccountFixtureRecord<"server">>;
  accounts: Map<string, AccountFixtureRecord<"account">>;
  authorizations: Map<string, AccountFixtureRecord<"authorization">>;
} {
  type Service = ApiOptions["accounts"];
  type Server = NonNullable<Awaited<ReturnType<Service["server"]>>>;
  type Account = NonNullable<Awaited<ReturnType<Service["account"]>>>;
  type Authorization = NonNullable<Awaited<ReturnType<Service["authorization"]>>>;
  const servers = new Map<string, Server>([
    [
      "issuer-a",
      {
        id: "issuer-a",
        label: "Issuer A",
        authorization_endpoint: "https://issuer.test/authorize",
        token_endpoint: "https://issuer.test/token",
        device_authorization_endpoint: "https://issuer.test/device",
        revocation_endpoint: "https://issuer.test/revoke",
        grant_types_supported: [
          "authorization_code",
          "urn:ietf:params:oauth:grant-type:device_code",
        ],
      },
    ],
    ["issuer-b", { id: "issuer-b", label: "Issuer B" }],
  ]);
  const accounts = new Map<string, Account>([
    [
      "first",
      {
        id: "first",
        serverId: "issuer-a",
        identifier: "provider-first",
        displayName: "First",
        status: "usable",
        scope: "read write",
      },
    ],
    ["second", { id: "second", serverId: "issuer-a", status: "reauthorizationRequired" }],
    ["third", { id: "third", serverId: "issuer-b", status: "temporarilyUnavailable" }],
  ]);
  const authorizations = new Map<string, Authorization>();
  function page<T extends { readonly id: string }>(
    scope: string,
    rows: T[],
    limit: number,
    cursor: Parameters<Service["servers"]>[1],
  ) {
    let offset = 0;
    if (cursor !== undefined) {
      const index = rows.findIndex((row) => row.id === cursor.after);
      if (cursor.namespace !== namespace || cursor.scope !== scope || index < 0)
        return { invalidCursor: true as const };
      offset = index + 1;
    }
    const items = rows.slice(offset, offset + limit);
    return {
      items,
      ...(offset + items.length < rows.length
        ? { next: { namespace, scope, after: items.at(-1)!.id } }
        : {}),
    };
  }
  function start(serverId: string, accountId: string | undefined, device: boolean) {
    const id = `flow-${authorizations.size + 1}`;
    const value: Authorization = {
      id,
      serverId,
      accountId: accountId ?? null,
      status: "pending",
      createdAt: 1700000000000,
      ...(device
        ? {
            deviceAuthorizationResponse: {
              user_code: "USER-CODE",
              verification_uri: "https://issuer.test/verify",
              expires_in: 600,
            },
          }
        : {
            request: {
              url: "https://issuer.test/authorize?state=correlation",
              response_type: "code",
              client_id: "public-client",
              redirect_uri: "https://app.test/callback",
              state: "correlation",
              code_challenge: "challenge",
              code_challenge_method: "S256",
            },
          }),
    };
    authorizations.set(id, value);
    return { value };
  }
  const service: Service = {
    namespace,
    async servers(limit, cursor) {
      return page("servers", [...servers.values()], limit, cursor);
    },
    async accounts(serverId, limit, cursor) {
      return page(
        `accounts:${serverId ?? "all"}`,
        [...accounts.values()].filter((row) => serverId === undefined || row.serverId === serverId),
        limit,
        cursor,
      );
    },
    async authorizations(serverId, limit, cursor) {
      return page(
        `authorizations:${serverId}`,
        [...authorizations.values()]
          .filter((row) => row.serverId === serverId)
          .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
        limit,
        cursor,
      );
    },
    async server(id) {
      return servers.get(id);
    },
    async account(id) {
      return accounts.get(id);
    },
    async authorization(id) {
      return authorizations.get(id);
    },
    async authorize(serverId, accountId) {
      return start(serverId, accountId, false);
    },
    async deviceAuthorization(serverId, accountId) {
      return start(serverId, accountId, true);
    },
    async cancelAuthorization(id) {
      const value = authorizations.get(id)!;
      authorizations.set(id, { ...value, status: "cancelled" });
      return { value: undefined };
    },
    async disconnect(id) {
      accounts.delete(id);
      return { value: undefined };
    },
    async revoke() {
      return { value: undefined };
    },
  };
  return { service, servers, accounts, authorizations };
}

export function pushFixture(): {
  service: ApiOptions["push"];
  subscriptions: Map<string, Parameters<ApiOptions["push"]["register"]>[0]>;
} {
  const subscriptions = new Map<string, Parameters<ApiOptions["push"]["register"]>[0]>();
  return {
    subscriptions,
    service: {
      async applicationServerKey() {
        return "public-vapid-key";
      },
      async registered(endpoint) {
        return { value: subscriptions.has(endpoint) };
      },
      async register(input) {
        subscriptions.set(input.endpoint, structuredClone(input));
        return { value: undefined };
      },
      async remove(endpoint) {
        subscriptions.delete(endpoint);
        return { value: undefined };
      },
    },
  };
}
