import { mkdir, readdir, rename as move, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, posix } from "node:path";
import {
  BACKGROUND_CONTEXT,
  awaitWithContext,
  withoutAbortSignal,
  type Context,
} from "@earendil-works/chord/context";
import type { AssistantMessage, Models, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import {
  DEFAULT_COMPACTION_POLICY,
  AgentDoc,
  ConversationBusy,
  LiveDoc,
  type AgentState,
  defineDoc,
  type Harness,
  configure,
  type Conversation,
  type ConversationView,
  type ConversationId,
  type ModelRef,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

import { openHarness, Review } from "harness";
import { describeContext, type ContextInspection } from "./inspection.ts";
export type { ContextInspection } from "./inspection.ts";
// pi-coding-agent/core/defaults is not exported by Pi's public API.
export const DEFAULT_THINKING_LEVEL: ModelThinkingLevel = "medium";

const context = BACKGROUND_CONTEXT;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function hasControlCharacters(text: string): boolean {
  return Array.from(text).some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
}

export class SessionError extends Error {
  readonly code: "invalid" | "not_found" | "unavailable" | "conflict" | "closing";
  constructor(code: SessionError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export type ExecutionBinding = { provider: string; target: string; cwd: string };
export type ExecutionTarget = ExecutionBinding & {
  label: string;
  available: boolean;
  directoryRoot?: string;
};
export function stateDirectory(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env.XDG_STATE_HOME && isAbsolute(env.XDG_STATE_HOME)
    ? env.XDG_STATE_HOME
    : join(home, ".local", "state");
}

export type SessionInfo = {
  id: string;
  reviewOf?: number;
  name: string;
  binding?: ExecutionBinding;
  cwd: string;
  directoryRoot?: string;
  created: number;
  model?: ModelRef;
  needsResume: boolean;
  thinkingLevel: ModelThinkingLevel;
};
export type ContextStatus = {
  window: number | null;
  autoCompact: boolean;
  /** Last completed response in the current context/model; not a live token estimate. */
  lastResponse: { tokens: number; cacheHit: number | null; entry: number } | null;
};
export type Catalog = {
  targets: ExecutionTarget[];
  sessions: (SessionInfo & { context: ContextStatus })[];
  models: {
    provider: string;
    modelId: string;
    name: string;
    thinkingLevels: ModelThinkingLevel[];
    defaultThinkingLevel: ModelThinkingLevel;
  }[];
  defaultModel?: ModelRef;
};
export type SessionOptions = {
  directory: string;
  models: Models;
  env?: Parameters<typeof openHarness>[1]["env"];
  /** Pre-session browsing resolves a binding without creating a durable conversation. */
  directoryEnv?: (
    binding: ExecutionBinding,
    context: Context,
  ) => ExecutionEnv | Promise<ExecutionEnv>;
  targets?: (context: Context) => Promise<ExecutionTarget[]>;
  close?: () => Promise<void>;
  defaults?: {
    readonly model?: ModelRef;
    readonly thinkingLevel?: ModelThinkingLevel;
    readonly modelThinkingLevels?: Record<string, ModelThinkingLevel>;
  };
  settings?: Parameters<typeof openHarness>[1]["settings"];
  onReport?: (error: unknown) => void;
  onSession?: (session: Session) => void | Promise<void>;
};

export const Metadata = defineDoc<{ created: number; name?: string }>({
  kind: "app.session",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ created: 0 }),
});
export const Environment = defineDoc<{ provider?: string; target?: string }>({
  kind: "app.environment",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({}),
});
type InitialSession = {
  binding?: ExecutionBinding;
  model?: ModelRef;
  thinkingLevel?: ModelThinkingLevel;
  cwd?: string;
};
export type Session = {
  readonly owner: Sessions;
  readonly id: string;
  readonly harness: Harness;
  readonly root: Conversation;
  readonly created: number;
  readonly inspections: Map<number, { key: string; result: Promise<ContextInspection> }>;
};
function validBinding(binding: ExecutionBinding): boolean {
  return [binding.provider, binding.target, binding.cwd].every(
    (value) =>
      typeof value === "string" &&
      value.trim().length > 0 &&
      value.length <= 4096 &&
      !value.includes("\0"),
  );
}
function sameBinding(a: ExecutionBinding, b: ExecutionBinding): boolean {
  return a.provider === b.provider && a.target === b.target && a.cwd === b.cwd;
}

/** Resolve user input beneath a root, including leading-slash input. Not a filesystem sandbox. */
export function resolveBaseDirectory(root: string, value: string): string {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    hasControlCharacters(value) ||
    value.split("/").includes("..")
  )
    throw new SessionError("invalid", "Expected a workspace-relative directory without '..'.");
  return posix.resolve(root, `./${value}`);
}

async function listPaths(
  env: ExecutionEnv,
  query: string,
  directoriesOnly = false,
  context = BACKGROUND_CONTEXT,
): Promise<string[]> {
  context.abortSignal?.throwIfAborted();
  const slash = query.lastIndexOf("/");
  const directory = query.slice(0, slash + 1);
  const prefix = query.slice(slash + 1).toLowerCase();
  const opened = await env.openDirReader(directory || ".", context);
  if (!opened.ok) {
    context.abortSignal?.throwIfAborted();
    if (["not_found", "not_directory"].includes(opened.error.code)) return [];
    throw new SessionError("unavailable", "Cannot list paths in this workspace.");
  }
  const paths: string[] = [];
  try {
    // Bound both scanning and the response; completion must not walk entire trees.
    for (let count = 0; count < 5000; count += 100) {
      const page = await opened.value.next(100, context);
      context.abortSignal?.throwIfAborted();
      if (!page.ok) throw new SessionError("unavailable", "Cannot list paths in this workspace.");
      for (const file of page.value.entries) {
        const name = posix.basename(file.path);
        if (
          !name.toLowerCase().startsWith(prefix) ||
          (!prefix.startsWith(".") && name.startsWith(".")) ||
          hasControlCharacters(name)
        )
          continue;
        let isDirectory = file.kind === "directory";
        if (directoriesOnly && file.kind === "symlink") {
          const canonical = await env.canonicalPath(directory + name, context);
          if (canonical.ok) {
            const info = await env.fileInfo(canonical.value, context);
            isDirectory = info.ok && info.value.kind === "directory";
          }
          context.abortSignal?.throwIfAborted();
        }
        if (directoriesOnly && !isDirectory) continue;
        paths.push(directory + name + (isDirectory ? "/" : ""));
      }
      if (page.value.done) break;
    }
  } finally {
    await opened.value.close(withoutAbortSignal(context));
  }
  return paths.sort((a, b) => a.localeCompare(b)).slice(0, 50);
}

export class Sessions {
  readonly options: SessionOptions;
  readonly opened = new Map<string, Promise<Session>>();
  private closing = false;
  private closed?: Promise<void>;

  private constructor(options: SessionOptions) {
    this.options = options;
  }

  static async open(options: SessionOptions): Promise<Sessions> {
    const sessions = new Sessions(options);
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    return sessions;
  }

  async catalog(context = BACKGROUND_CONTEXT): Promise<Catalog> {
    context.abortSignal?.throwIfAborted();
    const names = await readdir(this.options.directory);
    context.abortSignal?.throwIfAborted();
    const targets = (await this.options.targets?.(context)) ?? [];
    context.abortSignal?.throwIfAborted();
    const sessions = await Promise.all(
      names
        .filter((name) => name.endsWith(".sqlite") && uuid.test(name.slice(0, -7)))
        .map(async (name) => {
          const session = await awaitWithContext(this.get(name.slice(0, -7)), context);
          const watch = await session.root.watch(context);
          try {
            return {
              ...(await sessionInfo(session, session.root, targets, context)),
              context: contextStatus(session, watch.value),
            };
          } finally {
            await watch.stop();
          }
        }),
    );
    return {
      targets,
      sessions: sessions.sort((a, b) => b.created - a.created),
      models: (await this.options.models.getAvailable()).map((model) => ({
        provider: model.provider,
        modelId: model.id,
        name: model.name,
        thinkingLevels: getSupportedThinkingLevels(model),
        defaultThinkingLevel: this.resolveThinking({ provider: model.provider, modelId: model.id }),
      })),
      defaultModel: this.options.defaults?.model,
    };
  }

  async baseDirectory(
    binding: ExecutionBinding,
    value: string,
    context = BACKGROUND_CONTEXT,
  ): Promise<string> {
    context.abortSignal?.throwIfAborted();
    const target = (await this.options.targets?.(context))?.find(
      (item) => item.provider === binding.provider && item.target === binding.target,
    );
    if (!target?.directoryRoot)
      throw new SessionError("invalid", "This target does not support base directories.");
    return resolveBaseDirectory(target.directoryRoot, value);
  }

  async completeDirectories(
    binding: ExecutionBinding,
    query: string,
    context = BACKGROUND_CONTEXT,
  ): Promise<string[]> {
    if (this.closing) throw new SessionError("closing", "Runtime is stopping.");
    const root = await this.baseDirectory(binding, "", context);
    resolveBaseDirectory(root, query);
    context.abortSignal?.throwIfAborted();
    const env = await this.options.directoryEnv?.({ ...binding, cwd: root }, context);
    if (!env) throw new SessionError("unavailable", "Directory browsing is unavailable.");
    return (await listPaths(env, `./${query}`, true, context)).map((path) => path.slice(2));
  }

  resolveThinking(ref: ModelRef, requested?: ModelThinkingLevel): ModelThinkingLevel {
    const model = this.options.models.getModel(ref.provider, ref.modelId);
    if (!model) throw new SessionError("invalid", "Model is unavailable.");
    return clampThinkingLevel(
      model,
      requested ??
        this.options.defaults?.modelThinkingLevels?.[`${ref.provider}/${ref.modelId}`] ??
        this.options.defaults?.thinkingLevel ??
        DEFAULT_THINKING_LEVEL,
    );
  }

  async archive(id: string): Promise<void> {
    if (!uuid.test(id)) throw new SessionError("not_found", "Session not found.");
    const directory = join(this.options.directory, "archive");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // Intentionally move files without coordinating with open harnesses.
    for (const suffix of ["", "-wal", "-shm"]) {
      const name = `${id}.sqlite${suffix}`;
      try {
        await move(join(this.options.directory, name), join(directory, name));
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          if (suffix) continue;
          throw new SessionError("not_found", "Session not found.");
        }
        throw error;
      }
    }
  }

  async get(id: string): Promise<Session> {
    if (!uuid.test(id)) throw new SessionError("not_found", "Session not found.");
    if (this.closing) throw new SessionError("closing", "Runtime is stopping.");
    const existing = this.opened.get(id);
    if (existing) return existing;
    try {
      await stat(join(this.options.directory, `${id}.sqlite`));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        throw new SessionError("not_found", "Session not found.");
      throw error;
    }
    return this.opened.get(id) ?? this.open(id);
  }

  private open(id: string, create?: InitialSession): Promise<Session> {
    if (this.closing) return Promise.reject(new SessionError("closing", "Runtime is stopping."));
    const opened = openSession(this, id, create);
    this.opened.set(id, opened);
    void opened.catch(() => this.opened.delete(id));
    return opened;
  }

  async create(
    id: string,
    binding?: ExecutionBinding,
    model?: ModelRef,
    thinkingLevel?: ModelThinkingLevel,
    baseDirectory?: string,
  ): Promise<Session> {
    if (!uuid.test(id) || (binding !== undefined && !validBinding(binding)))
      throw new SessionError("invalid", "Invalid session or execution binding.");
    if (this.closing) throw new SessionError("closing", "Runtime is stopping.");
    // Snapshot caller-owned values before yielding.
    binding = binding && { ...binding };
    model = model && { ...model };
    const cwd =
      binding &&
      (baseDirectory === undefined
        ? binding.cwd
        : await this.baseDirectory(binding, baseDirectory));
    let found: Session | undefined;
    try {
      found = await this.get(id);
    } catch (error) {
      if (!(error instanceof SessionError && error.code === "not_found")) throw error;
    }
    const session =
      found ??
      (await (this.opened.get(id) ??
        this.open(id, {
          binding,
          model,
          thinkingLevel: model ? this.resolveThinking(model, thinkingLevel) : thinkingLevel,
          cwd,
        })));
    const info = await sessionInfo(session);
    if (
      (binding && (!info.binding || !sameBinding(info.binding, binding) || info.cwd !== cwd)) ||
      (model && (info.model?.provider !== model.provider || info.model?.modelId !== model.modelId))
    )
      throw new SessionError("conflict", "Session ID already belongs to a different session.");
    return session;
  }

  close(): Promise<void> {
    this.closing = true;
    return (this.closed ??= (async () => {
      const results = await Promise.allSettled(
        [...this.opened.values()].map(async (session) => (await session).harness.close(context)),
      );
      await this.options.close?.();
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    })());
  }
}

