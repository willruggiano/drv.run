import assert from "node:assert/strict";
import { once } from "node:events";
import {
  Agent,
  type IncomingMessage,
  request as httpRequest,
  type RequestOptions,
} from "node:http";
import { connect } from "node:net";
import { describe, test, type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import { serve } from "durable-api/serve";

type Options = Parameters<typeof serve>[0];

async function start(t: TestContext, options: Partial<Options> = {}) {
  const server = await serve({
    host: "127.0.0.1",
    port: 0,
    routes: {},
    fetch: () => new Response(null, { status: 404 }),
    error: (error) => {
      throw error;
    },
    ...options,
  });
  t.after(async () => {
    server.forceClose();
    await server.close();
  });
  return server;
}

function exchange(url: URL, options: RequestOptions = {}, body?: Uint8Array) {
  return new Promise<{ status: number; headers: IncomingMessage["headers"]; body: Buffer }>(
    (resolve, reject) => {
      const request = httpRequest(url, options, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () =>
          resolve({
            status: response.statusCode!,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
      });
      request.on("error", reject);
      request.end(body);
    },
  );
}

void describe("serve", { timeout: 30_000 }, () => {
  void test("binding resolves to the actual address and preserves Node startup failures", async (t) => {
    const server = await start(t);
    assert.equal((await exchange(server.url)).status, 404);
    await assert.rejects(start(t, { port: Number(server.url.port) }));
    await assert.rejects(start(t, { port: -1 }));
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(start(t, { signal: controller.signal }));
    const ipv6 = await start(t, { host: "::1" });
    assert.equal((await exchange(ipv6.url)).status, 404);
    const native = new AbortController();
    const aborted = await start(t, { signal: native.signal });
    native.abort();
    await Promise.all([aborted.close(), aborted.close()]);
  });

  void test("exact own-path routes preserve methods and queries without trusting authority headers", async (t) => {
    const seen: {
      method: string;
      path: string;
      query: string;
      origin: string;
      host: string | null;
    }[] = [];
    const handler: Options["fetch"] = (request) => {
      const url = new URL(request.url);
      seen.push({
        method: request.method,
        path: url.pathname,
        query: url.search,
        origin: url.origin,
        host: request.headers.get("host"),
      });
      return new Response(null, { status: 202 });
    };
    const routes: Options["routes"] = {
      "/Case": handler,
      "/a%2Fb": handler,
      "//elsewhere/a": handler,
    };
    Object.setPrototypeOf(routes, { "/inherited": handler });
    const server = await start(t, { routes });
    for (const [path, method] of [
      ["/Case?x=1&x=2", "GET"],
      ["/a%2Fb", "OPTIONS"],
      ["//elsewhere/a", "HEAD"],
    ]) {
      const result = await exchange(server.url, {
        path,
        method,
        headers: { Host: "untrusted.example", "X-Forwarded-Host": "proxy.example" },
      });
      assert.equal(result.status, 202);
    }
    assert.deepEqual(seen, [
      {
        method: "GET",
        path: "/Case",
        query: "?x=1&x=2",
        origin: server.url.origin,
        host: "untrusted.example",
      },
      {
        method: "OPTIONS",
        path: "/a%2Fb",
        query: "",
        origin: server.url.origin,
        host: "untrusted.example",
      },
      {
        method: "HEAD",
        path: "//elsewhere/a",
        query: "",
        origin: server.url.origin,
        host: "untrusted.example",
      },
    ]);
    for (const path of ["/case", "/Case/", "/inherited"])
      assert.equal((await exchange(new URL(path, server.url))).status, 404);
  });

  void test("headers and cookies survive conversion without forwarding connection-specific headers", async (t) => {
    const server = await start(t, {
      fetch(request) {
        assert.equal(request.headers.get("cookie"), "one=1; two=2");
        assert.equal(request.headers.get("set-cookie"), "a=1, b=2");
        const headers = new Headers({
          "Content-Type": "application/json",
          Connection: "x-private, keep-alive",
          "x-private": "removed",
          "Keep-Alive": "timeout=999",
          "Transfer-Encoding": "invalid",
        });
        headers.append("Set-Cookie", "first=1; HttpOnly");
        headers.append("Set-Cookie", "second=2; HttpOnly");
        return new Response(JSON.stringify({ ok: true }), { status: 201, headers });
      },
    });
    const result = await exchange(server.url, {
      headers: { Cookie: ["one=1", "two=2"], "Set-Cookie": ["a=1", "b=2"] },
    });
    assert.equal(result.status, 201);
    assert.deepEqual(JSON.parse(result.body.toString()), { ok: true });
    assert.deepEqual(result.headers["set-cookie"], ["first=1; HttpOnly", "second=2; HttpOnly"]);
    assert.equal(result.headers["x-private"], undefined);
    assert.notEqual(result.headers["transfer-encoding"], "invalid");
  });

  void test("request and response bodies stream before either side finishes", async (t) => {
    const firstRead = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let signal: AbortSignal | undefined;
    const server = await start(t, {
      async fetch(request) {
        signal = request.signal;
        const chunks: Uint8Array[] = [];
        for await (const chunk of request.body!) {
          chunks.push(chunk);
          firstRead.resolve();
        }
        assert.deepEqual(Buffer.concat(chunks), Buffer.from([1, 2, 3, 4]));
        assert.equal(signal.aborted, false);
        return new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              await release.promise;
              controller.enqueue(new Uint8Array([5, 6]));
              await finish.promise;
              controller.enqueue(new Uint8Array([7, 8]));
              controller.close();
            },
          }),
        );
      },
    });
    const headers = Promise.withResolvers<IncomingMessage>();
    const request = httpRequest(server.url, { method: "POST" }, headers.resolve);
    request.on("error", headers.reject);
    t.after(() => {
      release.resolve();
      finish.resolve();
      request.destroy();
    });
    request.write(new Uint8Array([1, 2]));
    await firstRead.promise;
    request.end(new Uint8Array([3, 4]));
    const response = await headers.promise;
    assert.equal(response.statusCode, 200);
    assert.equal(signal!.aborted, false);
    release.resolve();
    const chunks: Buffer[] = [];
    for await (const chunk of response) {
      chunks.push(chunk);
      finish.resolve();
    }
    assert.deepEqual(Buffer.concat(chunks), Buffer.from([5, 6, 7, 8]));
    assert.equal(signal!.aborted, false);
  });

  void test("HEAD cancels its producer and content length follows response semantics", async (t) => {
    const cancelled = Promise.withResolvers<void>();
    const server = await start(t, {
      routes: {
        "/head": () =>
          new Response(
            new ReadableStream({
              cancel() {
                cancelled.resolve();
                throw new Error("cancel failed");
              },
            }),
            { headers: { "Content-Length": "10" } },
          ),
      },
      fetch: (request) =>
        new Response(null, {
          status: Number(new URL(request.url).pathname.slice(1)),
          headers: { "Content-Length": "99" },
        }),
    });
    const head = await exchange(new URL("/head", server.url), { method: "HEAD" });
    assert.equal(head.body.length, 0);
    assert.equal(head.headers["content-length"], "10");
    await cancelled.promise;
    for (const [status, length] of [
      [204, undefined],
      [205, "0"],
      [304, "99"],
    ] as const) {
      const response = await exchange(new URL(`/${status}`, server.url));
      assert.equal(response.headers["content-length"], length);
    }
  });

  void test("bad targets, unsupported Fetch methods and GET/HEAD bodies never enter routing", async (t) => {
    let calls = 0;
    const server = await start(t, {
      fetch: () => {
        calls++;
        return new Response(null);
      },
    });
    for (const path of ["http://example.com/a", "*", "/bad#fragment", "/bad\\path"])
      assert.equal((await exchange(server.url, { path })).status, 400);
    assert.equal((await exchange(server.url, { method: "TRACE" })).status, 400);
    for (const method of ["GET", "HEAD"])
      assert.equal(
        (
          await exchange(
            server.url,
            { method, headers: { "Content-Length": "1" } },
            new Uint8Array([1]),
          )
        ).status,
        400,
      );
    assert.equal(calls, 0);
    assert.equal((await exchange(server.url, { headers: { "Content-Length": "0" } })).status, 200);
    assert.equal(calls, 1);
    assert.equal(
      (await exchange(server.url, { headers: { "Content-Length": "000" } })).status,
      200,
    );
  });

  void test("unread bodies do not retain a connection or prevent a response", async (t) => {
    const server = await start(t, { fetch: () => new Response(null, { status: 202 }) });
    const responseReady = Promise.withResolvers<IncomingMessage>();
    const request = httpRequest(
      server.url,
      { method: "POST", headers: { "Content-Length": "1000000" } },
      responseReady.resolve,
    );
    request.on("error", responseReady.reject);
    request.write(new Uint8Array([1]));
    const response = await responseReady.promise;
    const closed = once(request, "close");
    response.resume();
    await closed;
    assert.equal(response.statusCode, 202);
    assert.equal(response.headers.connection, "close");
  });

  void test("handler failures use error exactly once; unusable error responses fall back safely", async (t) => {
    const failure = new Error("private details");
    const errors: unknown[] = [];
    const server = await start(t, {
      fetch: () => {
        throw failure;
      },
      error(error) {
        errors.push(error);
        return new Response(null, { status: 422 });
      },
    });
    assert.equal((await exchange(server.url)).status, 422);
    assert.deepEqual(errors, [failure]);
    for (const error of [
      () => {
        throw failure;
      },
      async () => {
        const response = new Response("used");
        await response.text();
        return response;
      },
    ]) {
      const broken = await start(t, { fetch: () => Promise.reject(failure), error });
      const response = await exchange(broken.url);
      assert.equal(response.status, 500);
      assert.equal(response.headers["cache-control"], "no-store");
      assert.equal(response.body.length, 0);
    }
    const locked = new Response(new ReadableStream());
    const reader = locked.body!.getReader();
    t.after(() => reader.cancel());
    const unavailable = await start(t, {
      fetch: () => locked,
      error: () => new Response(null, { status: 409 }),
    });
    assert.equal((await exchange(unavailable.url)).status, 409);
  });

  void test("disconnect aborts pending handlers and observes their late results and failures", async (t) => {
    for (const reject of [false, true]) {
      const entered = Promise.withResolvers<AbortSignal>();
      const release = Promise.withResolvers<Response>();
      const disposed = Promise.withResolvers<void>();
      const server = await start(t, {
        fetch(request) {
          entered.resolve(request.signal);
          return release.promise;
        },
      });
      const request = httpRequest(server.url);
      request.on("error", () => {});
      request.end();
      const signal = await entered.promise;
      const aborted = new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      request.destroy();
      await aborted;
      if (reject) release.reject(new Error("late rejection"));
      else {
        release.resolve(
          new Response(
            new ReadableStream({
              cancel() {
                disposed.resolve();
              },
            }),
          ),
        );
        await disposed.promise;
      }
      await server.close();
    }
  });

  void test("disconnect cancels response production and aborts the request signal", async (t) => {
    const cancelled = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const server = await start(t, {
      fetch(request) {
        request.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1]));
            },
            cancel() {
              cancelled.resolve();
            },
          }),
        );
      },
    });
    const controller = new AbortController();
    const response = await fetch(server.url, { signal: controller.signal });
    const reader = response.body!.getReader();
    assert.deepEqual([...(await reader.read()).value!], [1]);
    controller.abort();
    await Promise.all([cancelled.promise, aborted.promise]);
  });

  void test("stream failures after headers terminate the connection without a replacement response", async (t) => {
    for (const throughError of [false, true]) {
      const fail = Promise.withResolvers<void>();
      let errors = 0;
      const response = () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              await fail.promise;
              controller.error(new Error("stream failed"));
            },
          }),
        );
      const server = await start(t, {
        fetch: () => {
          if (throughError) throw new Error("handler failed");
          return response();
        },
        error: () => {
          errors++;
          return response();
        },
      });
      const received = await fetch(server.url);
      assert.equal(received.status, 200);
      const body = received.arrayBuffer();
      const rejected = assert.rejects(body);
      fail.resolve();
      await rejected;
      assert.equal(errors, throughError ? 1 : 0);
    }
  });

  void test("late error-handler rejection after disconnect remains observed", async (t) => {
    const entered = Promise.withResolvers<AbortSignal>();
    const handling = Promise.withResolvers<void>();
    const errorResult = Promise.withResolvers<Response>();
    const server = await start(t, {
      fetch(request) {
        entered.resolve(request.signal);
        throw new Error("handler failed");
      },
      error() {
        handling.resolve();
        return errorResult.promise;
      },
    });
    const request = httpRequest(server.url);
    request.on("error", () => {});
    request.end();
    const signal = await entered.promise;
    await handling.promise;
    const aborted = new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    request.destroy();
    await aborted;
    errorResult.reject(new Error("late error failure"));
    await server.close();
  });

  void test("graceful close drains responses; forced close escalates without joining stuck handlers", async (t) => {
    const release = Promise.withResolvers<Response>();
    const entered = Promise.withResolvers<AbortSignal>();
    const server = await start(t, {
      keepAliveTimeout: 60_000,
      fetch(request) {
        entered.resolve(request.signal);
        return release.promise;
      },
    });
    const agent = new Agent({ keepAlive: true, timeout: 0 });
    t.after(() => agent.destroy());
    const response = exchange(server.url, { agent });
    const signal = await entered.promise;
    let closed = false;
    const closing = Promise.all([server.close(), server.close()]).then(() => {
      closed = true;
    });
    await setImmediate();
    assert.equal(closed, false);
    assert.equal(signal.aborted, false);
    release.resolve(new Response(null, { status: 202 }));
    assert.equal((await response).status, 202);
    await closing;
    assert.equal(signal.aborted, false);

    const stuck = Promise.withResolvers<AbortSignal>();
    const forever = await start(t, {
      fetch(request) {
        stuck.resolve(request.signal);
        return new Promise<Response>(() => {});
      },
    });
    const failed = assert.rejects(exchange(forever.url));
    const pendingSignal = await stuck.promise;
    const drain = forever.close();
    forever.forceClose();
    forever.forceClose();
    assert.equal(pendingSignal.aborted, true);
    await Promise.all([failed, drain]);
  });

  void test("pipelined requests after admission closes do not invoke a handler", async (t) => {
    let calls = 0;
    const server = await start(t, {
      fetch(_request, handle) {
        calls++;
        void handle.close();
        return new Response(null);
      },
    });
    const socket = connect(Number(server.url.port), server.url.hostname);
    socket.on("error", () => {});
    const closed = once(socket, "close");
    socket.resume();
    socket.end("GET / HTTP/1.1\r\nHost: local\r\n\r\nGET / HTTP/1.1\r\nHost: local\r\n\r\n");
    await closed;
    await server.close();
    assert.equal(calls, 1);
  });

  void test("a connection timeout aborts the associated request", async (t) => {
    const timedOut = Promise.withResolvers<void>();
    const timeout = await start(t, {
      fetch(request, handle) {
        request.signal.addEventListener("abort", () => timedOut.resolve(), { once: true });
        handle.timeout(request, 1);
        return new Promise<Response>(() => {});
      },
    });
    await assert.rejects(exchange(timeout.url));
    await timedOut.promise;
  });

  void test("upgrades and CONNECT never reach application handlers", async (t) => {
    let calls = 0;
    const server = await start(t, {
      fetch() {
        calls++;
        return new Response(null);
      },
    });
    for (const method of ["CONNECT", "GET"]) {
      await assert.rejects(
        exchange(server.url, {
          method,
          headers: method === "GET" ? { Connection: "Upgrade", Upgrade: "websocket" } : {},
        }),
      );
    }
    assert.equal(calls, 0);
  });

  void test("failed response headers are cleared before error and fallback responses", async (t) => {
    for (const fallback of [false, true]) {
      const server = await start(t, {
        fetch: () =>
          new Response(null, { headers: { "a-private": "secret", "z-invalid": "\x01" } }),
        error: () => {
          if (fallback) throw new Error("error handler failed");
          return new Response(null, { status: 422 });
        },
      });
      const response = await exchange(server.url);
      assert.equal(response.status, fallback ? 500 : 422);
      assert.equal(response.headers["a-private"], undefined);
    }
  });

  void test("graceful close leaves an admitted stream alive until its producer finishes", async (t) => {
    const output = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
    const admitted = Promise.withResolvers<AbortSignal>();
    let cancelled = false;
    const server = await start(t, {
      fetch(request) {
        admitted.resolve(request.signal);
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              output.resolve(controller);
            },
            cancel() {
              cancelled = true;
            },
          }),
        );
      },
    });
    const response = await fetch(server.url);
    const signal = await admitted.promise;
    const closing = server.close();
    const controller = await output.promise;
    assert.equal(signal.aborted, false);
    controller.enqueue(new Uint8Array([7]));
    controller.close();
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([7]));
    await closing;
    assert.equal(cancelled, false);
    assert.equal(signal.aborted, false);
  });
});
