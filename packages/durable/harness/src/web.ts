import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { Context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

async function request(endpoint: "search" | "extract", body: object, context: Context) {
  // Read on the host, never through api.env. Re-read so SOPS key rotation needs no restart.
  const path = process.env.PARALLEL_API_KEY_FILE;
  assert(path, "Configure PARALLEL_API_KEY_FILE on the host to use web tools.");
  const key = (await readFile(path, "utf8")).trim();
  assert(key, "The host Parallel API key file is empty.");
  const timeout = AbortSignal.timeout(60_000);
  const response = await fetch(`https://api.parallel.ai/v1/${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key },
    body: JSON.stringify(body),
    redirect: "error",
    signal: context.abortSignal ? AbortSignal.any([context.abortSignal, timeout]) : timeout,
  });
  if (!response.ok) {
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    const error =
      typeof payload === "object" &&
      payload !== null &&
      "type" in payload &&
      payload.type === "error" &&
      "error" in payload &&
      typeof payload.error === "object" &&
      payload.error !== null
        ? payload.error
        : {};
    const text = JSON.stringify({
      endpoint,
      status: response.status,
      message:
        "message" in error && typeof error.message === "string"
          ? error.message
          : "No valid Parallel API error message returned.",
      ref_id: "ref_id" in error && typeof error.ref_id === "string" ? error.ref_id : undefined,
      detail: "detail" in error ? error.detail : undefined,
      retry_after: response.headers.get("retry-after") ?? undefined,
      hint:
        response.status === 401 || response.status === 403
          ? "Ask the host operator to check the Parallel API key in SOPS and account permissions. Do not put credentials in the guest."
          : undefined,
    });
    // Only expose documented fields; redact the token even inside nested detail or object keys.
    return {
      isError: true,
      output: [
        {
          type: "text" as const,
          text: text.replaceAll(JSON.stringify(key).slice(1, -1), "[REDACTED]"),
        },
      ],
    };
  }
  return { output: [{ type: "text" as const, text: await response.text() }] };
}

export function createWebExtension() {
  return defineExtension({
    name: "web",
    tools: [
      defineTool({
        name: "web_search",
        description:
          "Search the web for sources and raw excerpts. Provide a self-contained objective and 2-3 concise keyword queries when possible. Cite returned source URLs.",
        parameters: Type.Object({
          objective: Type.String({ minLength: 1 }),
          search_queries: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
        }),
        execute: (args, _api, context) => request("search", { ...args, mode: "fast" }, context),
      }),
      defineTool({
        name: "web_fetch",
        description:
          "Extract readable content from known URLs. Batch up to 20 URLs. Optionally focus excerpts with an objective and keyword queries; otherwise return whole-page markdown. Cite returned source URLs.",
        parameters: Type.Object({
          urls: Type.Array(Type.String({ pattern: "^https?://[^\\s]+$" }), {
            minItems: 1,
            maxItems: 20,
          }),
          objective: Type.Optional(Type.String({ minLength: 1 })),
          search_queries: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
        }),
        execute: (args, _api, context) => request("extract", args, context),
      }),
    ],
  });
}
