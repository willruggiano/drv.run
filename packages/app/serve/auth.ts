import { createModels } from "@earendil-works/pi-ai/models";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { FormError } from "./forms.ts";
import { request } from "node:http";
import { userInfo } from "node:os";

const states = [
  "not-enrolled",
  "usable",
  "temporarily-unavailable",
  "reauthorization-required",
  "authorizing",
] as const;
export const authorizationProviders = [
  { id: "openai", label: "OpenAI" },
  { id: "github", label: "GitHub" },
] as const;
export type AuthorizationProvider = (typeof authorizationProviders)[number]["id"];
type State = (typeof states)[number];
export type AuthorizationStatus = {
  state: State | "unconfigured";
  userId: number | null;
  accountId?: string | null;
  expiresAt: number | null;
  error: State | null;
  device: { userCode: string; verificationUri: string; expiresAt: number } | null;
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid authorization response.");
  return value as Record<string, unknown>;
}
function state(value: unknown): State {
  const found = states.find((state) => state === value);
  if (!found) throw new Error("Invalid authorization state.");
  return found;
}
function timestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 8.64e12)
    throw new Error("Invalid authorization expiry.");
  return value;
}
function status(value: unknown, provider: AuthorizationProvider): AuthorizationStatus {
  const data = object(value);
  if (
    provider === "github" &&
    (typeof data.user_id !== "number" || !Number.isSafeInteger(data.user_id) || data.user_id <= 0)
  )
    throw new Error("Invalid GitHub identity.");
  if (
    provider === "openai" &&
    (data.user_id !== null ||
      ((data.state === "usable" || data.expires_at != null || data.account_id != null) &&
        (typeof data.account_id !== "string" || !data.account_id)))
  )
    throw new Error("Invalid OpenAI identity.");
  let device: AuthorizationStatus["device"] = null;
  if (data.device !== null) {
    const value = object(data.device);
    const verificationUri =
      provider === "github"
        ? "https://github.com/login/device"
        : "https://auth.openai.com/codex/device";
    if (
      typeof value.user_code !== "string" ||
      !(provider === "github" ? /^[A-Z0-9]{4}-[A-Z0-9]{4}$/ : /^[A-Za-z0-9-]{4,32}$/).test(
        value.user_code,
      ) ||
      value.verification_uri !== verificationUri
    )
      throw new Error("Invalid device authorization.");
    device = {
      userCode: value.user_code,
      verificationUri,
      expiresAt: timestamp(value.expires_at),
    };
  }
  return {
    state: state(data.state),
    userId: typeof data.user_id === "number" ? data.user_id : null,
    ...(provider === "openai"
      ? { accountId: typeof data.account_id === "string" ? data.account_id : null }
      : {}),
    expiresAt: data.expires_at == null ? null : timestamp(data.expires_at),
    error: data.error === null ? null : state(data.error),
    device,
  };
}

export class ProxyAuthorization {
  readonly socketPath: string;
  constructor(socketPath = `/run/mitm-proxy-auth/${userInfo().username}.sock`) {
    this.socketPath = socketPath;
  }

  private async request(
    operation: "status" | "login" | "logout" | "token",
    signal?: AbortSignal,
    provider: AuthorizationProvider = "github",
  ): Promise<string> {
    const timeout = AbortSignal.timeout(35_000);
    return await new Promise<string>((resolve, reject) => {
      const call = request(
        {
          socketPath: this.socketPath,
          path: `${provider === "openai" ? "/openai" : ""}/${operation}`,
          method: operation === "status" ? "GET" : "POST",
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          agent: false,
        },
        (response) => {
          void (async () => {
            if (
              response.statusCode !== (operation === "status" || operation === "token" ? 200 : 204)
            )
              throw new Error("Authorization service rejected the operation.");
            const chunks: Buffer[] = [];
            let size = 0;
            for await (const chunk of response) {
              const bytes = Buffer.from(chunk);
              size += bytes.length;
              if (size > (operation === "token" ? 65_536 : 16_384))
                throw new Error("Authorization response too large.");
              chunks.push(bytes);
            }
            resolve(Buffer.concat(chunks).toString("utf8"));
          })().catch((error: unknown) => {
            response.destroy();
            reject(error);
          });
        },
      );
      call.once("error", reject);
      call.end();
    });
  }

  async status(
    signal?: AbortSignal,
    provider: AuthorizationProvider = "github",
  ): Promise<AuthorizationStatus> {
    try {
      return status(
        JSON.parse(await this.request("status", signal, provider)) as unknown,
        provider,
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return { state: "unconfigured", userId: null, expiresAt: null, error: null, device: null };
      throw new FormError(503, "The host credential service is unavailable.");
    }
  }

  async change(
    operation: "login" | "logout",
    signal?: AbortSignal,
    provider: AuthorizationProvider = "github",
  ): Promise<void> {
    try {
      await this.request(operation, signal, provider);
    } catch {
      throw new FormError(503, "The host credential service could not complete the operation.");
    }
  }

  async openaiToken(signal?: AbortSignal): Promise<string> {
    try {
      const data = object(JSON.parse(await this.request("token", signal, "openai")) as unknown);
      if (
        typeof data.access_token !== "string" ||
        !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(data.access_token) ||
        timestamp(data.expires_at) <= Date.now() / 1000 ||
        typeof data.account_id !== "string" ||
        !data.account_id
      )
        throw new Error("Invalid OpenAI credential response.");
      return data.access_token;
    } catch {
      throw new FormError(
        503,
        "OpenAI credentials are unavailable. Check OpenAI authorization in global settings.",
      );
    }
  }
}

export function hostModels(authorization: ProxyAuthorization) {
  const models = createModels();
  for (const provider of builtinProviders()) {
    // The credential service owns OAuth enrollment and refresh. Pi receives a
    // current bearer JWT at request time; it never stores a refresh token.
    models.setProvider(
      provider.id === "openai-codex"
        ? {
            ...provider,
            auth: {
              apiKey: {
                name: "Host OpenAI OAuth",
                async check({ signal }) {
                  const status = await authorization.status(signal, "openai");
                  return status.state === "usable" ||
                    (status.state === "temporarily-unavailable" && status.accountId)
                    ? { source: "Host OpenAI OAuth", type: "oauth" }
                    : undefined;
                },
                async resolve({ signal }) {
                  return {
                    auth: { apiKey: await authorization.openaiToken(signal) },
                    source: "Host OpenAI OAuth",
                  };
                },
              },
            },
          }
        : provider,
    );
  }
  return models;
}
