import { serve } from "durable-api/serve";
import { sse } from "durable-api/sse";
import type { watch } from "durable-api/watch";
import { Problem } from "./problem.ts";

type WatchQuery = Parameters<typeof watch>[0];
type AcquireWatch = (query: WatchQuery, signal: AbortSignal) => ReturnType<typeof watch>;

export async function watchRequest(
  request: Request,
  server: Pick<Awaited<ReturnType<typeof serve>>, "timeout">,
  acquire: AcquireWatch,
): Promise<Response> {
  if (request.method !== "GET") {
    return new Response(null, {
      status: 405,
      headers: { Allow: "GET", "Cache-Control": "no-store" },
    });
  }
  try {
    const params = new URL(request.url).searchParams;
    const externalId = params.get("externalId");
    const id = params.get("conversationId");
    if (params.size !== 2 || !externalId || id === null || !/^[0-9]+$/.test(id))
      throw new Problem(400);
    const conversationId = Number(id);
    if (!Number.isSafeInteger(conversationId)) throw new Problem(400);
    const events = await acquire(
      {
        externalId,
        conversationId: conversationId as WatchQuery["conversationId"],
      },
      request.signal,
    );
    try {
      server.timeout(request, 0);
      return sse(events);
    } catch (error) {
      await events.cancel();
      throw error;
    }
  } catch (error) {
    if (!(error instanceof Problem)) throw error;
    return new Response(null, { status: error.status, headers: { "Cache-Control": "no-store" } });
  }
}

function readDeploymentConfiguration(): Omit<
  Parameters<typeof serve>[0],
  "routes" | "fetch" | "error"
> {
  throw new Error("readDeploymentConfiguration is not implemented");
}

async function openApplication(_config: ReturnType<typeof readDeploymentConfiguration>): Promise<{
  api: {
    graphql(payload: unknown, signal: AbortSignal): Promise<unknown>;
    watch: AcquireWatch;
  };
  close(): Promise<void>;
}> {
  throw new Error("openApplication is not implemented");
}

async function decodeGraphQLRequest(
  _request: Request,
): Promise<{ payload: unknown; responseType: string }> {
  throw new Error("decodeGraphQLRequest is not implemented");
}

function encodeGraphQLResponse(_result: unknown, _responseType: string): Response {
  throw new Error("encodeGraphQLResponse is not implemented");
}

async function main(): Promise<void> {
  const config = readDeploymentConfiguration();
  const app = await openApplication(config);

  try {
    const server = await serve({
      ...config,
      routes: {
        "/api/graphql": async (request) => {
          const { payload, responseType } = await decodeGraphQLRequest(request);
          const result = await app.api.graphql(payload, request.signal);
          return encodeGraphQLResponse(result, responseType);
        },

        "/api/watch": (request, server) =>
          watchRequest(request, server, (query, signal) => app.api.watch(query, signal)),
      },

      fetch: () => new Response("Not Found", { status: 404 }),

      error() {
        return new Response("Internal Server Error", {
          status: 500,
          headers: { "Cache-Control": "no-store" },
        });
      },
    });
    console.log(`Listening on ${server.url}`);
  } catch (error) {
    await app.close();
    throw error;
  }
}

if (import.meta.main) await main();
