import { randomUUID } from "node:crypto";
import { isJsonValue } from "@earendil-works/chord/json";
import type * as D from "@earendil-works/pi-durable";
import { StorageRequestError } from "@earendil-works/pi-durable";
import { context } from "./application.ts";
import { decode, EntryId, InvalidRequest } from "./identity.ts";

export type History = {
  query: Omit<D.EntryQuery, "conversationId">;
  cursor?: D.Cursor;
  // A disposable placeholder identity, not a conversation revision or replay cursor.
  projection: string;
};

export function historyQuery(params: URLSearchParams): History {
  const minEntryId = params.has("minEntryId")
    ? decode(EntryId, params.get("minEntryId"))
    : undefined;
  const maxEntryId = params.has("maxEntryId")
    ? decode(EntryId, params.get("maxEntryId"))
    : undefined;
  if (minEntryId !== undefined && maxEntryId !== undefined && minEntryId > maxEntryId)
    throw new InvalidRequest("Invalid history interval.");
  const order = params.get("order");
  if (order !== null && order !== "ascending" && order !== "descending")
    throw new InvalidRequest("Invalid history order.");
  const query: History["query"] = {
    ...(minEntryId === undefined ? {} : { minEntryId }),
    ...(maxEntryId === undefined ? {} : { maxEntryId }),
    ...(order === null ? {} : { order }),
  };
  const projection = params.get("projection") ?? randomUUID();
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(projection))
    throw new InvalidRequest("Invalid history placeholder.");
  const encoded = params.get("cursor");
  if (encoded === null) return { query, projection };
  if (encoded.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(encoded))
    throw new InvalidRequest("Invalid history cursor.");
  let cursor: unknown;
  try {
    const json = Buffer.from(encoded, "base64url").toString("utf8");
    if (Buffer.from(json).toString("base64url") !== encoded)
      throw new InvalidRequest("Invalid history cursor.");
    cursor = JSON.parse(json);
  } catch (error) {
    if (error instanceof SyntaxError) throw new InvalidRequest("Invalid history cursor.");
    throw error;
  }
  if (
    !isJsonValue(cursor) ||
    cursor === null ||
    typeof cursor !== "object" ||
    Array.isArray(cursor)
  )
    throw new InvalidRequest("Invalid history cursor.");
  return { query, projection, cursor };
}

export function historyParams({ query, cursor, projection }: History): URLSearchParams {
  const params = new URLSearchParams({ projection });
  for (const key of ["minEntryId", "maxEntryId", "order"] as const)
    if (query[key] !== undefined) params.set(key, String(query[key]));
  if (cursor !== undefined)
    params.set("cursor", Buffer.from(JSON.stringify(cursor)).toString("base64url"));
  return params;
}

export async function readHistory(conversation: D.Conversation, { query, cursor }: History) {
  try {
    if (cursor) {
      // Pi 1.5.2 cursors locate an entry but do not bind it to a query/store.
      // Check membership through the fork-aware read; pass the native cursor on unchanged.
      if (typeof cursor.after !== "number") throw new InvalidRequest("Invalid history cursor.");
      const at = decode(EntryId, String(cursor.after));
      if (
        (query.minEntryId !== undefined && at < query.minEntryId) ||
        (query.maxEntryId !== undefined && at > query.maxEntryId)
      )
        throw new InvalidRequest("Cursor is outside this history interval.");
      const anchor = await conversation.entries(
        { minEntryId: at, maxEntryId: at },
        1,
        undefined,
        context,
      );
      if (!anchor.items.length) throw new InvalidRequest("Cursor is outside this conversation.");
    }
    return await conversation.entries(query, 50, cursor, context);
  } catch (error) {
    if (error instanceof StorageRequestError)
      throw new InvalidRequest("Invalid history request.", { cause: error });
    throw error;
  }
}
