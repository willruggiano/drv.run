import assert from "node:assert/strict";
import { mkdir, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
  AssistantMessage,
  ImageContent,
  Models,
  ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import {
  DEFAULT_COMPACTION_POLICY,
  type HarnessSettings,
  type AgentState,
  createRegistry,
  defineDoc,
  defineExtension,
  Harness,
  LiveDoc,
  InboxDoc,
  type TaskId,
  section,
  type Conversation,
  type ConversationView,
  type ConversationId,
  type ConversationRecord,
  type Cursor,
  type EntryRecord,
  type Extension,
  type ModelRef,
} from "@earendil-works/pi-durable";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";

import {
  AskExtension,
  ReviewExtension,
  ReportTool,
  Workflows,
  WorkflowError,
  answerQuestion,
  prepareReview,
  reportText,
  validate,
  ReviewFinishSchema,
  type WorkflowView,
} from "./workflows.ts";

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

/** Persisted identity, never a connection or a fallback preference. */
export type ExecutionBinding = {
  provider: string;
  target: string;
  cwd: string;
};
export type ExecutionTarget = ExecutionBinding & {
  label: string;
  available: boolean;
  directoryRoot?: string;
};
export type EnvironmentLease = {
  env: ExecutionEnv;
  /** Immutable cwd views sharing the lease's connection and lifetime. */
  atDirectory?(cwd: string): ExecutionEnv;
  close(): void | Promise<void>;
};

/** Application integration, not the coding-agent ExtensionAPI. Factories do no I/O. */
export interface Integration {
  readonly id: string;
  /** Opt in to workspace-relative base directories. */
  readonly directoryRoot?: string;
  readonly extensions?: readonly Extension[];
  targets(): Promise<ExecutionTarget[]>;
  /** Check every execution, including already-open leases. Throw to fail closed. */
  validate(binding: ExecutionBinding): Promise<void>;
  /** Acquired lazily, once per session; close after the harness has stopped. */
  open(binding: ExecutionBinding): EnvironmentLease | Promise<EnvironmentLease>;
}
export type IntegrationFactory = () => Integration | Promise<Integration>;

export async function loadIntegrations(paths: readonly string[]): Promise<Integration[]> {
  const integrations: Integration[] = [];
  for (const path of paths) {
    const module: { default?: unknown } = await import(pathToFileURL(resolve(path)).href);
    assert(typeof module.default === "function", `Integration ${path} must export a factory.`);
    const integration: Integration = await module.default();
    assertIntegration(integration);
    integrations.push(integration);
  }
  return integrations;
}

function assertIntegration(integration: Integration): void {
  assert(
    integration && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(integration.id),
    "Invalid integration ID.",
  );
  for (const method of ["targets", "validate", "open"] as const)
    assert(typeof integration[method] === "function", `Integration requires ${method}().`);
}

export function stateDirectory(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env.XDG_STATE_HOME && isAbsolute(env.XDG_STATE_HOME)
    ? env.XDG_STATE_HOME
    : join(home, ".local", "state");
}

export function localIntegration(directory: string): Integration {
  const cwd = resolve(directory);
  return {
    id: "local",
    async targets() {
      let available = false;
      try {
        available = (await stat(cwd)).isDirectory();
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      return [
        {
          provider: "local",
          target: cwd,
          cwd,
          label: `Local · ${cwd}`,
          available,
        },
      ];
    },
    async validate(binding) {
      if (
        binding.provider !== "local" ||
        !isAbsolute(binding.cwd) ||
        binding.target !== binding.cwd
      )
        throw new SessionError("invalid", "Invalid local directory binding.");
      try {
        if (!(await stat(binding.cwd)).isDirectory()) throw new Error("Not a directory.");
      } catch {
        throw new SessionError("unavailable", `Local directory is unavailable: ${binding.cwd}`);
      }
    },
    open(binding) {
      const env = new NodeExecutionEnv({ cwd: binding.cwd });
      return { env, close: () => env.cleanup(context) };
    },
  };
}

export type SessionInfo = {
  id: string;
  name: string;
  binding: ExecutionBinding;
  cwd: string;
  directoryRoot?: string;
  created: number;
  model: ModelRef;
  needsResume: boolean;
  thinkingLevel: ModelThinkingLevel;
};
export type ContextStatus = {
  window: number | null;
  autoCompact: boolean;
  /** Last completed response in the current context/model; not a live token estimate. */
  lastResponse: { tokens: number; cacheHit: number | null; entry: number } | null;
};
export type RepositoryStatus =
  | { state: "repository"; branch: string | null; revision: string | null }
  | { state: "none" | "unavailable" };
export type Snapshot = {
  session: SessionInfo;
  view: ConversationView;
  context: ContextStatus;
  history?: readonly EntryRecord[];
  workflows?: WorkflowView;
};
export type Catalog = {
  targets: ExecutionTarget[];
  sessions: SessionInfo[];
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
  integrations: readonly Integration[];
  defaultModel?: ModelRef;
  thinkingLevel?: ModelThinkingLevel;
  modelThinkingLevels?: Record<string, ModelThinkingLevel>;
  settings?: HarnessSettings;
  onReport?: (error: unknown) => void;
};

const Metadata = defineDoc<{
  binding: ExecutionBinding | null;
  created: number;
  name?: string;
}>({
  kind: "app.session",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ binding: null, created: 0 }),
});

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

