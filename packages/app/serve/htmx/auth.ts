import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthorizationStatus, ProxyAuthorization } from "../auth.ts";
import { FormError } from "../forms.ts";
import { html as h } from "../html.ts";
import { html } from "./frontend.ts";

export async function authPage(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  authorization: ProxyAuthorization,
  signal: AbortSignal,
): Promise<void> {
  if (request.method === "POST" && ["/auth/login", "/auth/logout"].includes(url.pathname)) {
    response.setHeader("HX-Push-Url", "false");
    // httpServer checks the exact origin; require it even for bodyless POSTs.
    if (!request.headers.origin) throw new FormError(403, "Origin header required.");
    await authorization.change(url.pathname === "/auth/login" ? "login" : "logout", signal);
    if (request.headers["hx-request"] === "true")
      response.writeHead(200, {
        "HX-Location": JSON.stringify({
          path: "/auth",
          target: "#page",
          select: "#page",
          swap: "outerHTML",
        }),
      });
    else response.writeHead(303, { Location: "/auth" });
    response.end();
    return;
  }
  if (url.pathname !== "/auth") throw new FormError(404, "Not found.");
  if (request.method !== "GET") throw new FormError(405, "Method not allowed.");
  const value = await authorization.status(signal);
  const labels: Record<AuthorizationStatus["state"], string> = {
    unconfigured: "GitHub credentials are not configured for this host user.",
    "not-enrolled": "Not authorized",
    usable: "Authorized",
    "temporarily-unavailable":
      "Access token expired or credentials temporarily unavailable. The proxy renews tokens when Git needs them.",
    "reauthorization-required": "Authorization required",
    authorizing: "Waiting for GitHub approval",
  };
  const device = value.device;
  html(
    response,
    h`<main id="main-area"><section id="github-authorization" class="pane" ${value.state === "authorizing" ? h`hx-get="/auth" hx-trigger="load delay:2s" hx-target="this" hx-select="#github-authorization" hx-swap="outerMorph" hx-push-url="false"` : ""}>
    <nav><a href="/sessions">Sessions</a></nav><h1>Auth</h1><h2>GitHub</h2>
    <p role="status" data-state="${value.state}">${labels[value.state]}</p>
    ${value.userId === null ? "" : h`<p>GitHub user ID: ${value.userId}</p>`}
    ${value.error ? h`<p role="alert">Authorization did not complete. Try again and approve with the configured GitHub account. </p>` : ""}
    ${device ? h`<p>Enter <code>${device.userCode}</code> at <a href="${device.verificationUri}" target="_blank" rel="noopener noreferrer" hx-boost="false">GitHub device authorization</a>.</p><p>Code expires at <time datetime="${new Date(device.expiresAt * 1000).toISOString()}">${new Date(device.expiresAt * 1000).toISOString()}</time>.</p>` : ""}
    ${value.expiresAt === null ? "" : h`<p>Access token expires at <time datetime="${new Date(value.expiresAt * 1000).toISOString()}">${new Date(value.expiresAt * 1000).toISOString()}</time>; renewal is automatic.</p>`}
    ${value.state === "unconfigured" ? "" : h`<p>All guests of this host user share this GitHub Git access. Access and refresh tokens stay on the host.</p><div class="actions">${value.state === "authorizing" ? "" : h`<form method="post" action="/auth/login"><button>${value.state === "usable" ? "Reauthorize" : "Authorize"}</button></form>`}<form method="post" action="/auth/logout"><button>Remove authorization</button></form><a href="/auth">Refresh</a></div><p>Removal cancels pending authorization and deletes local credentials. It does not revoke the app authorization at GitHub.</p>`}
  </section></main>`,
    200,
    undefined,
    "Auth",
  );
}
