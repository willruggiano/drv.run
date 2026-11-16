import assert from "node:assert/strict";
import type { GraphQLArgs } from "graphql";
import Type from "typebox";
import Value from "typebox/value";
import { Problem } from "./problem.ts";

export async function decode(
  request: Request,
): Promise<Pick<GraphQLArgs, "source" | "operationName" | "variableValues">> {
  assert.equal(request.method, "POST");
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new Problem(400);
  }
  if (!Value.Check(RequestPayload, value)) throw new Problem(400);
  const args: Pick<GraphQLArgs, "source" | "operationName" | "variableValues"> = {
    source: value.query,
    operationName: value.operationName ?? null,
    variableValues: value.variables ?? null,
  };
  return args;
}

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
