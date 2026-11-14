import { serve } from "durable-api/serve";
import { sse } from "durable-api/sse";
import type { watch } from "durable-api/watch";
import { Problem } from "./problem.ts";
import { openApplication } from "./application.ts";
import { readDeploymentConfiguration } from "./configuration.ts";
import { decodeGraphQLRequest } from "./graphql.ts";

type WatchQuery = Parameters<typeof watch>[0];

export async function main(): Promise<{
  server: Awaited<ReturnType<typeof serve>>;
  app: Awaited<ReturnType<typeof openApplication>>;
  shutdown(): Promise<void>;
}> {
  const config = readDeploymentConfiguration();
  const app = await openApplication(config);

  try {
    const server = await serve({
      ...config.server,
      routes: {
        async "/api/graphql"(request) {
          try {
            const args = await decodeGraphQLRequest(request);
            return Response.json(await app.api.graphql(args, request.signal), {
              headers: { "Cache-Control": "no-store" },
            });
          } catch (error) {
            if (!(error instanceof Problem)) throw error;
            return new Response(null, {
              status: error.status,
              headers: {
                "Cache-Control": "no-store",
                ...(error.allow === undefined ? {} : { Allow: error.allow }),
              },
            });
          }
        },
        async "/api/watch"(request, server) {
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
            const events = await app.api.watch(
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
            return new Response(null, {
              status: error.status,
              headers: { "Cache-Control": "no-store" },
            });
          }
        },
      },

      fetch: () => new Response("Not Found", { status: 404 }),

      error() {
        return new Response("Internal Server Error", {
          status: 500,
          headers: { "Cache-Control": "no-store" },
        });
      },
    });
    console.log(`Listening on ${server.url.href}`);
    let closing: Promise<void> | undefined;
    const shutdown = () => {
      closing ??= (async () => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        const failures: unknown[] = [];
        server.forceClose();
        await server.close();
        try {
          await app.close();
        } catch (error) {
          failures.push(error);
        }
        if (failures.length) throw new AggregateError(failures, "Server shutdown failed");
      })();
      return closing;
    };
    const stop = () => {
      void shutdown().catch((error: unknown) => console.error("Shutdown failed", error));
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    return { server, app, shutdown };
  } catch (error) {
    await app.close();
    throw error;
  }
}

if (import.meta.main) await main();
