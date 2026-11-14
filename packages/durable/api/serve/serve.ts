import assert from "node:assert/strict";
import { once } from "node:events";
import {
  createServer,
  type IncomingMessage,
  type ServerOptions as HttpOptions,
  type ServerResponse,
} from "node:http";
import type { ListenOptions } from "node:net";
import { Readable } from "node:stream";
import { finished, pipeline } from "node:stream/promises";

type BindOptions = Pick<
  ListenOptions,
  "host" | "backlog" | "exclusive" | "ipv6Only" | "reusePort" | "signal"
> &
  Required<Pick<ListenOptions, "port">>;

type Handler = (request: Request, server: Server) => Response | Promise<Response>;

interface Options extends HttpOptions, BindOptions {
  routes: Readonly<Record<string, Handler>>;
  fetch: Handler;
  error(error: unknown): Response | Promise<Response>;
}

interface Server {
  readonly url: URL;
  timeout(request: Request, milliseconds: number): void;
  close(): Promise<void>;
  forceClose(): void;
}

const hopHeaders = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

function hasBody(incoming: IncomingMessage): boolean {
  return (
    incoming.headers["transfer-encoding"] !== undefined ||
    Number(incoming.headers["content-length"] ?? 0) !== 0
  );
}

function discard(response: Response): void {
  if (response.body && !response.body.locked) void response.body.cancel().catch(() => {});
}

export async function serve(options: Options): Promise<Server> {
  const http = createServer(options);
  const requests = new WeakMap<Request, ServerResponse>();
  const active = new Map<ServerResponse, AbortController>();
  let closing: Promise<void> | undefined;
  let origin: string;

  const server: Server = {
    get url() {
      return new URL(origin);
    },
    timeout(request, milliseconds) {
      requests.get(request)!.setTimeout(milliseconds);
    },
    close() {
      closing ??= new Promise<void>((resolve) => http.close(() => resolve()));
      return closing;
    },
    forceClose() {
      void server.close();
      for (const controller of active.values()) controller.abort();
      http.closeAllConnections();
    },
  };

  async function respond(
    response: Response,
    incoming: IncomingMessage,
    outgoing: ServerResponse,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      if (outgoing.destroyed) {
        discard(response);
        return;
      }
      if (response.bodyUsed || response.body?.locked)
        throw new TypeError("Response body is unavailable");
      for (const name of outgoing.getHeaderNames()) outgoing.removeHeader(name);
      const headers = new Headers(response.headers);
      const connection = headers.get("connection");
      if (connection) {
        for (const name of connection.split(",")) headers.delete(name.trim());
      }
      for (const name of hopHeaders) headers.delete(name);
      if (response.status === 204) headers.delete("content-length");
      if (response.status === 205) headers.set("content-length", "0");
      for (const [name, value] of headers) {
        if (name !== "set-cookie") outgoing.setHeader(name, value);
      }
      const cookies = headers.getSetCookie();
      if (cookies.length) outgoing.setHeader("set-cookie", cookies);
      outgoing.statusCode = response.status;
      outgoing.statusMessage = response.statusText;
      if (hasBody(incoming) && !incoming.readableEnded) outgoing.shouldKeepAlive = false;
      outgoing.flushHeaders();
      if (incoming.method === "HEAD" || response.body === null) {
        discard(response);
        outgoing.end();
        await finished(outgoing, { cleanup: true });
      } else {
        await pipeline(Readable.fromWeb(response.body), outgoing, { signal });
      }
    } catch (error) {
      discard(response);
      if (outgoing.headersSent) outgoing.destroy();
      throw error;
    }
  }

  async function dispatch(incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> {
    const controller = new AbortController();
    active.set(outgoing, controller);
    let request: Request | undefined;
    incoming.on("error", () => controller.abort());
    outgoing.once("close", () => {
      active.delete(outgoing);
      if (request) requests.delete(request);
      if (!outgoing.writableFinished) controller.abort();
      if (closing || !http.listening) http.closeIdleConnections();
    });
    try {
      if (closing || !http.listening) {
        outgoing.writeHead(503, { Connection: "close" }).end();
        return;
      }
      const body = hasBody(incoming);
      const bodyForbidden = incoming.method === "GET" || incoming.method === "HEAD";
      try {
        if (
          !incoming.url!.startsWith("/") ||
          incoming.url!.includes("#") ||
          incoming.url!.includes("\\") ||
          (bodyForbidden && body)
        ) {
          outgoing.writeHead(400, { Connection: "close" }).end();
          return;
        }
        const headers = new Headers();
        for (const [name, values] of Object.entries(incoming.headers)) {
          if (Array.isArray(values)) {
            for (const value of values) headers.append(name, value);
          } else if (values !== undefined) headers.set(name, values);
        }
        request = new Request(`${origin}${incoming.url}`, {
          method: incoming.method!,
          headers,
          signal: controller.signal,
          ...(body ? { body: Readable.toWeb(incoming), duplex: "half" } : {}),
        });
      } catch {
        outgoing.writeHead(400, { Connection: "close" }).end();
        return;
      }
      requests.set(request, outgoing);
      const path = new URL(request.url).pathname;
      const handler = Object.hasOwn(options.routes, path) ? options.routes[path]! : options.fetch;
      const response = await handler(request, server);
      await respond(response, incoming, outgoing, controller.signal);
    } catch (error) {
      if (outgoing.destroyed) return;
      try {
        await respond(await options.error(error), incoming, outgoing, controller.signal);
      } catch {
        if (outgoing.destroyed) return;
        for (const name of outgoing.getHeaderNames()) outgoing.removeHeader(name);
        outgoing
          .writeHead(500, "Internal Server Error", {
            "Cache-Control": "no-store",
            Connection: "close",
          })
          .end();
      }
    } finally {
      if (outgoing.writableFinished && hasBody(incoming) && !incoming.readableEnded)
        incoming.destroy();
    }
  }

  http.on("request", (incoming, outgoing) => {
    void dispatch(incoming, outgoing);
  });
  http.on("upgrade", (_request, socket) => socket.destroy());
  http.on("connect", (_request, socket) => socket.destroy());
  try {
    const { host, port, backlog, exclusive, ipv6Only, reusePort, signal } = options;
    http.listen({ host, port, backlog, exclusive, ipv6Only, reusePort, signal });
    await once(http, "listening", { signal });
    const address = http.address();
    assert(address && typeof address !== "string");
    const hostAddress = address.family === "IPv6" ? `[${address.address}]` : address.address;
    origin = `http://${hostAddress}:${address.port}`;
    return server;
  } catch (error) {
    server.forceClose();
    await server.close();
    throw error;
  }
}
