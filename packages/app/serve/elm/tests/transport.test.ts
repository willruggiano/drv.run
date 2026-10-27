import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  openStream,
  type StreamEvent,
  type StreamRuntime,
  type StreamSource,
} from "../transport.ts";

class Source implements StreamSource {
  closed = 0;
  message: (data: string) => void = () => assert.fail("Source not listening");
  fail: (terminal: boolean) => void = () => assert.fail("Source not listening");
  listen(message: (data: string) => void, error: (terminal: boolean) => void) {
    this.message = message;
    this.fail = error;
  }
  close() {
    this.closed++;
  }
}

function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0;
  let random = 0;
  const sources: { url: string; source: Source }[] = [];
  const received: StreamEvent[] = [];
  const runtime: StreamRuntime = {
    open(url) {
      const source = new Source();
      sources.push({ url, source });
      return source;
    },
    now: () => now,
    random: () => random,
    schedule(callback, delay) {
      const timer = setTimeout(callback, delay);
      return () => clearTimeout(timer);
    },
  };
  return {
    sources,
    received,
    runtime,
    open: (url: string) => openStream(url, (event) => received.push(event), runtime),
    current: () => sources.at(-1)!.source,
    random(value: number) {
      random = value;
    },
    advance(delay: number) {
      now += delay;
      t.mock.timers.tick(delay);
    },
  };
}

await test("stream retries are bounded and reset only after stable data delivery", (t) => {
  const f = fixture(t);
  const stop = f.open("/first/events?pane=settings");
  t.after(stop);
  const retryAfter = (delay: number) => {
    const count = f.sources.length;
    f.advance(delay - 1);
    assert.equal(f.sources.length, count);
    f.advance(1);
    assert.equal(f.sources.length, count + 1);
    assert.equal(f.sources.at(-1)!.url, "/first/events?pane=settings");
  };
  f.current().fail(false);
  assert.equal(f.current().closed, 1);
  f.current().fail(false);
  f.current().message('{"stale":true}');
  assert.deepEqual(f.received, [{ kind: "disconnected", payload: null }]);
  retryAfter(125);
  for (const delay of [250, 500, 1000, 2000, 4000, 8000, 15000, 15000]) {
    f.current().message('{"snapshot":true}');
    assert.deepEqual(f.received.at(-1), { kind: "frame", payload: { snapshot: true } });
    f.current().fail(false);
    retryAfter(delay);
  }
  f.random(0.5);
  f.current().fail(false);
  retryAfter(22500);
  // Remaining open without receiving data is not recovery.
  f.advance(30000);
  f.current().fail(false);
  retryAfter(22500);
  f.current().message('{"snapshot":true}');
  f.advance(29999);
  f.current().fail(false);
  retryAfter(22500);
  f.current().message('{"snapshot":true}');
  f.advance(30000);
  f.random(0.2);
  f.current().fail(false);
  retryAfter(150);
});

await test("stream stop cancels retries and suppresses obsolete callbacks across subscriptions", (t) => {
  const f = fixture(t);
  const first = f.open("/first/events");
  f.current().fail(false);
  first();
  const second = f.open("/second/events");
  f.advance(60000);
  assert.equal(f.sources.length, 2);
  assert.equal(f.sources[1].url, "/second/events");
  const count = f.received.length;
  f.sources[0].source.message('{"stale":true}');
  f.sources[0].source.fail(false);
  assert.equal(f.received.length, count);
  f.current().message("invalid JSON");
  assert.deepEqual(f.received.at(-1), { kind: "frame", payload: null });
  second();
  second();
  assert.equal(f.current().closed, 1);
  f.current().message("null");
  f.current().fail(false);
  f.advance(60000);
  assert.equal(f.sources.length, 2);
  assert.equal(f.received.length, count + 1);
});

await test("terminal failure never retries; an explicit new subscription starts fresh", (t) => {
  const f = fixture(t);
  const stop = f.open("/events");
  f.current().fail(true);
  f.current().fail(false);
  f.advance(60000);
  assert.equal(f.sources.length, 1);
  assert.equal(f.current().closed, 1);
  assert.deepEqual(f.received, [{ kind: "stream-failed", payload: null }]);
  stop();
  const retry = f.open("/events");
  f.current().fail(false);
  f.advance(124);
  assert.equal(f.sources.length, 2);
  f.advance(1);
  assert.equal(f.sources.length, 3);
  retry();
});

await test("a consumer can stop synchronously on disconnection", (t) => {
  const f = fixture(t);
  const stop = openStream("/events", () => stop(), f.runtime);
  f.current().fail(false);
  f.advance(60000);
  assert.equal(f.sources.length, 1);
  assert.equal(f.current().closed, 1);
});
