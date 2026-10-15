import { request } from "node:http";
import type { Provider } from "@earendil-works/pi-ai/models";
import Type from "typebox";
import Value from "typebox/value";

const Identity = Type.String({ minLength: 1 });
const Status = Type.Union([
  Type.Object({ state: Type.Literal("usable"), account_id: Identity }),
  Type.Object({
    state: Type.Enum([
      "not-enrolled",
      "temporarily-unavailable",
      "reauthorization-required",
      "authorizing",
    ]),
    account_id: Type.Optional(Type.Union([Identity, Type.Null()])),
  }),
]);
const Token = Type.Object({
  access_token: Type.String({ pattern: "^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$" }),
  account_id: Identity,
  expires_at: Type.Number({ exclusiveMinimum: 0, maximum: 8.64e12 }),
});

const unavailable = () =>
  new Error("Host OpenAI credentials are unavailable. Connect OpenAI in app settings.");

export function hostOpenAIAuth(socketPath: string): Provider["auth"] {
  return {
    apiKey: {
      name: "Host OpenAI OAuth",
      async check({ signal }) {
        const status = await call("status", signal);
        if (status === undefined) return undefined;
        if (!Value.Check(Status, status)) throw unavailable();
        return status.state === "usable" ||
          (status.state === "temporarily-unavailable" && status.account_id)
          ? { source: "Host OpenAI OAuth", type: "oauth" }
          : undefined;
      },
      async resolve({ signal }) {
        const token = await call("token", signal);
        if (!Value.Check(Token, token) || token.expires_at <= Date.now() / 1000)
          throw unavailable();
        return { auth: { apiKey: token.access_token }, source: "Host OpenAI OAuth" };
      },
    },
  };

  async function call(operation: "status" | "token", signal: AbortSignal): Promise<unknown> {
    try {
      return await new Promise<unknown>((resolve, reject) => {
        const call = request(
          {
            socketPath,
            path: `/openai/${operation}`,
            method: operation === "status" ? "GET" : "POST",
            signal: AbortSignal.any([signal, AbortSignal.timeout(35_000)]),
            agent: false,
          },
          (response) => {
            void (async () => {
              if (response.statusCode !== 200) throw unavailable();
              const chunks: Buffer[] = [];
              let size = 0;
              for await (const chunk of response) {
                const bytes = Buffer.from(chunk);
                size += bytes.length;
                if (size > (operation === "status" ? 16_384 : 65_536)) throw unavailable();
                chunks.push(bytes);
              }
              resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
            })().catch((error: unknown) => {
              response.destroy();
              reject(error);
            });
          },
        );
        call.once("error", (error: NodeJS.ErrnoException) => {
          if (operation === "status" && error.code === "ENOENT") resolve(undefined);
          else reject(error);
        });
        call.end();
      });
    } catch {
      signal.throwIfAborted();
      throw unavailable();
    }
  }
}
