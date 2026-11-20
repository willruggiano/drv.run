import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ConversationId as DurableConversationId,
  EntryId as DurableEntryId,
  TaskId as DurableTaskId,
} from "@earendil-works/pi-durable";
import type { Static, StaticDecode } from "typebox";
import * as Value from "typebox/value";
import type { Application, Session } from "../src/application.ts";
import {
  ConversationId,
  EntryId,
  TaskId,
  SessionId,
  SessionKey,
  decode,
  InvalidRequest,
} from "../src/identity.ts";

await test("address codecs retain distinct upstream and session identity brands", () => {
  const compatible: [
    StaticDecode<typeof ConversationId> extends DurableConversationId ? true : false,
    StaticDecode<typeof EntryId> extends DurableEntryId ? true : false,
    StaticDecode<typeof TaskId> extends DurableTaskId ? true : false,
    StaticDecode<typeof TaskId> extends DurableConversationId ? false : true,
    number extends StaticDecode<typeof ConversationId> ? false : true,
    string extends SessionId ? false : true,
    SessionId extends SessionKey ? false : true,
    Static<typeof SessionKey> extends SessionKey ? true : false,
    StaticDecode<typeof SessionKey> extends SessionId ? true : false,
    string extends Parameters<Application["open"]>[0] ? false : true,
    string extends Parameters<Application["get"]>[0] ? false : true,
    number extends Parameters<Session["conversation"]>[0] ? false : true,
  ] = [true, true, true, true, true, true, true, true, true, true, true, true];
  assert(compatible.every(Boolean));
});

await test("record ID codecs accept complete safe decimal addresses without coercing input types", () => {
  for (const schema of [ConversationId, EntryId, TaskId]) {
    for (const id of [0, 1, Number.MAX_SAFE_INTEGER]) {
      assert.equal(decode(schema, String(id)), id);
      assert.equal(Value.Encode(schema, decode(schema, String(id))), String(id));
    }
    for (const input of [
      "",
      "-1",
      "1e0",
      "0x0",
      "0.0",
      "00",
      " 0",
      "0 ",
      "0\n",
      "+1",
      "1tail",
      "9007199254740992",
      "NaN",
      "Infinity",
      0,
      1,
      null,
      undefined,
      false,
      [],
      {},
    ])
      assert.throws(
        () => decode(schema, input),
        (error: unknown) =>
          error instanceof InvalidRequest && error.cause instanceof Value.AssertError,
      );
  }
});

await test("session IDs preserve exact bounded Unicode identity and round-trip through storage keys", () => {
  for (const value of [
    "open",
    "../λ/owner ' & % session",
    "x".repeat(128),
    "λ".repeat(64),
    " padded ",
    "é",
    "e\u0301",
  ]) {
    const id = decode(SessionId, value);
    const key = Value.Encode(SessionKey, id);
    assert.equal(id, value);
    assert.equal(decode(SessionKey, key), id);
    assert.equal(key, Buffer.from(value).toString("base64url"));
  }
  for (const value of [
    "",
    ".",
    "..",
    "x".repeat(129),
    "λ".repeat(65),
    "\0",
    "line\nfeed",
    "\x7f",
    "\ud800",
    1,
    null,
    false,
  ])
    assert.throws(() => decode(SessionId, value), InvalidRequest);
});

await test("storage key decoding rejects aliases, invalid UTF-8, and invalid session identities", () => {
  const key = Value.Encode(SessionKey, decode(SessionId, "session"));
  for (const value of [
    `${key}=`,
    `${key}\n`,
    `/${key}`,
    "",
    "_w",
    Buffer.from(".").toString("base64url"),
    Buffer.from("x".repeat(129)).toString("base64url"),
    1,
    null,
  ])
    assert.throws(() => decode(SessionKey, value), InvalidRequest);
});