async function openSession(owner: Sessions, id: string, create?: InitialSession): Promise<Session> {
  const storage = await openNodeSqliteStorage(join(owner.options.directory, `${id}.sqlite`));
  const harness = await openHarness(
    storage,
    {
      models: owner.options.models,
      env: owner.options.env,
      get settings() {
        return owner.options.settings;
      },
      onReport: owner.options.onReport,
      async conversationCreated(tx, conversation) {
        if (conversation.parent) return;
        const selected = await tx.doc(Environment, conversation.id);
        if (conversation.owner)
          Object.assign(selected, await tx.doc(Environment, conversation.owner.conversationId));
      },
    },
    context,
  );
  try {
    const root = await harness.root(
      context,
      create
        ? {
            agent: { model: create.model, thinkingLevel: create.thinkingLevel, cwd: create.cwd },
            init: async (tx, conversationId) => {
              (await tx.doc(Metadata, conversationId)).created = Date.now();
              if (create.binding)
                Object.assign(await tx.doc(Environment, conversationId), {
                  provider: create.binding.provider,
                  target: create.binding.target,
                });
            },
          }
        : undefined,
    );
    const metadata = await harness.snapshot(Metadata, root.id, context);
    const session = {
      owner,
      id,
      harness,
      root,
      created: metadata?.created ?? 0,
      inspections: new Map(),
    };
    await owner.options.onSession?.(session);
    return session;
  } catch (error) {
    await harness.close(context);
    throw error;
  }
}
export async function environment(
  session: Session,
  conversation = session.root,
  context = BACKGROUND_CONTEXT,
): Promise<ExecutionEnv> {
  const agent = await conversation.agent(context);
  context.abortSignal?.throwIfAborted();
  const env = await session.owner.options.env?.(
    { conversationId: conversation.id, cwd: agent.cwd, read: session.harness },
    context,
  );
  if (!env) throw new SessionError("unavailable", "No execution environment selected.");
  return env;
}
export async function selectEnvironment(
  session: Session,
  binding: ExecutionBinding,
  conversation = session.root,
): Promise<void> {
  if (!validBinding(binding)) throw new SessionError("invalid", "Invalid execution destination.");
  await conversation.commit(async (tx) => {
    Object.assign(await tx.doc(Environment, conversation.id), {
      provider: binding.provider,
      target: binding.target,
    });
    await configure(tx, conversation.id, { cwd: binding.cwd });
  }, context);
}
/** Complete relative paths in the bound environment, never the server's filesystem. */
export async function completePaths(
  session: Session,
  query: string,
  conversation = session.root,
  context = BACKGROUND_CONTEXT,
): Promise<string[]> {
  if (
    query.length > 4096 ||
    hasControlCharacters(query) ||
    query.startsWith("/") ||
    query.split("/").includes("..")
  )
    throw new SessionError("invalid", "Expected a workspace-relative path.");
  const env = await environment(session, conversation, context);
  return (await listPaths(env, `./${query}`, false, context)).map((path) => path.slice(2));
}

