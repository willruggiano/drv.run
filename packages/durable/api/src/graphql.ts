import type { GraphQLArgs } from "graphql";
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

export async function decode(
  request: Request,
): Promise<Pick<GraphQLArgs, "source" | "operationName" | "variableValues">> {
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
  return args;
}
