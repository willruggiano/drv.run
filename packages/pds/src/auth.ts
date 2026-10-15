import assert from "node:assert/strict";
import { request } from "node:http";
import { userInfo } from "node:os";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

const unavailable =
  "OpenAI credentials are unavailable. Check OpenAI authorization in app settings.";

async function read(socketPath: string, operation: "status" | "token", signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(35_000);
  const abort = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const value: unknown = await new Promise((resolve, reject) => {
      const call = request(
        {
          socketPath,
          path: `/openai/${operation}`,
          method: operation === "status" ? "GET" : "POST",
          signal: abort,
          agent: false,
        },
        (response) => {
          void (async () => {
            if (response.statusCode !== 200) throw new Error(unavailable);
            const chunks: Buffer[] = [];
            let size = 0;
            for await (const chunk of response) {
              const bytes = Buffer.from(chunk);
              size += bytes.length;
              if (size > (operation === "token" ? 65_536 : 16_384)) throw new Error(unavailable);
              chunks.push(bytes);
            }
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
          })().catch((error: unknown) => {
            response.destroy();
            reject(error);
          });
        },
      );
      call.once("error", reject);
      call.end();
    });
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(unavailable);
    return value as Record<string, unknown>;
  } catch (error) {
    abort.throwIfAborted();
    if (
      operation === "status" &&
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return undefined;
    // Never expose credential-service response bodies or JSON parser errors to the browser.
    throw new Error(unavailable);
  }
}

export function hostModels(socketPath = `/run/mitm-proxy-auth/${userInfo().username}.sock`) {
  const models = builtinModels();
  const provider = models.getProvider("openai-codex");
  assert(provider);
  models.setProvider({
    ...provider,
    // The host owns enrollment and refresh. Resolve a current bearer token per request;
    // do not persist credentials or expose a second OAuth flow in PDS.
    auth: {
      apiKey: {
        name: "Host OpenAI OAuth",
        async check({ signal }) {
          const data = await read(socketPath, "status", signal);
          if (!data) return undefined;
          if (
            typeof data.state !== "string" ||
            ![
              "not-enrolled",
              "usable",
              "temporarily-unavailable",
              "reauthorization-required",
              "authorizing",
            ].includes(data.state)
          )
            throw new Error(unavailable);
          const account = typeof data.account_id === "string" && data.account_id.length > 0;
          if (data.state === "usable" && !account) throw new Error(unavailable);
          return data.state === "usable" || (data.state === "temporarily-unavailable" && account)
            ? { source: "Host OpenAI OAuth", type: "oauth" }
            : undefined;
        },
        async resolve({ signal }) {
          const data = await read(socketPath, "token", signal);
          const token = data?.access_token;
          const expires = data?.expires_at;
          if (
            typeof token !== "string" ||
            !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token) ||
            typeof expires !== "number" ||
            !Number.isFinite(expires) ||
            expires <= Date.now() / 1000 ||
            expires > 8.64e12 ||
            typeof data?.account_id !== "string" ||
            !data.account_id
          )
            throw new Error(unavailable);
          return { auth: { apiKey: token }, source: "Host OpenAI OAuth" };
        },
      },
    },
  });
  return models;
}
