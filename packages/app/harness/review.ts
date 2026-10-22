import assert from "node:assert/strict";
import { posix } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import {
  AgentDoc,
  defineDoc,
  defineExtension,
  GenerationTask,
  hook,
  section,
  wrapTool,
  type ConversationId,
  type HarnessOptions,
  type ToolExecutionApi,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { createEditTool, createWriteTool } from "@earendil-works/pi-durable/tools";

export const Review = defineDoc<{
  original?: ConversationId;
  active?: ConversationId;
}>({
  kind: "app.review",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({}),
});

export function createReviewExtension(environment: HarnessOptions["env"]) {
  async function mutationPath(path: string, api: ToolExecutionApi, context: Context) {
    if ((await api.snapshot(Review, api.conversationId, context))?.original === undefined)
      return path;
    assert(api.env, "Review requires an execution environment.");
    const target = getOrThrow(await api.env.absolutePath("REVIEW.md", context));
    if (getOrThrow(await api.env.absolutePath(path, context)) !== target) return undefined;
    const file = await api.env.fileInfo(target, context);
    if (file.ok && file.value.kind !== "file") return undefined;
    if (!file.ok && file.error.code !== "not_found") throw file.error;
    // Pass a fixed relative path so the tool's own path normalization cannot redirect it.
    return "REVIEW.md";
  }
  const blocked = {
    isError: true,
    diagnostics: [
      {
        severity: "error" as const,
        code: "review_path",
        message:
          "Reviews may edit or write only REVIEW.md in the current working directory (not a symlink).",
      },
    ],
  };
  return defineExtension<ToolRegistration>({
    name: "review",
    sections: [
      section("review", async (input, context) => {
        if (
          (await input.read.snapshot(Review, input.conversationId, context))?.original === undefined
        )
          return;
        return 'Write actionable findings with file and line references to REVIEW.md in the current working directory, then tell the user where the review is. If there are no findings, include the exact text "No findings." in your response. Do not modify other files.';
      }),
      section("review-guidelines", async (input, context) => {
        if (
          (await input.read.snapshot(Review, input.conversationId, context))?.original === undefined
        )
          return;
        assert(input.env, "Review requires an execution environment.");
        const file = await input.env.readTextFile("REVIEW_GUIDELINES.md", context);
        if (!file.ok && file.error.code === "not_found") return;
        return getOrThrow(file);
      }),
    ],
    wraps: [
      wrapTool(createEditTool(), (tool) => ({
        ...tool,
        async execute(args, api, context) {
          const path = await mutationPath(args.path, api, context);
          return path === undefined ? blocked : tool.execute({ ...args, path }, api, context);
        },
      })),
      wrapTool(createWriteTool(), (tool) => ({
        ...tool,
        async execute(args, api, context) {
          const path = await mutationPath(args.path, api, context);
          return path === undefined ? blocked : tool.execute({ ...args, path }, api, context);
        },
      })),
    ],
    hooks: [
      hook(GenerationTask, {
        async onYield(answer, api, context) {
          if ((await api.snapshot(Review, api.conversationId, context))?.original === undefined)
            return;
          const text = answer.content
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("");
          if (text.includes("No findings.")) return;
          try {
            const agent = await api.snapshot(AgentDoc, api.conversationId, context);
            const env = await environment?.(
              {
                conversationId: api.conversationId,
                cwd: agent?.cwd,
                read: api,
              },
              context,
            );
            if (env) {
              const file = await env.fileInfo(posix.join(env.cwd, "REVIEW.md"), context);
              if (file.ok && file.value.kind === "file") return;
            }
          } catch (error) {
            if (context.abortSignal?.aborted) throw error;
            // A failed check is not permission to finish. Hook exceptions otherwise get skipped.
          }
          return {
            continue:
              'Write your review to REVIEW.md in the current working directory before finishing. If there are no findings, include the exact text "No findings." in your response.',
          };
        },
      }),
    ],
  });
}
