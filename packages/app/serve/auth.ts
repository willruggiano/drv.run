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
type State = (typeof states)[number];
export type AuthorizationStatus = {
  state: State | "unconfigured";
  userId: number | null;
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
function status(value: unknown): AuthorizationStatus {
  const data = object(value);
  if (typeof data.user_id !== "number" || !Number.isSafeInteger(data.user_id) || data.user_id <= 0)
    throw new Error("Invalid GitHub identity.");
  let device: AuthorizationStatus["device"] = null;
  if (data.device !== null) {
    const value = object(data.device);
    if (
      typeof value.user_code !== "string" ||
      !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(value.user_code) ||
      value.verification_uri !== "https://github.com/login/device"
    )
      throw new Error("Invalid device authorization.");
    device = {
      userCode: value.user_code,
      verificationUri: value.verification_uri,
      expiresAt: timestamp(value.expires_at),
    };
  }
  return {
    state: state(data.state),
    userId: data.user_id,
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
    operation: "status" | "login" | "logout",
    signal?: AbortSignal,
  ): Promise<string> {
    const timeout = AbortSignal.timeout(35_000);
    return await new Promise<string>((resolve, reject) => {
      const call = request(
        {
          socketPath: this.socketPath,
          path: `/${operation}`,
          method: operation === "status" ? "GET" : "POST",
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          agent: false,
        },
        (response) => {
          void (async () => {
            if (response.statusCode !== (operation === "status" ? 200 : 204))
              throw new Error("Authorization service rejected the operation.");
            const chunks: Buffer[] = [];
            let size = 0;
            for await (const chunk of response) {
              const bytes = Buffer.from(chunk);
              size += bytes.length;
              if (size > 16_384) throw new Error("Authorization response too large.");
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

  async status(signal?: AbortSignal): Promise<AuthorizationStatus> {
    try {
      return status(JSON.parse(await this.request("status", signal)) as unknown);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return { state: "unconfigured", userId: null, expiresAt: null, error: null, device: null };
      throw new FormError(503, "The host credential service is unavailable.");
    }
  }

  async change(operation: "login" | "logout", signal?: AbortSignal): Promise<void> {
    try {
      await this.request(operation, signal);
    } catch {
      throw new FormError(503, "The host credential service could not complete the operation.");
    }
  }
}
