import assert from "node:assert/strict";
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
import { createApi, type ApiOptions } from "durable-api";

export async function serve(
  t: TestContext,
  options: Omit<ApiOptions, "models"> & { models?: ApiOptions["models"] },
) {
  const api = createApi({ models: createModels(), ...options });
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
