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
};
export type EnvironmentLease = {
  env: ExecutionEnv;
  close(): void | Promise<void>;
};

/** Application integration, not the coding-agent ExtensionAPI. Factories do no I/O. */
export interface Integration {
  readonly id: string;
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
          return targets;
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
    create?: { binding: ExecutionBinding; model: ModelRef; thinkingLevel: ModelThinkingLevel },
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
  ): Promise<ManagedSession> {
    if (!uuid.test(id) || !validBinding(binding))
      throw new SessionError("invalid", "Invalid session or execution binding.");
    if (this.closing) throw new SessionError("closing", "Runtime is stopping.");
    // Snapshot caller-owned values before yielding.
    binding = { ...binding };
    model = { ...model };
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
        })));
    const info = await session.info();
    if (
      !sameBinding(info.binding, binding) ||
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
    create?: { binding: ExecutionBinding; model: ModelRef; thinkingLevel: ModelThinkingLevel },
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
    let managed: ManagedSession | undefined;
    const harness = await Harness.open(
      await openNodeSqliteStorage(join(owner.options.directory, `${id}.sqlite`)),
      {
        models: owner.options.models,
        settings: owner.options.settings,
        registry,
        env: async () => {
          assert(managed, "Session initialization must finish before tools run.");
          return managed.environment();
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
                cwd: create.binding.cwd,
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
      for (const extension of owner.integration(metadata.binding.provider)?.extensions ?? [])
        registry.install(extension);
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

  private async environment(): Promise<ExecutionEnv> {
    const integration = await this.owner.requireTarget(this.binding);
    // The viewer and sibling tools share a lease; validation still runs on every use.
    this.lease ??= Promise.resolve().then(() => integration.open(this.binding));
    try {
      return (await this.lease).env;
    } catch (error) {
      this.lease = undefined;
      throw error;
    }
  }

  /** Complete relative paths in the bound environment, never the server's filesystem. */
  async completePaths(query: string): Promise<string[]> {
    if (this.closed) throw new SessionError("closing", "Session is closed.");
    if (
      query.length > 4096 ||
      hasControlCharacters(query) ||
      query.startsWith("/") ||
      query.split("/").includes("..")
    )
      throw new SessionError("invalid", "Expected a workspace-relative path.");
    const env = await this.environment();
    const slash = query.lastIndexOf("/");
    const directory = query.slice(0, slash + 1);
    const prefix = query.slice(slash + 1).toLowerCase();
    const opened = await env.openDirReader(posix.join(this.binding.cwd, directory), context);
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

  async repository(): Promise<RepositoryStatus> {
    if (this.closed) return { state: "unavailable" };
    try {
      const env = await this.environment();
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
          cwd: this.binding.cwd,
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
