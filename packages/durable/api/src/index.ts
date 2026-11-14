import { serve } from "durable-api/serve";
import { sse } from "durable-api/sse";
import type { watch } from "durable-api/watch";
import { getOperationAST, parse } from "graphql";
import { Problem } from "./problem.ts";
import { openApplication } from "./application.ts";
import { readDeploymentConfiguration } from "./configuration.ts";

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

type GraphQLPayload = {
  readonly query: string;
  readonly operationName?: string | null;
  readonly variables?: Record<string, unknown> | null;
  readonly extensions?: Record<string, unknown> | null;
};

const responseTypes = ["application/graphql-response+json", "application/json"] as const;
type GraphQLResponseType = (typeof responseTypes)[number];

function negotiateResponseType(accept: string | null): GraphQLResponseType {
  if (accept === null || accept.trim() === "") return "application/json";
  const accepted = accept.split(",").flatMap((part, order) => {
    const [media = "", ...parameters] = part.trim().toLowerCase().split(";");
    const qParameter = parameters
      .map((parameter) => parameter.trim())
      .find((parameter) => parameter.startsWith("q="));
    const quality = qParameter === undefined ? 1 : Number(qParameter.slice(2));
    if (!Number.isFinite(quality) || quality < 0 || quality > 1) return [];
    const supported = responseTypes.find(
      (type) =>
        media === type ||
        media === "*/*" ||
        (media === "application/*" && type.startsWith("application/")),
    );
    return supported === undefined || quality === 0 ? [] : [{ type: supported, quality, order }];
  });
  accepted.sort((a, b) => b.quality - a.quality || a.order - b.order);
  const selected = accepted[0]?.type;
  if (selected === undefined) throw new Problem(406);
  return selected;
}

function uniqueParameters(search: URLSearchParams): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of ["query", "operationName", "variables", "extensions"]) {
    const values = search.getAll(key);
    if (values.length > 1) throw new Problem(400);
    if (values.length === 1) result[key] = values[0]!;
  }
  for (const key of search.keys()) if (!Object.hasOwn(result, key)) throw new Problem(400);
  return result;
}

function jsonObjectParameter(value: string | undefined): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new Problem(400);
  }
}

function graphQLPayload(value: unknown): GraphQLPayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Problem(400);
  const record = value as Record<string, unknown>;
  if (typeof record.query !== "string" || record.query.length === 0) throw new Problem(400);
  if (
    record.operationName !== undefined &&
    record.operationName !== null &&
    typeof record.operationName !== "string"
  )
    throw new Problem(400);
  for (const key of ["variables", "extensions"] as const) {
    const item = record[key];
    if (item !== undefined && item !== null && (typeof item !== "object" || Array.isArray(item)))
      throw new Problem(400);
  }
  for (const key of Object.keys(record))
    if (!["query", "operationName", "variables", "extensions"].includes(key))
      throw new Problem(400);
  return record as GraphQLPayload;
}

async function decodeGraphQLRequest(
  request: Request,
): Promise<{ payload: GraphQLPayload; responseType: GraphQLResponseType }> {
  if (request.method !== "GET" && request.method !== "POST") throw new Problem(405, "GET, POST");
  const responseType = negotiateResponseType(request.headers.get("accept"));
  let value: unknown;
  if (request.method === "GET") {
    value = uniqueParameters(new URL(request.url).searchParams);
    const parameters = value as Record<string, string>;
    value = {
      query: parameters.query,
      ...(parameters.operationName === undefined
        ? {}
        : { operationName: parameters.operationName }),
      ...(parameters.variables === undefined
        ? {}
        : { variables: jsonObjectParameter(parameters.variables) }),
      ...(parameters.extensions === undefined
        ? {}
        : { extensions: jsonObjectParameter(parameters.extensions) }),
    };
  } else {
    const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") throw new Problem(415);
    try {
      value = await request.json();
    } catch {
      throw new Problem(400);
    }
  }
  const payload = graphQLPayload(value);
  if (request.method === "GET") {
    let operation;
    try {
      operation = getOperationAST(parse(payload.query), payload.operationName ?? undefined);
    } catch {
      // GraphQL syntax errors are execution results; there is no selected mutation to reject.
      return { payload, responseType };
    }
    if (operation?.operation === "mutation") throw new Problem(405, "POST");
  }
  return { payload, responseType };
}

function encodeGraphQLResponse(result: unknown, responseType: GraphQLResponseType): Response {
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "Cache-Control": "no-store", "Content-Type": `${responseType}; charset=utf-8` },
  });
}

export async function graphQLRequest(
  request: Request,
  execute: (payload: unknown, signal: AbortSignal) => Promise<unknown>,
): Promise<Response> {
  try {
    const { payload, responseType } = await decodeGraphQLRequest(request);
    return encodeGraphQLResponse(await execute(payload, request.signal), responseType);
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
}

export async function main(
  config = readDeploymentConfiguration(),
  open = openApplication,
): Promise<{
  server: Awaited<ReturnType<typeof serve>>;
  app: Awaited<ReturnType<typeof openApplication>>;
  shutdown(): Promise<void>;
}> {
  const app = await open(config);

  try {
    const server = await serve({
      ...config.server,
      routes: {
        "/api/graphql": (request) =>
          graphQLRequest(request, (payload, signal) => app.api.graphql(payload, signal)),

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
