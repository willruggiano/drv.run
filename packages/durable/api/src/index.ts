import { serve } from "durable-api/serve";
import { sse } from "durable-api/sse";
import type { watch } from "durable-api/watch";
import { Problem } from "./problem.ts";
import { openApplication } from "./application.ts";
import { readDeploymentConfiguration } from "./configuration.ts";
import { decode } from "./graphql.ts";
import { getOperationAST, parse } from "graphql";

type WatchQuery = Parameters<typeof watch>[0];

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
            await app.api.oauthCallback(new URL(request.url));
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
            if (request.method !== "GET" && request.method !== "POST")
              throw new Problem(405, "GET, POST");
            if (request.method === "POST") {
              const contentType = request.headers
                .get("content-type")
                ?.split(";", 1)[0]
                ?.trim()
                .toLowerCase();
              if (contentType !== "application/json") throw new Problem(415);
            }
            const args = await decode(request);
            if (request.method === "GET") {
              let operation;
              try {
                operation = getOperationAST(parse(args.source), args.operationName);
              } catch {
                /* Syntax errors are returned by GraphQL execution. */
              }
              if (operation?.operation === "mutation") throw new Problem(405, "POST");
            }
            const result = await app.api.graphql(args, request.signal);
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

      fetch: () => new Response("Not Found", { status: 404 }),

      error() {
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

if (import.meta.main) await main();
