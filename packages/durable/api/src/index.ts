import { serve } from "durable-api/serve";
import { sse } from "durable-api/sse";
import type { watch } from "durable-api/watch";
import { Problem } from "./problem.ts";
import { openApplication } from "./application.ts";
import { readDeploymentConfiguration } from "./configuration.ts";
import { decode } from "./graphql.ts";
import { website } from "./www.ts";

export async function main(): Promise<void> {
  const config = readDeploymentConfiguration();
  const app = await openApplication(config);

  try {
    const server = await serve({
      ...config.server,
      routes: {
        async "/api/oauth/callback"(request) {
          if (request.method !== "GET")
            return new Response(null, { status: 405, headers: { Allow: "GET" } });
          try {
            if (!config.origin) throw new Problem(400);
            const callback = new URL("/api/oauth/callback", config.origin);
            callback.search = new URL(request.url).search;
            await app.api.oauthCallback(callback);
            return new Response("Authorization processed. You may close this page.", {
              headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
            });
          } catch (error) {
            if (!(error instanceof Problem)) throw error;
            return new Response(null, {
              status: error.status,
              headers: { "Cache-Control": "no-store" },
            });
          }
        },
        async "/api/graphql"(request) {
          try {
            if (request.method !== "POST") throw new Problem(405, "POST");
            const contentType = request.headers
              .get("content-type")
              ?.split(";", 1)[0]
              ?.trim()
              .toLowerCase();
            if (contentType !== "application/json") throw new Problem(415);
            const args = await decode(request);
            const result = await app.api.graphql(args, request.signal);
            for (const error of result.errors ?? [])
              if (error.extensions.code === "INTERNAL_SERVER_ERROR")
                console.error("GraphQL execution failed", error.originalError);
            return Response.json(result, {
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

      fetch: await website(config.wwwDirectory),

      error(error) {
        console.error("HTTP request failed", error);
        return new Response("Internal Server Error", {
          status: 500,
          headers: { "Cache-Control": "no-store" },
        });
      },
    });
    console.log(`Listening on ${server.url.href}`);
    try {
      await new Promise<void>((resolve) => {
        const stop = () => {
          process.off("SIGINT", stop);
          process.off("SIGTERM", stop);
          resolve();
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
    } finally {
      server.forceClose();
      await server.close();
    }
  } finally {
    await app.close();
  }
}

type WatchQuery = Parameters<typeof watch>[0];

if (import.meta.main) await main();