async function completePaths(
  env: ExecutionEnv,
  query: string,
  directoriesOnly = false,
): Promise<string[]> {
  const slash = query.lastIndexOf("/");
  const directory = query.slice(0, slash + 1);
  const prefix = query.slice(slash + 1).toLowerCase();
  const opened = await env.openDirReader(posix.join(env.cwd, directory), context);
  if (!opened.ok) {
    if (["not_found", "not_directory"].includes(opened.error.code)) return [];
    throw new SessionError("unavailable", "Cannot list paths in this workspace.");
  }
  const paths: string[] = [];
  try {
    // Bound both scanning and the response; completion must not walk entire trees.
    for (let count = 0; count < 5000; count += 100) {
      const page = await opened.value.next(100, context);
      if (!page.ok) throw new SessionError("unavailable", "Cannot list paths in this workspace.");
      for (const file of page.value.entries) {
        if (directoriesOnly && file.kind !== "directory") continue;
        const name = posix.basename(file.path);
        if (
          !name.toLowerCase().startsWith(prefix) ||
          (!prefix.startsWith(".") && name.startsWith(".")) ||
          hasControlCharacters(name)
        )
          continue;
        paths.push(directory + name + (file.kind === "directory" ? "/" : ""));
      }
      if (page.value.done) break;
    }
  } finally {
    await opened.value.close(context);
  }
  return paths.sort((a, b) => a.localeCompare(b)).slice(0, 50);
}

export class Sessions {
  readonly options: SessionOptions;
  readonly opened = new Map<string, Promise<ManagedSession>>();
  private readonly integrations = new Map<string, Integration>();
  private closing = false;
  private closed?: Promise<void>;

  private constructor(options: SessionOptions) {
    this.options = options;
    for (const integration of options.integrations) {
      assertIntegration(integration);
      assert(!this.integrations.has(integration.id), `Duplicate integration: ${integration.id}`);
      this.integrations.set(integration.id, integration);
    }
  }

  static async open(options: SessionOptions): Promise<Sessions> {
    const sessions = new Sessions(options);
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    return sessions;
  }

  integration(id: string): Integration | undefined {
    return this.integrations.get(id);
  }

  async requireTarget(binding: ExecutionBinding): Promise<Integration> {
    const integration = this.integrations.get(binding.provider);
    if (!integration)
      throw new SessionError("unavailable", `Integration is not installed: ${binding.provider}`);
    await integration.validate(binding);
    return integration;
  }

