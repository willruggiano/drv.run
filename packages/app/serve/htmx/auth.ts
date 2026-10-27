import type { IncomingMessage, ServerResponse } from "node:http";
import {
  authorizationProviders,
  type AuthorizationStatus,
  type ProxyAuthorization,
} from "../auth.ts";
import { icon } from "./render.ts";
import { FormError } from "../forms.ts";
import { html as h, type SafeHtml } from "../html.ts";

export async function authAction(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  authorization: ProxyAuthorization,
  signal: AbortSignal,
): Promise<void> {
  const action = /^\/htmx\/settings\/auth\/(github|openai)\/(login|logout)$/.exec(url.pathname);
  if (request.method === "POST" && action) {
    response.setHeader("HX-Push-Url", "false");
    // httpServer checks the exact origin; require it even for bodyless POSTs.
    if (!request.headers.origin) throw new FormError(403, "Origin header required.");
    await authorization.change(
      action[2] === "login" ? "login" : "logout",
      signal,
      action[1] === "openai" ? "openai" : "github",
    );
    if (request.headers["hx-request"] === "true")
      response.writeHead(200, {
        "HX-Location": JSON.stringify({
          path: "/htmx/settings",
          target: "#authorization",
          select: "#authorization",
          swap: "outerMorph",
        }),
      });
    else response.writeHead(303, { Location: "/htmx/settings#authorization" });
    response.end();
    return;
  }
  throw new FormError(action ? 405 : 404, action ? "Method not allowed." : "Not found.");
}

export async function authSection(
  authorization: ProxyAuthorization,
  signal: AbortSignal,
): Promise<SafeHtml> {
  const sections = await Promise.all(
    authorizationProviders.map(async ({ id, label }) => {
      const value = await authorization.status(signal, id);
      const labels: Record<Exclude<AuthorizationStatus["state"], "usable">, string> = {
        unconfigured: "Not configured",
        "not-enrolled": "Not authorized",
        "temporarily-unavailable": "Temporarily unavailable",
        "reauthorization-required": "Authorization required",
        authorizing: "Waiting for approval",
      };
      const identity =
        value.state === "usable"
          ? (value.accountId ?? (value.userId === null ? null : String(value.userId)))
          : null;
      const device = value.device;
      const path = `/htmx/settings/auth/${id}`;
      const selector = `#${id}-authorization`;
      return h`<section id="${id}-authorization" class="provider-authorization" ${value.state === "authorizing" ? h`hx-get="/htmx/settings" hx-trigger="load delay:2s" hx-target="this" hx-select="${selector}" hx-swap="outerMorph" hx-push-url="false"` : ""}>
    <h3 data-state="${value.state}">${label}${identity ? h`<span class="account-identity" aria-label="Account ID" title="${identity}">${identity}</span>` : ""}${value.state === "usable" ? "" : h`<span role="status" title="${labels[value.state]}">${labels[value.state]}</span>`}</h3>
    ${value.error ? h`<p role="alert">Authorization failed. Try again.</p>` : ""}
    ${device ? h`<p>Enter <code>${device.userCode}</code> at <a href="${device.verificationUri}" target="_blank" rel="noopener noreferrer" hx-boost="false">${label} device authorization</a>.</p>` : ""}
    ${value.state === "unconfigured" ? "" : h`<div class="actions">${value.state === "authorizing" || value.state === "usable" ? h`<form method="post" action="${path}/logout"><button class="icon auth-remove" aria-label="Remove authorization" title="Remove authorization">${icon("trash")}</button></form>` : h`<form method="post" action="${path}/login"><button class="auth-primary">Authorize</button></form>`}</div>`}
  </section>`;
    }),
  );
  return h`<section id="authorization" class="settings-group" aria-labelledby="authorization-title" hx-sync="this:queue last"><h2 id="authorization-title">Auth</h2>${sections}</section>`;
}
