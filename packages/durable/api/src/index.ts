import { serve } from "durable-api/serve";

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

        "/api/watch": async (request, server) => {
          if (request.method !== "GET") {
            return new Response(null, {
              status: 405,
              headers: { Allow: "GET", "Cache-Control": "no-store" },
            });
          }
          const query = decodeWatchQuery(new URL(request.url).searchParams);
          const watch = await app.api.watch(query, request.signal);
          server.timeout(request, 0);
          return eventStreamResponse(watch);
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
    console.log(`Listening on ${server.url}`);
  } catch (error) {
    await app.close();
    throw error;
  }
}

await main();
