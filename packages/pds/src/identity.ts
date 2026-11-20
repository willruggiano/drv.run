import type * as D from "@earendil-works/pi-durable";
import { Type, type StaticDecode, type TSchema } from "typebox";
import * as Value from "typebox/value";

export class InvalidRequest extends Error {}

// Validate before TypeBox's codec pipeline can convert or clean the input.
export function decode<T extends TSchema>(schema: T, value: unknown): StaticDecode<T> {
  try {
    Value.Assert(schema, value);
    return Value.Decode(schema, value);
  } catch (error) {
    if (error instanceof Value.AssertError)
      throw new InvalidRequest("Invalid request.", { cause: error });
    throw error;
  }
}

const DecimalId = Type.Refine(
  Type.String(),
  (value) => {
    const id = Number(value);
    return Number.isSafeInteger(id) && id >= 0 && String(id) === value;
  },
  () => "Use a nonnegative safe decimal integer.",
);

// The wire representation establishes the upstream brand, not record existence.
export const ConversationId = Type.Codec(DecimalId)
  .Decode((value) => Number(value) as D.ConversationId)
  .Encode(String);
export const EntryId = Type.Codec(DecimalId)
  .Decode((value) => Number(value) as D.EntryId)
  .Encode(String);
export const TaskId = Type.Codec(DecimalId)
  .Decode((value) => Number(value) as D.TaskId)
  .Encode(String);

declare const sessionBrand: unique symbol;
export type SessionId = string & { readonly [sessionBrand]: "id" };
export type SessionKey = string & { readonly [sessionBrand]: "key" };

export const SessionId = Type.Unsafe<SessionId>(
  Type.Refine(
    Type.String({ minLength: 1 }),
    (id) => {
      if (!id.isWellFormed() || Buffer.byteLength(id) > 128 || id === "." || id === "..")
        return false;
      for (const character of id) {
        const code = character.codePointAt(0)!;
        if (code < 32 || code === 127) return false;
      }
      return true;
    },
    () => "Session IDs must be 1–128 UTF-8 bytes without control characters or URL dot segments.",
  ),
);

// A canonical directory name encodes one exact session identity.
export const SessionKey = Type.Codec(
  Type.Unsafe<SessionKey>(
    Type.Refine(Type.String(), (key) => {
      const id = Buffer.from(key, "base64url").toString("utf8");
      return Value.Check(SessionId, id) && Buffer.from(id).toString("base64url") === key;
    }),
  ),
)
  .Decode((key) => Value.Parse(SessionId, Buffer.from(key, "base64url").toString("utf8")))
  .Encode((id) => Buffer.from(id).toString("base64url") as SessionKey);
