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

export async function serve(
  t: TestContext,
  options: Omit<
    ApiOptions,
    "models" | "listHarnesses" | "isValidExternalId" | "documents" | "settings" | "inventory"
  > & {
    models?: ApiOptions["models"];
    documents?: ApiOptions["documents"];
    settings?: ApiOptions["settings"];
    inventory?: ApiOptions["inventory"];
    isValidExternalId?: ApiOptions["isValidExternalId"];
    listHarnesses?: ApiOptions["listHarnesses"];
  },
) {
  const api = createApi({
    models: createModels(),
    settings: unavailableSettings,
    inventory: unavailableInventory,
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
