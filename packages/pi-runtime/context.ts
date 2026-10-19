import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import type { Message, Models } from "@earendil-works/pi-ai";
import {
  defineDoc,
  defineExtension,
  GenerationTask,
  hook,
  ResetEntry,
  section,
  wrapTool,
  type Conversation,
  type ConversationId,
  type Cursor,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { getOrThrow, type ExecutionEnv } from "@earendil-works/pi-durable/env";
import { createEditTool, createWriteTool } from "@earendil-works/pi-durable/tools";

export type ContextFile = {
  level: "system" | "user" | "repo";
  path: string;
  content: string;
};
type LoadedContext = { scope: string; files: ContextFile[] };
type ContextState = {
  scope?: string;
  reset?: number;
  contributing: boolean;
  supplied?: string;
};

// Discovery is not delivery. Only beforeRequest may update `supplied`.
export const ContextFiles = defineDoc<ContextState>({
  kind: "app.context",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({ contributing: false }),
});

/** XDG lists put the highest priority directory first; prompt layers go last-wins. */
export function contextPaths(home: string, configHome: string, configDirs: string): string[] {
  assert(posix.isAbsolute(home), "The execution environment must provide an absolute HOME.");
  const directories = [
    ...new Set(
      (configDirs || "/etc/xdg").split(":").filter((directory) => posix.isAbsolute(directory)),
    ),
  ];
  return [
    ...directories.reverse().map((directory) => posix.join(directory, "llms.txt")),
    posix.join(posix.isAbsolute(configHome) ? configHome : posix.join(home, ".config"), "llms.txt"),
  ];
}

async function configurationPaths(env: ExecutionEnv, context: Context): Promise<string[]> {
  let output = "";
  const result = getOrThrow(
    await env.exec(
      'printf \'%s\\0\' "${HOME-}" "${XDG_CONFIG_HOME-}" "${XDG_CONFIG_DIRS-}"',
      {
        timeout: 10,
        onOutput(text, _, info) {
          if (info.stream === "stdout") output += text;
        },
      },
      context,
    ),
  );
  assert.equal(result.exitCode, 0, "Could not resolve context paths in the execution environment.");
  const values = output.split("\0");
  assert(values.length === 4 && values[3] === "", "Invalid execution environment context paths.");
  return contextPaths(values[0], values[1], values[2]);
}

async function repositoryRoot(env: ExecutionEnv, context: Context): Promise<string> {
  const cwd = getOrThrow(await env.canonicalPath(env.cwd, context));
  let directory = cwd;
  while (true) {
    // A linked worktree has a .git file, not a directory. Never follow it into the main worktree.
    const marker = await env.fileInfo(posix.join(directory, ".git"), context);
    if (marker.ok) return directory;
    if (marker.error.code !== "not_found") throw marker.error;
    const parent = posix.dirname(directory);
    if (parent === directory) return cwd; // Non-Git projects use their base directory.
    directory = parent;
  }
}

/** All discovery and reads use the selected environment, including HOME and XDG variables. */
export async function loadContextFiles(
  env: ExecutionEnv,
  contributing: boolean,
  context: Context,
): Promise<LoadedContext> {
  const paths = await configurationPaths(env, context);
  const root = await repositoryRoot(env, context);
  const candidates: { level: ContextFile["level"]; path: string }[] = paths.map((path, index) => ({
    level: index === paths.length - 1 ? "user" : "system",
    path,
  }));
  candidates.push({ level: "repo", path: posix.join(root, "README.md") });
  if (contributing) candidates.push({ level: "repo", path: posix.join(root, "CONTRIBUTING.md") });
  const files = new Map<string, ContextFile>();
  for (const candidate of candidates) {
    const opened = await env.openBinaryReader(candidate.path, undefined, context);
    if (!opened.ok) {
      if (opened.error.code === "not_found") continue;
      throw opened.error;
    }
    const reader = opened.value;
    try {
      const { size } = getOrThrow(await reader.info(context));
      // Reject rather than silently truncating instructions. Also excludes unbounded reads.
      assert(size <= 1024 * 1024, `Context file exceeds 1 MiB: ${candidate.path}`);
      const bytes = getOrThrow(await reader.read(0, size + 1, context));
      assert.equal(bytes.length, size, `Context file changed while reading: ${candidate.path}`);
      const canonical = getOrThrow(await env.canonicalPath(candidate.path, context));
      // XDG directories can expose the same Nix-store file through several symlinks.
      files.delete(canonical);
      files.set(canonical, {
        ...candidate,
        content: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      });
    } finally {
      await reader.close(context);
    }
  }
  return { scope: JSON.stringify([env.id, root]), files: [...files.values()] };
}

function digest(loaded: LoadedContext): string {
  return createHash("sha256").update(JSON.stringify(loaded)).digest("hex");
}

async function resetBoundary(
  conversation: Conversation,
  context: Context,
): Promise<number | undefined> {
  // Inspect history, not just the active head: a compaction may already have replaced a reset.
  let cursor: Cursor | undefined;
  do {
    const page = await conversation.entries({}, 100, cursor, context);
    const reset = page.items.find((entry) => ResetEntry.is(entry));
    if (reset) return reset.id;
    cursor = page.next;
  } while (cursor);
  return undefined;
}

type ContextPrompt = LoadedContext & { reset?: number; contributing: boolean };

function requestContext(messages: readonly Message[]): ContextPrompt | undefined {
  let rendered: string | null | undefined;
  for (const message of messages) {
    if (message.role === "system" && message.sections && "context" in message.sections)
      rendered = message.sections.context;
  }
  if (rendered === undefined) return undefined; // Compaction and standalone model calls have no context section.
  assert(rendered, "Required context was not prepared.");
  const value: ContextPrompt & { error?: string } = JSON.parse(rendered);
  assert(!value.error, value.error);
  assert(
    typeof value.scope === "string" && Array.isArray(value.files),
    "Invalid prepared context.",
  );
  return value;
}

/** Durable reports hook errors and continues. Validate at dispatch, where errors actually stop the request. */
export function withContextValidation(models: Models): Models {
  const streamSimple: Models["streamSimple"] = (model, transcript, options) => {
    requestContext(transcript.messages);
    return models.streamSimple(model, transcript, options);
  };
  return new Proxy(models, {
    get(target, property) {
      if (property === "streamSimple") return streamSimple;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export function createContextExtension(
  conversation: (id: ConversationId, context: Context) => Promise<Conversation>,
) {
  async function guard(api: ToolExecutionApi, context: Context): Promise<boolean> {
    assert(api.env, "Context requires the selected execution environment.");
    const loaded = await loadContextFiles(api.env, true, context);
    const current = await conversation(api.conversationId, context);
    const reset = await resetBoundary(current, context);
    const state = await api.snapshot(ContextFiles, api.conversationId, context);
    if (state?.scope === loaded.scope && state.reset === reset && state.supplied === digest(loaded))
      return true;
    await api.commit(async (tx) => {
      const state = await tx.doc(ContextFiles, api.conversationId);
      state.scope = loaded.scope;
      state.reset = reset;
      state.contributing = true;
      // Do not authorize a second call in this batch, even if it already read the file.
      delete state.supplied;
    }, context);
    return false;
  }

  const blocked = {
    isError: true,
    diagnostics: [
      {
        severity: "error" as const,
        code: "context_required",
        message:
          "Project documentation must reach the model before this mutation. End this tool batch; the next model request will receive the current context, including CONTRIBUTING.md when present. Review it, then retry using edit/write, not shell mutations.",
      },
    ],
  };

  return defineExtension({
    name: "context",
    sections: [
      section(
        "context",
        async (input, context) => {
          try {
            assert(input.env, "Context requires the selected execution environment.");
            const current = await conversation(input.conversationId, context);
            const reset = await resetBoundary(current, context);
            const state = await input.read.snapshot(ContextFiles, input.conversationId, context);
            let loaded = await loadContextFiles(input.env, false, context);
            const contributing =
              state?.scope === loaded.scope && state.reset === reset && state.contributing;
            if (contributing) loaded = await loadContextFiles(input.env, true, context);
            return JSON.stringify({
              ...loaded,
              reset,
              contributing: !!contributing,
            } satisfies ContextPrompt);
          } catch (error) {
            if (context.abortSignal?.aborted) throw error;
            // Durable keeps old section text when a renderer throws. Emit an explicit failure instead;
            // the model dispatch guard rejects it, so stale instructions cannot authorize work.
            return JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
        { tag: false },
      ),
    ],
    hooks: [
      hook(GenerationTask, {
        async beforeRequest({ messages }, api, context) {
          const prepared = requestContext(messages);
          assert(prepared, "Required context was not prepared.");
          const current = await conversation(api.conversationId, context);
          await current.commit(async (tx) => {
            const state = await tx.doc(ContextFiles, api.conversationId);
            state.scope = prepared.scope;
            state.reset = prepared.reset;
            state.contributing = prepared.contributing;
            state.supplied = digest({ scope: prepared.scope, files: prepared.files });
          }, context);
        },
      }),
    ],
    wraps: [
      wrapTool(createEditTool(), (tool) => ({
        ...tool,
        execute: async (args, api, context) =>
          (await guard(api, context)) ? tool.execute(args, api, context) : blocked,
      })),
      wrapTool(createWriteTool(), (tool) => ({
        ...tool,
        execute: async (args, api, context) =>
          (await guard(api, context)) ? tool.execute(args, api, context) : blocked,
      })),
    ],
  });
}
