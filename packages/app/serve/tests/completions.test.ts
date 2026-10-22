import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fixture } from "./sessions-testing.ts";
import {
  commandCompletions,
  completionToken,
  directoryCompletion,
  pathCompletion,
} from "../completions.ts";
import { serve } from "./testing.ts";

await test("completion tokens respect boundaries, quoting and cursor position", () => {
  for (const text of [
    "email@example.com",
    "https://example.com",
    "explain /model",
    "hello",
    '@"done"',
    "/model ",
  ])
    assert.equal(completionToken(text, text.length), undefined, text);
  assert.deepEqual(completionToken("inspect @src/file.ts please", 12), {
    kind: "path",
    query: "src",
    start: 8,
    end: 20,
  });
  assert.deepEqual(completionToken("/model", 3), {
    kind: "command",
    query: "mo",
    start: 0,
    end: 6,
  });
  const text = 'read @"a b/c';
  assert.deepEqual(completionToken(text, text.length), {
    kind: "path",
    query: "a b/c",
    start: 5,
    end: text.length,
  });
  const unfinished = '@"a trailing\\';
  assert.deepEqual(completionToken(unfinished, 3), {
    kind: "path",
    query: "a",
    start: 0,
    end: unfinished.length,
  });
  assert.equal(pathCompletion("a b/").value, '@"a b/');
  assert.equal(pathCompletion('a"b.txt').value, '@"a\\"b.txt" ');
  assert.equal(pathCompletion("src/").value, "@src/");
  assert.equal(pathCompletion("src/file.ts").value, "@src/file.ts ");
  assert.deepEqual(
    commandCompletions("MO").map((item) => item.value),
    ["/model "],
  );
  assert.deepEqual(
    commandCompletions("review").map((item) => item.value),
    ["/review "],
  );
  assert.deepEqual(commandCompletions("endreview"), []);
  assert.deepEqual(
    commandCompletions("endreview", true).map((item) => item.value),
    ["/endreview "],
  );
  assert.deepEqual(commandCompletions("unknown"), []);
  assert.deepEqual(commandCompletions("help"), []);
});

await test("HTTP path completion uses the session workspace and validates paths", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.workspace, "src"));
  await writeFile(join(f.workspace, "src", "example.ts"), "example");
  await writeFile(join(f.workspace, "space name.txt"), "example");
  await writeFile(join(f.workspace, ".hidden"), "hidden");
  const session = await f.create();
  const base = await serve(t, f.sessions);
  const complete = (query: string) =>
    fetch(`${base}/api/sessions/${session.id}/completions?query=${encodeURIComponent(query)}`);
  assert.deepEqual(await (await complete("")).json(), ["space name.txt", "src/"]);
  assert.deepEqual(await (await complete("SRC/e")).json(), []);
  assert.deepEqual(await (await complete("src/E")).json(), ["src/example.ts"]);
  assert.deepEqual(await (await complete(".")).json(), [".hidden"]);
  assert.deepEqual(await (await complete("absent/")).json(), []);
  for (const query of ["../", "src/../../", "/etc/", "\0", "x".repeat(4097)])
    assert.equal((await complete(query)).status, 400, query);
  assert.equal(f.faux.state.callCount, 0);
  await f.reopen({ env: undefined, targets: async () => [] });
  // A missing integration must not fall back to reading the web server's cwd.
  const unavailableBase = await serve(t, f.sessions);
  assert.equal(
    (await fetch(`${unavailableBase}/api/sessions/${session.id}/completions`)).status,
    409,
  );
});

await test("cd completion covers the directory argument, including spaces and mid-path cursors", () => {
  assert.deepEqual(
    commandCompletions("cd").map((item) => item.value),
    ["/cd "],
  );
  for (const path of ["", "../", "/workspace/drv.run", "~/", "space name/", 'a"b/']) {
    const text = `/cd ${path}`;
    assert.deepEqual(completionToken(text, text.length), {
      kind: "directory",
      query: path,
      start: 4,
      end: text.length,
    });
    assert.deepEqual(directoryCompletion(path), { label: path, value: path });
  }
  assert.deepEqual(completionToken("/cd directory/nested", 8), {
    kind: "directory",
    query: "dire",
    start: 4,
    end: 20,
  });
  assert.equal(completionToken("explain /cd ../", 15), undefined);
});