/** Change only this conversation; paths are literal, not shell expressions. */
export async function changeDirectory(
  session: Session,
  argument: string,
  conversation = session.root,
  context = BACKGROUND_CONTEXT,
): Promise<void> {
  if (argument.length > 4096 || hasControlCharacters(argument))
    throw new SessionError("invalid", "Invalid directory.");
  const before = await conversation.agent(context);
  const binding = await session.harness.snapshot(Environment, conversation.id, context);
  const env = await environment(session, conversation, context);
  const canonical = await env.canonicalPath(argument.trim() || "~", context);
  context.abortSignal?.throwIfAborted();
  if (!canonical.ok) throw new SessionError("invalid", "Directory is unavailable.");
  const info = await env.fileInfo(canonical.value, context);
  context.abortSignal?.throwIfAborted();
  if (!info.ok || info.value.kind !== "directory")
    throw new SessionError("invalid", "Expected an existing directory.");
  await conversation.commit(async (tx) => {
    if ((await tx.doc(LiveDoc, conversation.id)).run !== undefined)
      throw new ConversationBusy(conversation.id);
    const current = await tx.doc(AgentDoc, conversation.id);
    const selected = await tx.doc(Environment, conversation.id);
    if (
      current.cwd !== before.cwd ||
      selected.provider !== binding?.provider ||
      selected.target !== binding?.target
    )
      throw new SessionError("conflict", "Execution environment changed; retry /cd.");
    await configure(tx, conversation.id, { cwd: canonical.value });
  }, context);
}

