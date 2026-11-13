import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, type TestContext } from "node:test";
import { setImmediate as turn } from "node:timers/promises";
import { BACKGROUND_CONTEXT as context, type Context } from "@earendil-works/chord/context";
import { appendText, applyImmutable, type Op } from "@earendil-works/chord/delta";
import type { WatchEnd } from "@earendil-works/chord/watch";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  Harness,
  MemoryStorage,
  ProviderDoc,
  AgentDoc,
  ROOT_CONVERSATION_ID,
  createRegistry,
  type Conversation,
  type ConversationId,
  type ConversationView,
  type EntryRecord,
  type Tx,
  type CommitOptions,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Problem } from "../src/problem.ts";
import { Sessions } from "../src/sessions.ts";
import { watch } from "./watch.ts";

type State = { readonly view: ConversationView; readonly head: EntryRecord | null };
const gate = () => ({
  entered: Promise.withResolvers<void>(),
  release: Promise.withResolvers<void>(),
});
class MeasuredStorage extends MemoryStorage {
  writes = 0;
  scans: number[] = [];
  rows = 0;
  hold: ReturnType<typeof gate> | undefined;
  override async commit(...args: Parameters<MemoryStorage["commit"]>) {
    this.writes++;
    const hold = this.hold;
    this.hold = undefined;
    if (hold) {
      hold.entered.resolve();
      await hold.release.promise;
    }
    return super.commit(...args);
  }
  override async scanEntries(...args: Parameters<MemoryStorage["scanEntries"]>) {
    this.scans.push(args[1]);
    const page = await super.scanEntries(...args);
    this.rows += page.items.length;
    return page;
  }
}
function track(t: TestContext, harness: Harness) {
  let attached = 0;
  const detached = Promise.withResolvers<void>();
  const observe = harness.observeConversation.bind(harness);
  t.mock.method(harness, "observeConversation", async (...args: Parameters<typeof observe>) => {
    const observation = await observe(...args);
    attached++;
    let active = true;
    return {
      value: observation.value,
      detach() {
        if (active) {
          active = false;
          attached--;
          detached.resolve();
        }
        observation.detach();
      },
    };
  });
  return {
    get attached() {
      return attached;
    },
    detached: detached.promise,
  };
}
async function setup(t: TestContext, readOnly = false) {
  const storage = new MeasuredStorage();
  const models = createModels();
  if (readOnly) {
    await storage.commit(
      [[{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }]],
      () => {},
      context,
    );
  }
  const harness = await Harness.open(
    storage,
    { models, registry: createRegistry(), readOnly },
    context,
  );
  const root = readOnly
    ? (await harness.conversation(ROOT_CONVERSATION_ID, context))!
    : await harness.root(context);
  const sessions = new Sessions(async (id, ctx, create) => {
    assert.equal(create, false);
    assert.equal(ctx.abortSignal, undefined);
    return id === "test" ? harness : undefined;
  });
  t.after(() => sessions.close(Promise.resolve()));
  t.after(() => harness.close(context));
  const tracking = track(t, harness);
  const ends: WatchEnd[] = [];
  const query = { externalId: "test", conversationId: root.id };
  const options = {
    sessions,
    window: { min: 3, max: 5 },
    onEnd: (end: WatchEnd) => {
      ends.push(end);
    },
  };
  const acquire = async (
    signal = new AbortController().signal,
    window = options.window,
    conversationId = root.id,
  ) => {
    const stream = await watch({ ...query, conversationId }, signal, { ...options, window });
    t.after(() => {
      if (!stream.locked) return stream.cancel();
    });
    return stream;
  };
  return { storage, harness, root, sessions, query, options, acquire, tracking, ends, models };
}
async function notes(root: Conversation, count: number) {
  return root.commit(async (tx) => {
    const entries: EntryRecord[] = [];
    for (let i = 0; i < count; i++)
      entries.push(await tx.appendEntry(root.id, { kind: "note", data: i }));
    return entries;
  }, context);
}
function marker(root: Conversation, head: EntryRecord["id"] | "self" = "self") {
  return root.commit((tx) => tx.appendEntry(root.id, { kind: "marker", head }), context);
}
function replica(t: TestContext, stream: ReadableStream<readonly Op[]>) {
  const reader = stream.getReader();
  t.after(() => reader.cancel());
  let state: State | undefined;
  return {
    reader,
    async next() {
      const { done, value: ops } = await reader.read();
      assert.equal(done, false);
      assert(ops);
      if (!state) {
        assert.equal(ops.length, 1);
        assert.equal(ops[0]![0], "r");
      }
      state = applyImmutable<State>(state, ops);
      return { state, ops };
    },
  };
}
async function consistent(harness: Harness, root: Conversation, state: State) {
  assert.deepEqual(
    state.head,
    (await root.commit((tx) => tx.latestHeadMarker(root.id), context)) ?? null,
  );
  assert.deepEqual(
    state.view.docs["pi.provider"],
    await harness.snapshot(ProviderDoc, root.id, context),
  );
  const ids = state.view.entries.map((entry) => entry.id);
  assert.deepEqual(
    ids,
    [...ids].sort((a, b) => a - b),
  );
}

