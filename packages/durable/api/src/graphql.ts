import { getOperationAST, parse, type GraphQLArgs } from "graphql";
import Type from "typebox";
import Value from "typebox/value";
import { Problem } from "./problem.ts";

const ObjectParameter = Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()]);
const RequestPayload = Type.Object(
  {
    query: Type.String({ minLength: 1 }),
    operationName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    variables: Type.Optional(ObjectParameter),
    extensions: Type.Optional(ObjectParameter),
  },
  { additionalProperties: false },
);

// graphql.js parses documents, not HTTP envelopes. Decode the transport here and
// pass its native execution arguments to the application.
export async function decodeGraphQLRequest(
  request: Request,
): Promise<Pick<GraphQLArgs, "source" | "operationName" | "variableValues">> {
  if (request.method !== "GET" && request.method !== "POST") throw new Problem(405, "GET, POST");
  let value: unknown;
  if (request.method === "GET") {
    const search = new URL(request.url).searchParams;
    if (search.size !== new Set(search.keys()).size) throw new Problem(400);
    const parameters: Record<string, unknown> = Object.fromEntries(search);
    try {
      for (const key of ["variables", "extensions"]) {
        const encoded = search.get(key);
        if (encoded !== null) parameters[key] = JSON.parse(encoded);
      }
    } catch {
      throw new Problem(400);
    }
    value = parameters;
  } else {
    const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") throw new Problem(415);
    try {
      value = await request.json();
    } catch {
      throw new Problem(400);
    }
  }
  if (!Value.Check(RequestPayload, value)) throw new Problem(400);
  const args: Pick<GraphQLArgs, "source" | "operationName" | "variableValues"> = {
    source: value.query,
    operationName: value.operationName ?? null,
    variableValues: value.variables ?? null,
  };
  if (request.method === "GET") {
    let operation;
    try {
      operation = getOperationAST(parse(value.query), value.operationName);
    } catch {
      // Syntax errors remain GraphQL execution results.
      return args;
    }
    if (operation?.operation === "mutation") throw new Problem(405, "POST");
  }
  return args;
}
