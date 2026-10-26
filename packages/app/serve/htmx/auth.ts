import type { IncomingMessage, ServerResponse } from "node:http";
import {
  authorizationProviders,
  type AuthorizationStatus,
  type ProxyAuthorization,
} from "../auth.ts";
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
  const action = /^\/htmx\/auth\/(openai\/)?(login|logout)$/.exec(url.pathname);
  if (request.method === "POST" && action) {
    response.setHeader("HX-Push-Url", "false");
    // httpServer checks the exact origin; require it even for bodyless POSTs.
    if (!request.headers.origin) throw new FormError(403, "Origin header required.");
    await authorization.change(
      action[2] === "login" ? "login" : "logout",
      signal,
      action[1] ? "openai" : "github",
    );
    if (request.headers["hx-request"] === "true")
      response.writeHead(200, {
        "HX-Location": JSON.stringify({
          path: "/htmx/auth",
          target: "#page",
          select: "#page",
          swap: "outerHTML",
        }),
      });
    else response.writeHead(303, { Location: "/htmx/auth" });
    response.end();
    return;
  }
  if (url.pathname !== "/htmx/auth") throw new FormError(404, "Not found.");
  if (request.method !== "GET") throw new FormError(405, "Method not allowed.");
  const sections = await Promise.all(
    authorizationProviders.map(async ({ id, label }) => {
      const value = await authorization.status(signal, id);
      const labels: Record<AuthorizationStatus["state"], string> = {
        unconfigured: `${label} credentials are not configured for this host user.`,
        "not-enrolled": "Not authorized",
        usable: "Authorized",
        "temporarily-unavailable":
          "Access token expired or credentials temporarily unavailable. The credential service renews tokens when needed.",
        "reauthorization-required": "Authorization required",
        authorizing: `Waiting for ${label} approval`,
      };
      const device = value.device;
      const path = id === "github" ? "/htmx/auth" : "/htmx/auth/openai";
      const selector = `#${id}-authorization`;
      return h`<section id="${id}-authorization" class="pane" ${value.state === "authorizing" ? h`hx-get="/htmx/auth" hx-trigger="load delay:2s" hx-target="this" hx-select="${selector}" hx-swap="outerMorph" hx-push-url="false"` : ""}>
    <h2>${label}</h2>
    <p role="status" data-state="${value.state}">${labels[value.state]}</p>
    ${value.userId === null ? "" : h`<p>GitHub user ID: ${value.userId}</p>`}
    ${value.accountId ? h`<p>OpenAI account ID: ${value.accountId}</p>` : ""}
    ${value.error ? h`<p role="alert">Authorization did not complete. Try again and approve with the intended ${label} account.</p>` : ""}
    ${device ? h`<p>Enter <code>${device.userCode}</code> at <a href="${device.verificationUri}" target="_blank" rel="noopener noreferrer" hx-boost="false">${label} device authorization</a>.</p><p>Code expires at <time datetime="${new Date(device.expiresAt * 1000).toISOString()}">${new Date(device.expiresAt * 1000).toISOString()}</time>.</p>` : ""}
    ${value.expiresAt === null ? "" : h`<p>Access token expires at <time datetime="${new Date(value.expiresAt * 1000).toISOString()}">${new Date(value.expiresAt * 1000).toISOString()}</time>; renewal is automatic.</p>`}
    ${value.state === "unconfigured" ? "" : h`<p>${id === "github" ? "All guests of this host user share this GitHub Git access. Access and refresh tokens stay on the host." : "Host Pi uses this OpenAI account for Codex model requests. The credential service owns refresh; tools in guests receive no OpenAI tokens."}</p><div class="actions">${value.state === "authorizing" ? "" : h`<form method="post" action="${path}/login"><button>${value.state === "usable" ? "Reauthorize" : "Authorize"}</button></form>`}<form method="post" action="${path}/logout"><button>Remove authorization</button></form><a href="/htmx/auth">Refresh</a></div><p>Removal cancels pending authorization and deletes local credentials. It does not revoke upstream authorization or already-issued access tokens.</p>`}
  </section>`;
    }),
  );
  html(
    response,
    h`<main id="main-area"><nav><a href="/htmx/">Sessions</a></nav><h1>Auth</h1>${sections}</main>`,
    200,
    undefined,
    "Auth",
  );
}