void describe("watch", { timeout: 30_000 }, () => {
  void test("bounded acquisition reads no full context, writes nothing, and never starts execution", async (t) => {
    const f = await setup(t);
    const entries = await notes(f.root, 1000);
    const head = await marker(f.root, entries[900]!.id);
    await notes(f.root, 20);
    f.storage.scans = [];
    f.storage.rows = 0;
    const writes = f.storage.writes;
    const client = replica(t, await f.acquire());
    const { state } = await client.next();
    assert.deepEqual(f.storage.scans, [4]);
    assert.equal(f.storage.rows, 4);
    assert.equal(f.storage.writes, writes);
    assert.equal(state.head?.id, head.id);
    assert.equal(state.view.entries.length, 3);
    assert.equal((await f.harness.inspect(context)).scheduling, "paused");
    await consistent(f.harness, f.root, state);
    await client.reader.cancel();
    assert.equal(f.tracking.attached, 0);
    assert.deepEqual(f.ends, [{ kind: "stopped" }]);
  });

  void test("default windows start at 50, grow to 100, and shrink back to 50", async (t) => {
    const f = await setup(t);
    await notes(f.root, 80);
    const client = replica(
      t,
      await watch(f.query, new AbortController().signal, {
        sessions: f.sessions,
        onEnd: f.options.onEnd,
      }),
    );
    assert.equal((await client.next()).state.view.entries.length, 50);
    await notes(f.root, 50);
    assert.equal((await client.next()).state.view.entries.length, 100);
    await notes(f.root, 1);
    assert.equal((await client.next()).state.view.entries.length, 50);
    await client.reader.cancel();
    const custom = replica(
      t,
      await watch(f.query, new AbortController().signal, {
        ...f.options,
        window: { min: 2 },
      }),
    );
    await custom.next();
    await notes(f.root, 2);
    assert.equal((await custom.next()).state.view.entries.length, 4);
    await notes(f.root, 1);
    assert.equal((await custom.next()).state.view.entries.length, 2);
  });

  void test("missing resources and invalid native window settings fail acquisition", async (t) => {
    const f = await setup(t);
    for (const query of [
      { ...f.query, externalId: "missing" },
      { ...f.query, conversationId: 999 as ConversationId },
    ]) {
      await assert.rejects(
        watch(query, new AbortController().signal, f.options),
        (error: unknown) => error instanceof Problem && error.status === 404,
      );
    }
    for (const window of [
      { min: 0 },
      { min: 1.5 },
      { min: NaN },
      { min: 3, max: 2 },
      { max: Infinity },
    ]) {
      await assert.rejects(
        watch(f.query, new AbortController().signal, { ...f.options, window }),
        RangeError,
      );
    }
    assert.equal(f.tracking.attached, 0);
  });

  void test("observations before attachment resolves are retained, including an evicted reset", async (t) => {
    const f = await setup(t);
    const observe = f.harness.observeConversation.bind(f.harness);
    let head: EntryRecord | undefined;
    t.mock.method(f.harness, "observeConversation", async (...args: Parameters<typeof observe>) => {
      const observation = await observe(...args);
      head = await marker(f.root);
      await notes(f.root, 12);
      return observation;
    });
    const client = replica(t, await f.acquire());
    const { state } = await client.next();
    assert.deepEqual(state.head, head);
    assert(state.view.entries.every((entry) => entry.id > head!.id));
    await consistent(f.harness, f.root, state);
  });

  void test("an outstanding entry/document commit cannot split the acquisition baseline", async (t) => {
    const f = await setup(t);
    const hold = gate();
    t.after(() => hold.release.resolve());
    const observe = f.harness.observeConversation.bind(f.harness);
    let writing: Promise<EntryRecord> | undefined;
    t.mock.method(f.harness, "observeConversation", async (...args: Parameters<typeof observe>) => {
      const observation = await observe(...args);
      f.storage.hold = hold;
      writing = f.root.commit(async (tx) => {
        (await tx.doc(ProviderDoc, f.root.id)).sessionId = "atomic";
        return tx.appendEntry(f.root.id, { kind: "reset", head: "self" });
      }, context);
      await hold.entered.promise;
      return observation;
    });
    let settled = false;
    const acquiring = f.acquire().then((stream) => {
      settled = true;
      return stream;
    });
    await hold.entered.promise;
    await turn();
    assert.equal(settled, false);
    hold.release.resolve();
    const client = replica(t, await acquiring);
    const { state } = await client.next();
    assert.deepEqual(state.head, await writing);
    assert.equal(state.view.docs["pi.provider"]!.sessionId, "atomic");
    await consistent(f.harness, f.root, state);
  });

  void test("atomic live updates keep a marker evicted by its own commit", async (t) => {
    const f = await setup(t);
    const client = replica(t, await f.acquire());
    await client.next();
    const head = await f.root.commit(async (tx) => {
      (await tx.doc(ProviderDoc, f.root.id)).sessionId = "same-commit";
      const head = await tx.appendEntry(f.root.id, { kind: "reset", head: "self" });
      for (let i = 0; i < 20; i++) await tx.appendEntry(f.root.id, { kind: "note" });
      return head;
    }, context);
    const { state } = await client.next();
    assert.deepEqual(state.head, head);
    assert(!state.view.entries.some((entry) => entry.id === head.id));
    assert.equal(state.view.docs["pi.provider"]!.sessionId, "same-commit");
    await consistent(f.harness, f.root, state);
  });

  void test("compaction and backwards head writes preserve chronological entries", async (t) => {
    const f = await setup(t);
    const entries = await notes(f.root, 5);
    const client = replica(t, await f.acquire(undefined, { min: 10, max: 20 }));
    await client.next();
    const head = await marker(f.root, entries[3]!.id);
    const first = (await client.next()).state;
    assert.deepEqual(first.head, head);
    assert.deepEqual(first.view.entries, [...entries, head]);
    const backwards = await marker(f.root, entries[0]!.id);
    const second = (await client.next()).state;
    assert.deepEqual(second.head, backwards);
    assert.deepEqual(second.view.entries, [...entries, head, backwards]);
    await consistent(f.harness, f.root, second);
  });

  void test("forks inherit the head at their cutoff, not later parent resets", async (t) => {
    const f = await setup(t);
    const entries = await notes(f.root, 5);
    const head = await marker(f.root, entries[2]!.id);
    const [cutoff] = await notes(f.root, 1);
    const fork = await f.root.fork(cutoff!.id, { ownership: { kind: "ownerless" } }, context);
    await marker(f.root);
    const client = replica(t, await f.acquire(undefined, undefined, fork.id));
    assert.deepEqual((await client.next()).state.head, head);
    await marker(f.root);
    const [entry] = await notes(fork, 1);
    const { state } = await client.next();
    assert.deepEqual(state.head, head);
    assert.deepEqual(state.view.entries.at(-1), entry);
    await consistent(f.harness, fork, state);
  });

  void test("slow consumers fold changes and recover after pending-operation overflow", async (t) => {
    const f = await setup(t);
    const client = replica(t, await f.acquire(undefined, { min: 2, max: 3 }));
    await client.next();
    await notes(f.root, 1);
    await client.next();
    const head = await marker(f.root);
    for (let i = 0; i < 6000; i++) await notes(f.root, 1);
    const { state, ops } = await client.next();
    assert.equal(ops[0]![0], "r");
    assert.deepEqual(state.head, head);
    assert(state.view.entries.length <= 5);
    await consistent(f.harness, f.root, state);
    await notes(f.root, 1);
    const resumed = await client.next();
    assert.notEqual(resumed.ops[0]![0], "r");
    await consistent(f.harness, f.root, resumed.state);
  });

  void test("reconnect takes a fresh bounded baseline without backfill", async (t) => {
    const f = await setup(t);
    await notes(f.root, 10);
    const first = replica(t, await f.acquire());
    await first.next();
    await first.reader.cancel();
    const head = await marker(f.root);
    await notes(f.root, 20);
    f.storage.scans = [];
    const second = replica(t, await f.acquire());
    assert.deepEqual((await second.next()).state.head, head);
    assert.deepEqual(f.storage.scans, [4]);
  });

  void test("deferred document changes arrive before storage receives them", async (t) => {
    const f = await setup(t);
    const client = replica(t, await f.acquire());
    await client.next();
    const writes = f.storage.writes;
    await f.root.commit(
      async (tx) => {
        (await tx.doc(ProviderDoc, f.root.id)).sessionId = "deferred";
      },
      context,
      { persistence: { kind: "deferred", withinMs: Infinity } },
    );
    assert.equal((await client.next()).state.view.docs["pi.provider"]!.sessionId, "deferred");
    assert.equal(f.storage.writes, writes);
  });

  void test("abort before acquisition or while opening never owns the shared Harness", async (t) => {
    const f = await setup(t);
    const controller = new AbortController();
    const reason = new Error("disconnect");
    controller.abort(reason);
    const get = t.mock.method(f.sessions, "get");
    await assert.rejects(f.acquire(controller.signal), (error) => error === reason);
    assert.equal(get.mock.callCount(), 0);
    const hold = gate();
    t.after(() => hold.release.resolve());
    const sessions = new Sessions(async (_id, ctx, create) => {
      assert.equal(ctx.abortSignal, undefined);
      assert.equal(create, false);
      hold.entered.resolve();
      await hold.release.promise;
      return f.harness;
    });
    t.after(() => sessions.close(Promise.resolve()));
    const pending = new AbortController();
    const acquiring = watch(f.query, pending.signal, { ...f.options, sessions });
    await hold.entered.promise;
    pending.abort(reason);
    await assert.rejects(acquiring, (error) => error === reason);
    hold.release.resolve();
    assert.equal(await sessions.get("test"), f.harness);
    assert.equal(f.tracking.attached, 0);
    await notes(f.root, 1);
  });

  void test("abort before attachment returns detaches its late observation", async (t) => {
    const f = await setup(t);
    const observe = f.harness.observeConversation.bind(f.harness);
    const controller = new AbortController();
    t.mock.method(f.harness, "observeConversation", async (...args: Parameters<typeof observe>) => {
      const observation = await observe(...args);
      controller.abort();
      return observation;
    });
    await assert.rejects(
      f.acquire(controller.signal),
      (error) => error === controller.signal.reason,
    );
    assert.equal(f.tracking.attached, 0);
  });

  void test("abort detaches immediately while a head read is blocked", async (t) => {
    const f = await setup(t, true);
    const hold = gate();
    t.after(() => hold.release.resolve());
    const find = f.storage.findLatestHeadMarker.bind(f.storage);
    t.mock.method(f.storage, "findLatestHeadMarker", async (...args: Parameters<typeof find>) => {
      hold.entered.resolve();
      await hold.release.promise;
      return find(...args);
    });
    const controller = new AbortController();
    let settled = false;
    const acquiring = f.acquire(controller.signal).finally(() => {
      settled = true;
    });
    const rejected = assert.rejects(acquiring, (error) => error === controller.signal.reason);
    await hold.entered.promise;
    assert.equal(f.tracking.attached, 1);
    controller.abort();
    assert.equal(f.tracking.attached, 0);
    await turn();
    assert.equal(settled, false);
    hold.release.resolve();
    await rejected;
  });

  void test("Session close during a pending head read fails acquisition and detaches", async (t) => {
    const f = await setup(t, true);
    const hold = gate();
    t.after(() => hold.release.resolve());
    const find = f.storage.findLatestHeadMarker.bind(f.storage);
    t.mock.method(f.storage, "findLatestHeadMarker", async (...args: Parameters<typeof find>) => {
      hold.entered.resolve();
      await hold.release.promise;
      return find(...args);
    });
    const acquiring = f.acquire();
    const rejected = assert.rejects(
      acquiring,
      (error: unknown) => error instanceof Problem && error.status === 503,
    );
    await hold.entered.promise;
    const closing = f.harness.close(context);
    await f.tracking.detached;
    hold.release.resolve();
    await rejected;
    await closing;
    assert.equal(f.tracking.attached, 0);
  });

  void test("Session close after baseline capture but before commit returns fails acquisition", async (t) => {
    const f = await setup(t);
    t.mock.method(f.harness, "conversation", async () => f.root);
    const commit = f.root.commit.bind(f.root);
    t.mock.method(
      f.root,
      "commit",
      async <T>(change: (tx: Tx) => T | Promise<T>, ctx: Context, options?: CommitOptions) => {
        const result = await commit(change, ctx, options);
        await f.harness.close(context);
        return result;
      },
    );
    await assert.rejects(
      f.acquire(),
      (error: unknown) => error instanceof Problem && error.status === 503,
    );
    assert.equal(f.tracking.attached, 0);
  });

  void test("changes after baseline capture are delivered as updates, not mixed into the baseline", async (t) => {
    const f = await setup(t);
    t.mock.method(f.harness, "conversation", async () => f.root);
    const commit = f.root.commit.bind(f.root);
    let head: EntryRecord | undefined;
    t.mock.method(
      f.root,
      "commit",
      async <T>(change: (tx: Tx) => T | Promise<T>, ctx: Context, options?: CommitOptions) => {
        const result = await commit(change, ctx, options);
        head = await commit(async (tx) => {
          (await tx.doc(ProviderDoc, f.root.id)).sessionId = "after-baseline";
          return tx.appendEntry(f.root.id, { kind: "reset", head: "self" });
        }, context);
        return result;
      },
    );
    const client = replica(t, await f.acquire());
    const baseline = (await client.next()).state;
    assert.equal(baseline.head, null);
    assert.deepEqual(baseline.view.entries, []);
    assert.notEqual(baseline.view.docs["pi.provider"]!.sessionId, "after-baseline");
    const updated = (await client.next()).state;
    assert.deepEqual(updated.head, head);
    assert.deepEqual(updated.view.entries, [head]);
    assert.equal(updated.view.docs["pi.provider"]!.sessionId, "after-baseline");
  });

  void test("a failed head read releases the observation", async (t) => {
    const f = await setup(t, true);
    const reason = new Error("head read failed");
    t.mock.method(f.storage, "findLatestHeadMarker", async () => {
      throw reason;
    });
    await assert.rejects(f.acquire(), (error) => error === reason);
    assert.equal(f.tracking.attached, 0);
  });

  void test("cancellation and request abort release pending reads without closing the Harness", async (t) => {
    for (const abort of [false, true]) {
      const f = await setup(t);
      const controller = new AbortController();
      const client = replica(t, await f.acquire(controller.signal));
      await client.next();
      const pending = client.reader.read();
      if (abort) controller.abort();
      else await client.reader.cancel();
      assert.deepEqual(await pending, { done: true, value: undefined });
      assert.equal(f.tracking.attached, 0);
      await client.reader.cancel();
      await notes(f.root, 1);
      assert.equal((await f.harness.inspect(context)).scheduling, "paused");
      assert.deepEqual(f.ends, [{ kind: abort ? "aborted" : "stopped" }]);
    }
  });

  void test("consumer failure cancels delivery without failing the Harness", async (t) => {
    const f = await setup(t);
    const stream = await f.acquire();
    const reason = new Error("consumer failed");
    await assert.rejects(
      stream.pipeTo(
        new WritableStream({
          write() {
            throw reason;
          },
        }),
      ),
      (error) => error === reason,
    );
    assert.equal(f.tracking.attached, 0);
    await notes(f.root, 1);
    assert.deepEqual(f.ends, [{ kind: "stopped" }]);
  });

  void test("Session close ends delivery without a terminal frame or a storage-failure claim", async (t) => {
    const f = await setup(t);
    const client = replica(t, await f.acquire());
    await client.next();
    const pending = client.reader.read();
    await f.harness.close(context);
    assert.deepEqual(await pending, { done: true, value: undefined });
    assert.equal(f.tracking.attached, 0);
    assert.equal(f.ends.length, 1);
    assert.equal(f.ends[0]!.kind, "failed");
    assert.deepEqual(await f.harness.closed, { kind: "closed" });
  });

  void test("independent windows and cancellation do not interfere", async (t) => {
    const f = await setup(t);
    await notes(f.root, 20);
    const small = replica(t, await f.acquire(undefined, { min: 2, max: 3 }));
    const large = replica(t, await f.acquire(undefined, { min: 7, max: 10 }));
    await small.next();
    await large.next();
    const head = await marker(f.root);
    await notes(f.root, 20);
    assert.equal((await small.next()).state.view.entries.length, 2);
    const state = (await large.next()).state;
    assert.equal(state.view.entries.length, 7);
    assert.deepEqual(state.head, head);
    await small.reader.cancel();
    assert.equal(f.tracking.attached, 1);
    await notes(f.root, 1);
    await consistent(f.harness, f.root, (await large.next()).state);
  });

  void test("document text edits, removals, and array reorderings replay under view", async (t) => {
    const f = await setup(t);
    await f.root.commit(async (tx) => {
      Object.assign(await tx.doc(AgentDoc, f.root.id), {
        instructions: "prefix".repeat(100) + "old",
        tools: ["one", "two", "three"],
        cwd: "/workspace",
      });
    }, context);
    const client = replica(t, await f.acquire());
    await client.next();
    await f.root.commit(async (tx) => {
      appendText(await tx.doc(ProviderDoc, f.root.id), "sessionId", " appended");
    }, context);
    let state = (await client.next()).state;
    await consistent(f.harness, f.root, state);
    await f.root.commit(async (tx) => {
      const agent = await tx.doc(AgentDoc, f.root.id);
      agent.instructions = agent.instructions!.slice(6) + "new";
      assert(Array.isArray(agent.tools));
      agent.tools.reverse();
      delete agent.cwd;
    }, context);
    state = (await client.next()).state;
    assert.deepEqual(
      state.view.docs["pi.agent"],
      await f.harness.snapshot(AgentDoc, f.root.id, context),
    );
  });

  void test("a completed answer updates state without ending delivery", async (t) => {
    const f = await setup(t);
    const faux = fauxProvider({ models: [{ id: "test" }] });
    faux.setResponses([fauxAssistantMessage("answer")]);
    f.models.setProvider(faux.provider);
    await f.root.configure({ model: { provider: "faux", modelId: "test" } }, context);
    const client = replica(t, await f.acquire());
    await client.next();
    const submission = await f.root.submit({ type: "input", content: "question" }, context);
    const answer = await submission.wait(context);
    await f.root.waitForIdle(context);
    assert.equal(answer.status, "done");
    const { state } = await client.next();
    assert.equal(state.view.entries.at(-1)?.id, answer.answer);
    const [entry] = await notes(f.root, 1);
    assert.deepEqual((await client.next()).state.view.entries.at(-1), entry);
    assert.deepEqual(f.ends, []);
  });

  void test("a fatal storage failure ends the stream and stays in server diagnostics", async (t) => {
    const f = await setup(t);
    const client = replica(t, await f.acquire());
    await client.next();
    const pending = client.reader.read();
    const error = new Error("private storage failure");
    t.mock.method(f.storage, "commit", async () => {
      throw error;
    });
    await assert.rejects(notes(f.root, 1), (value) => value === error);
    assert.deepEqual(await pending, { done: true, value: undefined });
    assert.deepEqual(f.ends, [{ kind: "failed", error }]);
    assert.equal(f.tracking.attached, 0);
    assert.deepEqual(await f.harness.closed, { kind: "failed", error });
  });

  void test("cold read-only SQLite reads only a bounded window and inherited head, without writes", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "drv-watch-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, "session.sqlite");
    const options = { models: createModels(), registry: createRegistry() };
    const writer = await Harness.open(await openNodeSqliteStorage(path), options, context);
    const root = await writer.root(context);
    const entries = await notes(root, 1000);
    const head = await marker(root, entries[900]!.id);
    const tail = await notes(root, 30);
    const fork = await root.fork(tail.at(-1)!.id, { ownership: { kind: "ownerless" } }, context);
    await marker(root);
    await writer.close(context);
    const storage = await openNodeSqliteStorage(path);
    const harness = await Harness.open(storage, { ...options, readOnly: true }, context);
    const sessions = new Sessions(async () => harness);
    t.after(() => sessions.close(Promise.resolve()));
    const scan = t.mock.method(storage, "scanEntries");
    const find = t.mock.method(storage, "findLatestHeadMarker");
    const writes = t.mock.method(storage, "commit");
    const client = replica(
      t,
      await watch({ externalId: "test", conversationId: fork.id }, new AbortController().signal, {
        sessions,
        window: { min: 3, max: 5 },
        onEnd() {},
      }),
    );
    const { state } = await client.next();
    assert.deepEqual(
      scan.mock.calls.map((call) => call.arguments[1]),
      [4],
    );
    assert.equal((await scan.mock.calls[0]!.result)!.items.length, 4);
    assert.equal(find.mock.callCount(), 1);
    assert.equal(writes.mock.callCount(), 0);
    assert.deepEqual(state.head, head);
    assert.deepEqual(state.view.entries, tail.slice(-3));
  });
});