  async catalog(): Promise<Catalog> {
    const names = await readdir(this.options.directory);
    const sessions = await Promise.all(
      names
        .filter((name) => name.endsWith(".sqlite") && uuid.test(name.slice(0, -7)))
        .map(async (name) => (await this.get(name.slice(0, -7))).info()),
    );
    const targets = (
      await Promise.all(
        [...this.integrations.values()].map(async (integration) => {
          const targets = await integration.targets();
          for (const target of targets)
            assert(
              target.provider === integration.id && validBinding(target),
              "Invalid execution target.",
            );
          return targets.map((target) => ({
            ...target,
            ...(integration.directoryRoot ? { directoryRoot: integration.directoryRoot } : {}),
          }));
        }),
      )
    ).flat();
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
      defaultModel: this.options.defaultModel,
    };
  }

  baseDirectory(binding: ExecutionBinding, value: string): string {
    const root = this.integrations.get(binding.provider)?.directoryRoot;
    if (!root) throw new SessionError("invalid", "This target does not support base directories.");
    return resolveBaseDirectory(root, value);
  }

  /** Browse a target before a session exists, using the integration, never host I/O. */
  async completeDirectories(binding: ExecutionBinding, query: string): Promise<string[]> {
    if (this.closing) throw new SessionError("closing", "Runtime is stopping.");
    if (!validBinding(binding)) throw new SessionError("invalid", "Invalid execution binding.");
    const root = this.baseDirectory(binding, "");
    this.baseDirectory(binding, query);
    const integration = await this.requireTarget(binding);
    const lease = await integration.open(binding);
    try {
      const env = root === lease.env.cwd ? lease.env : lease.atDirectory?.(root);
      if (!env) throw new SessionError("unavailable", "Integration cannot change directories.");
      return await completePaths(env, query, true);
    } finally {
      await lease.close();
    }
  }

  resolveThinking(ref: ModelRef, requested?: ModelThinkingLevel): ModelThinkingLevel {
    const model = this.options.models.getModel(ref.provider, ref.modelId);
    if (!model) throw new SessionError("invalid", "Model is unavailable.");
    return clampThinkingLevel(
      model,
      requested ??
        this.options.modelThinkingLevels?.[`${ref.provider}/${ref.modelId}`] ??
        this.options.thinkingLevel ??
        DEFAULT_THINKING_LEVEL,
    );
  }

  async get(id: string): Promise<ManagedSession> {
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

  private open(
    id: string,
    create?: {
      binding: ExecutionBinding;
      model: ModelRef;
      thinkingLevel: ModelThinkingLevel;
      cwd: string;
    },
  ): Promise<ManagedSession> {
    if (this.closing) return Promise.reject(new SessionError("closing", "Runtime is stopping."));
    const opened = ManagedSession.open(this, id, create);
    this.opened.set(id, opened);
    void opened.catch(() => this.opened.delete(id));
    return opened;
  }

  async create(
    id: string,
    binding: ExecutionBinding,
    model: ModelRef,
    thinkingLevel?: ModelThinkingLevel,
    baseDirectory?: string,
  ): Promise<ManagedSession> {
    if (!uuid.test(id) || !validBinding(binding))
      throw new SessionError("invalid", "Invalid session or execution binding.");
    if (this.closing) throw new SessionError("closing", "Runtime is stopping.");
    // Snapshot caller-owned values before yielding.
    binding = { ...binding };
    model = { ...model };
    const cwd =
      baseDirectory === undefined ? binding.cwd : this.baseDirectory(binding, baseDirectory);
    await this.requireTarget(binding);
    const available = await this.options.models.getAvailable();
    if (!available.some((item) => item.provider === model.provider && item.id === model.modelId))
      throw new SessionError(
        "invalid",
        "Select an available model. Configure credentials with pi /login.",
      );
    let found: ManagedSession | undefined;
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
          thinkingLevel: this.resolveThinking(model, thinkingLevel),
          cwd,
        })));
    const info = await session.info();
    if (
      !sameBinding(info.binding, binding) ||
      info.cwd !== cwd ||
      info.model.provider !== model.provider ||
      info.model.modelId !== model.modelId
    )
      throw new SessionError("conflict", "Session ID already belongs to a different session.");
    return session;
  }

  close(): Promise<void> {
    this.closing = true;
    return (this.closed ??= (async () => {
      const results = await Promise.allSettled(
        [...this.opened.values()].map(async (session) => (await session).close()),
      );
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    })());
  }
}

