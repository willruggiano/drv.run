import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { model } from "../../pi-runtime/testing.ts";
import { sessionInfo } from "../../pi-runtime/index.ts";
import { directoryFixture, post, serve } from "./testing.ts";

const context = BACKGROUND_CONTEXT;

await test("HTTP base directory is stored in Durable cwd, validates input, and defaults to /workspace", async (t) => {
  const f = await directoryFixture(t, "/workspace");
  const base = await serve(t, f.sessions);
  const create = (baseDirectory?: unknown) =>
    post(base + "/api/sessions", {
      id: randomUUID(),
      binding: f.binding,
      model,
      baseDirectory,
    });
  for (const input of [undefined, "", "foo", "/foo", "/foo/"]) {
    const response = await create(input);
    assert.equal(response.status, 201);
    const info = await response.json();
    const session = await f.sessions.get(info.id);
    assert.equal(info.cwd, input ? "/workspace/foo" : "/workspace");
    assert.equal((await session.root.agent(context)).cwd, info.cwd);
  }
  for (const input of [null, 1, {}, "../etc", "a\nb", "x".repeat(4097)])
    assert.equal((await create(input)).status, 400);
  const info = await (await create("one")).json();
  const configure = (cwd?: unknown) => post(`${base}/api/harness/${info.id}/configure`, { cwd });
  const session = await f.sessions.get(info.id);
  assert.equal((await configure()).status, 200);
  assert.equal((await session.root.agent(context)).cwd, "/workspace/one");
  assert.equal((await configure("/workspace/two")).status, 200);
  assert.equal((await session.root.agent(context)).cwd, "/workspace/two");
  assert.equal((await configure(123)).status, 400);
  assert.equal((await configure(null)).status, 200);
  assert.equal((await session.root.agent(context)).cwd, undefined);
  assert.equal((await configure("/workspace")).status, 200);
  assert.deepEqual((await sessionInfo(session)).binding, f.binding);
  for (const query of [null, 3, "../", "/../", "\0", "x".repeat(4097)])
    assert.equal(
      (await post(base + "/api/directories", { binding: f.binding, query })).status,
      400,
    );
  f.stop();
  assert.equal(
    (await post(base + "/api/directories", { binding: f.binding, query: "" })).status,
    409,
  );
  assert.equal(f.connections, 0, "validation does not connect or execute tools");
});