export async function completeWorkingDirectories(
  session: Session,
  query: string,
  conversation = session.root,
  context = BACKGROUND_CONTEXT,
): Promise<string[]> {
  if (query.length > 4096 || hasControlCharacters(query))
    throw new SessionError("invalid", "Invalid directory.");
  const env = await environment(session, conversation, context);
  return listPaths(env, query, true, context);
}

/** Capture at the supplied watch boundary, including its agent configuration.
 * Live-document updates reuse this result without scanning the transcript. */
export function inspectContext(
  session: Session,
  view: ConversationView,
  caller = BACKGROUND_CONTEXT,
): Promise<ContextInspection> {
  const id = view.conversation.id;
  const model = (view.docs["pi.agent"] as AgentState | undefined)?.model ?? null;
  const capacity = model
    ? (session.owner.options.models.getModel(model.provider, model.modelId)?.contextWindow ?? null)
    : null;
  const policy = { ...DEFAULT_COMPACTION_POLICY, ...session.owner.options.settings?.compaction };
  const first = view.entries[0]?.id;
  const last = view.entries.at(-1)?.id;
  const tail = first !== undefined && (last === undefined || first > last) ? first : last;
  const key = JSON.stringify([tail, model, capacity, policy]);
  const cached = session.inspections.get(id);
  if (cached?.key === key) return awaitWithContext(cached.result, caller);
  // The session owns this shared projection. Cancellation ends only the caller's wait.
  const result = (async (): Promise<ContextInspection> => {
    try {
      const projection =
        tail === undefined
          ? { head: undefined, entries: [], contributions: [], messages: [] }
          : await (await getConversation(session, id)).context(context, { at: tail });
      return describeContext(projection, id, model, capacity, policy);
    } catch {
      // Do not cache failures or show the preceding conversation as current.
      if (session.inspections.get(id)?.key === key) session.inspections.delete(id);
      return { state: "unavailable", conversation: id };
    }
  })();
  session.inspections.set(id, { key, result });
  return awaitWithContext(result, caller);
}