export class ManagedSession {
  needsResume = false;
  private lease?: Promise<EnvironmentLease>;
  private closed?: Promise<void>;
  readonly owner: Sessions;
  readonly id: string;
  readonly harness: Harness;
  readonly root: Conversation;
  readonly binding: Readonly<ExecutionBinding>;
  readonly created: number;
  private readonly sandbox: CodemodeSandbox;

  private constructor(
    owner: Sessions,
    id: string,
    harness: Harness,
    root: Conversation,
    binding: ExecutionBinding,
    created: number,
    sandbox: CodemodeSandbox,
  ) {
    this.owner = owner;
    this.id = id;
    this.harness = harness;
    this.root = root;
    this.binding = Object.freeze({ ...binding });
    this.created = created;
    this.sandbox = sandbox;
  }

  static async open(
    owner: Sessions,
    id: string,
    create?: {
      binding: ExecutionBinding;
      model: ModelRef;
      thinkingLevel: ModelThinkingLevel;
      cwd: string;
    },
  ): Promise<ManagedSession> {
    const registry = createRegistry();
    registry.install(CodingTools);
    // JavaScript runs in a worker-isolated QuickJS VM. Nested file/process
    // calls still use this session's bound execution environment.
    const sandbox = new CodemodeSandbox({ memoryLimitBytes: 64 * 1024 * 1024 });
    registry.install(createCodemodeExtension({ sandbox }));
    registry.install(
      defineExtension({
        name: "coding",
        sections: [
          // FIXME: this is so fucking stupid LMAO
          section(
            "preamble",
            () =>
              "You are Pi, a coding agent. Inspect the project and its AGENTS.md instructions before changing files. Never claim an operation succeeded without checking its result.",
            { tag: false },
          ),
          section("cwd", (input) => input.env?.cwd),
        ],
      }),
    );
    registry.install(AskExtension);
    const defaults = [...(owner.options.settings?.extensions ?? registry.snapshot().installed())];
    if (!defaults.includes(AskExtension)) defaults.push(AskExtension);
    registry.install(ReviewExtension);
    let managed: ManagedSession | undefined;
    const harness = await Harness.open(
      await openNodeSqliteStorage(join(owner.options.directory, `${id}.sqlite`)),
      {
        models: owner.options.models,
        settings: { ...owner.options.settings, extensions: defaults },
        registry,
        env: async ({ cwd }) => {
          assert(managed, "Session initialization must finish before tools run.");
          return managed.environment(cwd);
        },
        onReport: owner.options.onReport,
      },
      context,
    );
    try {
      const root = await harness.root(
        context,
        create
          ? {
              agent: {
                model: create.model,
                cwd: create.cwd,
                thinkingLevel: create.thinkingLevel,
              },
              init: async (tx, conversationId) => {
                const metadata = await tx.doc(Metadata, conversationId);
                metadata.binding = create.binding;
                metadata.created = Date.now();
              },
            }
          : undefined,
      );
      const metadata = await harness.snapshot(Metadata, root.id, context);
      assert(
        metadata?.binding && validBinding(metadata.binding),
        "Session has no execution binding.",
      );
      // Install only this session's integration, never another provider's prompt or tools.
      for (const extension of owner.integration(metadata.binding.provider)?.extensions ?? []) {
        registry.install(extension);
        if (!defaults.some((item) => item.name === extension.name)) defaults.push(extension);
      }
      managed = new ManagedSession(
        owner,
        id,
        harness,
        root,
        metadata.binding,
        metadata.created,
        sandbox,
      );
      const inspection = await harness.inspect(context);
      managed.needsResume = inspection.tasks.length > 0 || inspection.submissions.length > 0;
      return managed;
    } catch (error) {
      try {
        await harness.close(context);
      } finally {
        await sandbox.close();
      }
      throw error;
    }
  }

