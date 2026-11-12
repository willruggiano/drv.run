import type { GraphQLSchema } from "graphql";
import type * as Durable from "@earendil-works/pi-durable";
import type * as Chord from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai/models";
import { createSchema as buildSchema } from "./graphql.ts";

// Keep public declarations independent of implementation-only Grats types.
export const createSchema: () => GraphQLSchema = buildSchema;

// Session keys must never be reused for replacement storage.
// Deployment enforces access policy for every lookup and catalog.
// The caller owns Harnesses; storage owns pagination cursors.
/** @gqlContext */
export interface ResolverContext {
  readonly context: Chord.Context;
  readonly session: (externalId: string) => Promise<Durable.Harness | undefined>;
  readonly sessions: () => Promise<readonly string[]>;
  readonly models: () => Models;
}
