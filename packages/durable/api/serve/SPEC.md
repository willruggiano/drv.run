# HTTP server

## Status and scope

This is the target contract for `durable-api/serve`, not a description of an
implemented server. The proposed surface and open decisions below are for
review.

`serve/serve.ts` implements the Node HTTP listener and the native Fetch
boundary. Its only export is `serve`. Supporting types remain internal; callers
receive inferred types.

```text
node:http request
  -> Fetch Request
  -> exact-path route or fetch fallback
  -> Fetch Response
  -> node:http response
```

The server has no GraphQL, SSE, authentication, authorization, or application
resource ownership logic. Route adapters own these policies. Cookies remain HTTP
headers; the server does not interpret them or establish an identity.

## Proposed surface

```typescript
import type { ServerOptions as HttpOptions } from "node:http";
import type { ListenOptions } from "node:net";

type BindOptions = Pick<
  ListenOptions,
  "host" | "backlog" | "exclusive" | "ipv6Only" | "reusePort" | "signal"
> &
  Required<Pick<ListenOptions, "port">>;

type Handler = (
  request: Request,
  server: Server,
) => Response | Promise<Response>;

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

declare function serve(options: Options): Promise<Server>;
```

## Configuration and startup

- Options derive from Node's HTTP server and TCP listen options. Keep the flat
  options object, use Node's `host` name, and require `port`. Socket paths and
  pre-bound handles are outside this TCP listener contract.
- Pass applicable options unchanged to `http.createServer()` and
  `server.listen()`. Node owns their defaults, interpretation, and validation.
- The wrapper performs no argument validation, coercion, or schema decoding.
  There is no TypeBox configuration schema or duplicated Node option schema.
  TypeScript defines the caller contract; Node errors reject startup.
- Port `0` requests an operating-system-assigned port. Omitting `host` retains
  Node's bind behavior; the wrapper does not substitute a loopback address.
- Resolve only after the listener is ready. Binding failures reject the promise
  and release transport resources acquired during startup.
- `url` uses the actual bound address and port, including IPv6 URL syntax. It is
  a listener address, not a deployment's public origin or reverse-proxy URL.
- Starting the listener keeps Node running. `serve()` does not install process
  signal handlers or impose a deployment shutdown deadline.

## Routing

- Match the request URL's pathname against an own key of `routes`. Query
  parameters do not participate in route selection.
- Matching is exact and case-sensitive. Do not percent-decode the pathname a
  second time or add trailing-slash redirects.
- A matching route handles every method for that path. It owns method validation
  and any `405` response or `Allow` header.
- Invoke `fetch` only when no route matches. It is a fallback, not middleware.
  The entrypoint supplies its `404` response.
- Do not add wildcard routes, path parameters, automatic `HEAD` routing, or an
  implicit `OPTIONS` response.

## Fetch adaptation

- Handlers receive native `Request` objects and return native `Response`
  objects. Do not expose Node request, response, or socket objects through the
  interface.
- Preserve methods, query parameters, status codes, and end-to-end header values
  subject to Fetch and HTTP rules. Preserve separate response `Set-Cookie`
  headers; do not join them with commas.
- Stream bodies with backpressure. Do not buffer complete request or response
  bodies as part of adaptation, or read ahead without a bound.
- The transport owns HTTP framing. Do not forward incompatible connection or
  transfer-framing headers from a Fetch response.
- Never send response body bytes for `HEAD` or a body-forbidden status. Release
  any unused response body without consuming it to completion.
- Flush response headers without waiting for the first body chunk. An idle
  stream must not prevent the client from receiving its response headers.
- No application payload decoding, SSE framing, compression, or retry is
  implicit.

## Cancellation and failures

- Each request has its own abort signal. Client disconnect, transport failure,
  or forced shutdown aborts that signal and cancels response-body consumption.
- Receiving the complete request body does not abort the signal. Streaming
  responses remain associated with the client connection until completion.
- Request cancellation does not itself cancel independently admitted application
  work. That policy belongs to the API receiving the signal.
- Observe handler and stream failures, including late failures after disconnect.
  They must not become unhandled promise rejections.
- Before response headers are committed, pass handler failures to `error`. Do
  not retry the handler or pass a replacement response through routing again.
- If `error` throws, rejects, or returns an unusable response, use a generic
  `500` response with `Cache-Control: no-store`. Do not expose exception
  details.
- After headers are committed, terminate a failed response. Do not invoke
  `error` to attempt a second HTTP response.
- Malformed HTTP rejected by Node's parser never enters application routing.
  Failure details are not returned to the client as diagnostic text.

## Timeouts

The proposed unit is milliseconds. `timeout(request, milliseconds)` changes
connection inactivity handling for the connection serving that request. A value
of `0` disables this inactivity timeout. Pass the value unchanged to Node; Node
owns its interpretation and validation. It is not an execution deadline or a
maximum response duration.

Callers must supply an active request belonging to this server. The wrapper does
not add argument validation.

Disabling inactivity timeout does not disable header or request-body receipt
limits. Node socket timeouts are connection-scoped, not independent timers for
requests sharing a connection. Keep-alive and pipelining behavior remains an
open decision below.

## Shutdown

- `close()` seals admission and closes the listener. Requests admitted before
  closure may finish; idle connections must not keep shutdown pending.
- Graceful closure does not abort active streaming responses. The application
  must end them, or deployment must escalate to forced closure.
- `forceClose()` also seals admission, aborts active request signals, and
  destroys remaining transport connections. It does not wait for application
  handlers that ignore cancellation.
- Both operations are idempotent. Forced closure can escalate an in-progress
  graceful closure.
- `close()` resolves once the listener and its connections have closed. After
  forced closure, this does not certify completion of independent application
  work or handlers that ignored cancellation.
- Neither operation closes application resources. Deployment coordinates
  application shutdown and its deadline.

## Verification

Use real local sockets and ephemeral ports. Assert HTTP results, cancellation,
resource release, and lifecycle state, not log output.

Cover startup failure, routing and fallback, method preservation, streamed
bodies, backpressure, repeated cookies, `HEAD`, disconnects during handlers and
streaming, error-handler failure, late rejection, graceful closure, and forced
escalation. Keep all tests in `serve/serve.test.ts`, alongside `serve/serve.ts`.

## Open decisions

Before implementation, confirm:

- The proposed flat TCP bind surface derived from `ListenOptions`.
- Request URL authority, accepted request-target forms, and Host validation. Do
  not implicitly trust forwarded headers.
- Millisecond units and connection-scoped timeout overrides, including reset
  behavior on keep-alive reuse and handling of HTTP pipelining.
- The separate `close()` and `forceClose()` methods.
- Handling of unread request bodies and unsupported GET/HEAD request bodies.
- Whether unsupported protocols, including upgrades and CONNECT, are explicitly
  rejected or excluded by listener configuration.

## Dependency references

The [manifest](../package.json) and [lockfile](../package-lock.json) pin
dependency versions. Relevant Node contracts are the pinned
[listener lifecycle declarations](../node_modules/@types/node/net.d.ts) and
[HTTP declarations](../node_modules/@types/node/http.d.ts), including timeout,
connection closure, framing, and header behavior. These constrain the adapter;
this specification does not promise Bun compatibility.