  private async environment(cwd = this.binding.cwd): Promise<ExecutionEnv> {
    const integration = await this.owner.requireTarget(this.binding);
    if (
      cwd !== this.binding.cwd &&
      (!integration.directoryRoot ||
        cwd !==
          resolveBaseDirectory(
            integration.directoryRoot,
            posix.relative(integration.directoryRoot, cwd),
          ))
    )
      throw new SessionError("invalid", "Invalid execution directory.");
    // The viewer and sibling tools share a lease; validation still runs on every use.
    this.lease ??= Promise.resolve().then(() => integration.open(this.binding));
    let lease: EnvironmentLease;
    try {
      lease = await this.lease;
    } catch (error) {
      this.lease = undefined;
      throw error;
    }
    if (cwd === lease.env.cwd) return lease.env;
    if (!lease.atDirectory)
      throw new SessionError("unavailable", "Integration cannot change directories.");
    return lease.atDirectory(cwd);
  }

  /** Complete relative paths in the bound environment, never the server's filesystem. */
  async completePaths(query: string, conversation = this.root): Promise<string[]> {
    if (this.closed) throw new SessionError("closing", "Session is closed.");
    if (
      query.length > 4096 ||
      hasControlCharacters(query) ||
      query.startsWith("/") ||
      query.split("/").includes("..")
    )
      throw new SessionError("invalid", "Expected a workspace-relative path.");
    const env = await this.environment((await conversation.agent(context)).cwd);
    return completePaths(env, query);
  }

  async repository(conversation = this.root): Promise<RepositoryStatus> {
    if (this.closed) return { state: "unavailable" };
    try {
      const env = await this.environment((await conversation.agent(context)).cwd);
      let output = "";
      const result = await env.exec(
        `if ! command -v git >/dev/null 2>&1; then
  printf 'unavailable\n'
elif ! git rev-parse --git-dir >/dev/null 2>&1; then
  printf 'none\n'
else
  printf 'repository\n'
  git symbolic-ref --quiet --short HEAD || printf '\n'
  git rev-parse --verify --short HEAD 2>/dev/null || true
fi`,
        {
          cwd: env.cwd,
          timeout: 3,
          env: { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
          onOutput(text, _context, info) {
            if (info.stream === "stdout") output = (output + text).slice(0, 8192);
          },
        },
        context,
      );
      if (!result.ok || result.value.exitCode !== 0) return { state: "unavailable" };
      const [state, branch, revision] = output.split("\n");
      if (state === "none") return { state };
      if (state !== "repository") return { state: "unavailable" };
      return { state, branch: branch || null, revision: revision || null };
    } catch {
      // A disconnected guest must not break the transcript or fall back to host Git.
      return { state: "unavailable" };
    }
  }

  contextStatus(view: ConversationView): ContextStatus {
    const agent = view.docs["pi.agent"] as AgentState | undefined;
    const model =
      agent?.model && this.owner.options.models.getModel(agent.model.provider, agent.model.modelId);
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
        this.owner.options.settings?.compaction?.enabled ?? DEFAULT_COMPACTION_POLICY.enabled,
      lastResponse,
    };
  }

  async info(): Promise<SessionInfo> {
    const agent = await this.root.agent(context);
    const metadata = await this.harness.snapshot(Metadata, this.root.id, context);
    assert(agent.model, "Session has no model.");
    return {
      id: this.id,
      name: metadata?.name ?? "",
      binding: { ...this.binding },
      cwd: agent.cwd ?? this.binding.cwd,
      directoryRoot: this.owner.integration(this.binding.provider)?.directoryRoot,
      created: this.created,
      model: agent.model,
      needsResume: this.needsResume,
      thinkingLevel: agent.thinkingLevel,
    };
  }

