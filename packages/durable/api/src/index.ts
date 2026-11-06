import assert from "node:assert/strict";
import { STATUS_CODES, type IncomingMessage, type ServerResponse } from "node:http";
import {
  BACKGROUND_CONTEXT,
  awaitWithContext,
  withAbortSignal,
} from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import {
  ConversationBusy,
  SessionFailed,
  type Harness,
  type ConversationId,
} from "@earendil-works/pi-durable";
import { getSupportedThinkingLevels, type Models } from "@earendil-works/pi-ai/models";
import { decode, parseId } from "./request.ts";
import { execute } from "./operations.ts";
import { Problem } from "./problem.ts";
import { Sessions } from "./sessions.ts";
import { stream } from "./stream.ts";

export interface ApiOptions {
  /** Borrow the factory's Pi AI catalog; resolve a dynamic source per request. */
  models: Models | (() => Models);
  /** Return undefined for an absent session. Own partial-open cleanup on failure. */
  openHarness(sessionId: string, context: Context): Promise<Harness | undefined>;
  /** Maximum encoded JSON body size in bytes. Defaults to 1 MiB. */
  bodyLimit?: number;
}

/** Deployment owns the HTTP listener and telemetry runtime; the API owns opened Harnesses. */
export function createApi(options: ApiOptions) {
  const limit = options.bodyLimit ?? 1024 * 1024;
  if (!Number.isSafeInteger(limit) || limit <= 0)
    throw new RangeError("bodyLimit must be a positive safe integer");
  const sessions = new Sessions((id, context) => options.openHarness(id, context));
  return {
    close: () => sessions.close(),
    async handle(this: void, request: IncomingMessage, response: ServerResponse): Promise<void> {
      const controller = new AbortController();
      const cancel = () => controller.abort();
      response.once("close", cancel);
      const context = withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
      let sessionId: string | undefined;
      let conversationId: ConversationId | undefined;
      let operation: string | undefined;
      try {
        const url = new URL(request.url!, "http://durable.invalid");
        if (url.pathname === "/api/models") operation = "models";
        else {
          const path = /^\/api\/s\/([^/]+)\/(?:c\/([^/]+)\/(.+)|([^/]+))$/.exec(url.pathname);
          if (!path) throw new Problem(404);
          try {
            sessionId = decodeURIComponent(path[1]!);
          } catch {
            throw new Problem(400);
          }
          if (path[2] !== undefined) conversationId = parseId(path[2]);
          operation = path[3] ?? path[4]!;
        }
        const scope =
          sessionId === undefined
            ? "service"
            : conversationId === undefined
              ? "session"
              : "conversation";
        const input = await decode(request, url, operation, scope, limit);
        let result: Awaited<ReturnType<typeof execute>>;
        if (input.operation === "models") {
          const models = typeof options.models === "function" ? options.models() : options.models;
          const available = await models.getAvailable(undefined, { signal: controller.signal });
          result = {
            value: available.map((model) => ({
              id: model.id,
              provider: model.provider,
              name: model.name,
              input: model.input,
              reasoning: model.reasoning,
              contextWindow: model.contextWindow,
              maxTokens: model.maxTokens,
              cost: model.cost,
              thinkingLevels: getSupportedThinkingLevels(model),
            })),
          };
        } else {
          assert(sessionId !== undefined);
          const harness = await awaitWithContext(sessions.get(sessionId), context);
          result = await execute(harness, conversationId, input, context);
        }
        if ("watch" in result) await stream(response, result.watch);
        else {
          const body = JSON.stringify(result.value);
          response
            .writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" })
            .end(body);
        }
      } catch (error) {
        if (response.destroyed) return;
        if (response.headersSent) {
          response.destroy();
          return;
        }
        const status =
          error instanceof Problem
            ? error.status
            : error instanceof SessionFailed && sessionId !== undefined
              ? 503
              : error instanceof ConversationBusy && operation === "submit"
                ? 409
                : 500;
        response
          .writeHead(status, {
            "Content-Type": "application/problem+json",
            "Cache-Control": "no-store",
            ...(error instanceof Problem && error.allow ? { Allow: error.allow } : {}),
          })
          .end(
            JSON.stringify({
              type: "about:blank",
              title: status === 413 ? "Content Too Large" : STATUS_CODES[status],
              status,
              ...(sessionId === undefined ? {} : { sessionId }),
              ...(conversationId === undefined ? {} : { conversationId }),
            }),
          );
      } finally {
        request.resume();
        response.off("close", cancel);
      }
    },
  };
}