export function contextStatus(session: Session, view: ConversationView): ContextStatus {
  const agent = view.docs["pi.agent"] as AgentState | undefined;
  const model =
    agent?.model &&
    session.owner.options.models.getModel(agent.model.provider, agent.model.modelId);
  const head = view.entries.reduce(
    (head, entry) => (entry.head === undefined ? head : Math.max(head, entry.id)),
    -1,
  );
  let last: { message: AssistantMessage; entry: number } | undefined;
  for (const entry of view.entries) {
    if (entry.id <= head || (last && entry.id <= last.entry)) continue;
    const message = entry.model
      ?.slice()
      .reverse()
      .find(
        (message): message is AssistantMessage =>
          message.role === "assistant" &&
          message.stopReason !== "error" &&
          message.stopReason !== "aborted",
      );
    if (message) last = { message, entry: entry.id };
  }
  let lastResponse: ContextStatus["lastResponse"] = null;
  if (
    last &&
    last.message.provider === agent?.model?.provider &&
    last.message.model === agent?.model?.modelId
  ) {
    const usage = last.message.usage;
    const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
    const tokens = usage.totalTokens || prompt + usage.output;
    if (tokens > 0)
      lastResponse = {
        tokens,
        cacheHit: prompt > 0 ? (usage.cacheRead / prompt) * 100 : null,
        entry: last.entry,
      };
  }
  return {
    window: model?.contextWindow ?? null,
    autoCompact:
      session.owner.options.settings?.compaction?.enabled ?? DEFAULT_COMPACTION_POLICY.enabled,
    lastResponse,
  };
}