  async rename(name: string): Promise<void> {
    if (
      typeof name !== "string" ||
      name.trim().length > 120 ||
      Array.from(name).some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      })
    )
      throw new SessionError(
        "invalid",
        "Session name must be at most 120 characters without control characters.",
      );
    await this.root.commit(async (tx) => {
      const metadata = await tx.doc(Metadata, this.root.id);
      metadata.name = name.trim();
    }, context);
  }

  async conversations(): Promise<ConversationRecord[]> {
    const records: ConversationRecord[] = [];
    let cursor: Cursor | undefined;
    do {
      const page = await this.harness.commit(
        (tx) => tx.scanConversations({}, 256, cursor),
        context,
      );
      records.push(...page.items);
      cursor = page.next;
    } while (cursor !== undefined);
    return records;
  }

  async conversation(id?: number): Promise<Conversation> {
    if (id === undefined) return this.root;
    if (!Number.isSafeInteger(id) || id < 0)
      throw new SessionError("invalid", "Invalid conversation ID.");
    const conversation = await this.harness.conversation(id as ConversationId, context);
    if (!conversation) throw new SessionError("not_found", "Conversation not found.");
    return conversation;
  }

  async history(conversation = this.root): Promise<EntryRecord[]> {
    const entries: EntryRecord[] = [];
    let cursor: Cursor | undefined;
    do {
      const page = await conversation.entries({ order: "ascending" }, 256, cursor, context);
      entries.push(...page.items);
      cursor = page.next;
    } while (cursor !== undefined);
    return entries;
  }

  async watchWorkflows(conversation = this.root) {
    await conversation.commit(async (tx) => {
      await tx.doc(Workflows, conversation.id);
    }, context);
    const watch = await this.harness.watchDoc(Workflows, conversation.id, context);
    assert(watch);
    return watch;
  }

  async workflows(conversation = this.root): Promise<WorkflowView> {
    const state = await this.harness.snapshot(Workflows, conversation.id, context);
    return {
      asks: await Promise.all(
        Object.entries(state?.asks ?? {}).map(async ([id, ask]) => {
          const task = ask.response
            ? undefined
            : await this.harness.getTask(Number(id) as TaskId, context);
          return {
            ...ask,
            id: Number(id),
            actionable:
              !ask.response &&
              !!task &&
              !task.abortRequested &&
              ["pending", "running", "waiting"].includes(task.state.status),
          };
        }),
      ),
      ...(state?.review ? { review: state.review } : {}),
    };
  }

  private async requireWorkflowExecution(): Promise<void> {
    if (this.closed) throw new SessionError("closing", "Session is closed.");
    if (this.needsResume) throw new SessionError("conflict", "Resume interrupted work first.");
    await this.owner.requireTarget(this.binding);
  }

  private async requireIdle(conversation: Conversation): Promise<void> {
    await conversation.commit(async (tx) => {
      const live = await tx.doc(LiveDoc, conversation.id);
      const inbox = await tx.doc(InboxDoc, conversation.id);
      if (live.run || inbox.items.length)
        throw new SessionError("conflict", "Conversation is busy.");
    }, context);
  }

  async answer(taskId: number, response: unknown, conversation = this.root): Promise<void> {
    await this.requireWorkflowExecution();
    await conversation.commit(
      (tx) => answerQuestion(tx, conversation.id, taskId, response),
      context,
    );
  }

  async startReview(input: unknown, conversation = this.root): Promise<Conversation> {
    await this.requireWorkflowExecution();
    await this.requireIdle(conversation);
    if ((await this.harness.snapshot(Workflows, conversation.id, context))?.review)
      throw new WorkflowError("conflict", "Nested reviews are not supported.");
    const agent = await conversation.agent(context);
    const prepared = await prepareReview(await this.environment(agent.cwd), input);
    const history = await conversation.entries({}, 1, undefined, context);
    const reviewer = await this.harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: {
          model: agent.model,
          thinkingLevel: agent.thinkingLevel,
          cwd: agent.cwd,
          extensions: [...agent.extensions, ReviewExtension],
          tools: [...new Set([...agent.tools, ...agent.callable, ...agent.deferred, ReportTool])],
          modelTools: [...agent.tools, ReportTool],
          instructions: agent.instructions,
        },
        init: async (tx, id) => {
          // Recheck admission atomically with creation, after asynchronous target resolution.
          const live = await tx.doc(LiveDoc, conversation.id);
          const inbox = await tx.doc(InboxDoc, conversation.id);
          if (live.run || inbox.items.length)
            throw new SessionError("conflict", "Conversation is busy.");
          const state = await tx.doc(Workflows, id);
          state.review = {
            ...prepared,
            origin: conversation.id,
            ...(history.items.length ? { originEntry: history.items[0].id } : {}),
          };
        },
      },
      context,
    );
    await reviewer.submit({ type: "input", content: prepared.scope, whenBusy: "reject" }, context);
    return reviewer;
  }

  async finishReview(input: unknown, conversation = this.root): Promise<Conversation> {
    const command = validate(ReviewFinishSchema, input);
    const review = (await this.harness.snapshot(Workflows, conversation.id, context))?.review;
    if (!review) throw new WorkflowError("conflict", "Not a review conversation.");
    const origin = await this.conversation(review.origin);
    if (command.action === "return") return origin;
    await this.requireWorkflowExecution();
    await this.requireIdle(origin);
    if (!review.report) throw new WorkflowError("conflict", "No review report has been submitted.");
    const selected = review.report.findings.filter((item) => command.findings.includes(item.id));
    if (
      selected.length !== command.findings.length ||
      (command.action === "fix" && !selected.length)
    )
      throw new WorkflowError("invalid", "Select existing findings to fix.");
    const report =
      command.action === "fix" ? { ...review.report, findings: selected } : review.report;
    const text = `Workspace: ${review.cwd}\nTarget: ${JSON.stringify(review.target)}\nResolved revisions: ${JSON.stringify(review.resolved)}\n\n${reportText(report)}`;
    if (command.action === "fix" && (await origin.agent(context)).cwd !== review.cwd)
      throw new WorkflowError(
        "conflict",
        "Origin directory changed. Restore it or start a new review before fixing.",
      );
    if (command.action === "handoff") {
      await origin.submit(
        {
          type: "write",
          requestId: command.requestId,
          entry: {
            kind: "app.review",
            data: { reviewer: conversation.id, report },
            model: [
              {
                role: "user",
                content: `Review handoff (informational; no fix run requested):\n\n${text}`,
                timestamp: Date.now(),
              },
            ],
          },
        },
        context,
      );
    } else {
      await origin.submit(
        {
          type: "input",
          requestId: command.requestId,
          whenBusy: "reject",
          entry: { kind: "app.review-fix", data: { reviewer: conversation.id, report } },
          content: `Implement and verify only the selected findings below. Human callouts are informational, not fix tasks. Do not start an automatic re-review loop. Review cwd: ${review.cwd}\n\n${text}`,
        },
        context,
      );
    }
    return origin;
  }

  async prompt(
    text: string,
    requestId: string,
    whenBusy: "reject" | "steer" | "followUp" = "reject",
    conversation = this.root,
    images: readonly ImageContent[] = [],
  ): Promise<void> {
    if (!uuid.test(requestId) || !text.trim())
      throw new SessionError("invalid", "Invalid prompt or request ID.");
    if (this.needsResume)
      throw new SessionError("conflict", "Resume interrupted work before sending a new prompt.");
    await this.owner.requireTarget(this.binding);
    await conversation.submit(
      {
        type: "input",
        content: images.length ? [{ type: "text", text }, ...images] : text,
        requestId,
        whenBusy,
      },
      context,
    );
  }

  async resume(): Promise<void> {
    await this.owner.requireTarget(this.binding);
    this.harness.resume();
    this.needsResume = false;
  }

  async stop(conversation = this.root): Promise<void> {
    // abort() starts Durable's scheduler. Never execute pending work via this path.
    if (this.needsResume)
      throw new SessionError("conflict", "Resume interrupted work before stopping it.");
    await conversation.abort(context);
  }

  close(): Promise<void> {
    return (this.closed ??= (async () => {
      try {
        await this.harness.close(context);
      } finally {
        try {
          await this.sandbox.close();
        } finally {
          await (await this.lease)?.close();
        }
      }
    })());
  }
}