export async function sessionInfo(
  session: Session,
  conversation = session.root,
  targets?: readonly ExecutionTarget[],
  context = BACKGROUND_CONTEXT,
): Promise<SessionInfo> {
  const agent = await conversation.agent(context);
  const metadata = await session.harness.snapshot(Metadata, session.root.id, context);
  const selected = await session.harness.snapshot(Environment, conversation.id, context);
  const review = await session.harness.snapshot(Review, conversation.id, context);
  context.abortSignal?.throwIfAborted();
  targets ??= (await session.owner.options.targets?.(context)) ?? [];
  const target = targets.find(
    (item) => item.provider === selected?.provider && item.target === selected.target,
  );
  const inspection = await session.harness.inspect(context);
  return {
    id: session.id,
    name: metadata?.name ?? "",
    reviewOf: review?.original,
    binding:
      selected?.provider && selected.target
        ? {
            provider: selected.provider,
            target: selected.target,
            cwd: target?.cwd ?? agent.cwd ?? "",
          }
        : undefined,
    cwd: agent.cwd ?? "",
    directoryRoot: target?.directoryRoot,
    created: session.created,
    model: agent.model,
    thinkingLevel: agent.thinkingLevel,
    needsResume:
      inspection.scheduling === "paused" &&
      (inspection.tasks.length > 0 || inspection.submissions.length > 0),
  };
}

export async function rename(session: Session, name: string): Promise<void> {
  if (typeof name !== "string" || name.trim().length > 120 || hasControlCharacters(name))
    throw new SessionError(
      "invalid",
      "Session name must be at most 120 characters without control characters.",
    );
  await session.root.commit(async (tx) => {
    const metadata = await tx.doc(Metadata, session.root.id);
    metadata.name = name.trim();
  }, context);
}

export async function getConversation(
  session: Session,
  id?: number,
  context = BACKGROUND_CONTEXT,
): Promise<Conversation> {
  context.abortSignal?.throwIfAborted();
  if (id === undefined) return session.root;
  if (!Number.isSafeInteger(id) || id < 0)
    throw new SessionError("invalid", "Invalid conversation ID.");
  const conversation = await session.harness.conversation(id as ConversationId, context);
  if (!conversation) throw new SessionError("not_found", "Conversation not found.");
  return conversation;
}
