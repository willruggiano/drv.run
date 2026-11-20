import assert from "node:assert/strict";
import { readdir, access, mkdir, lstat, open } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import * as Value from "typebox/value";
import type * as C from "@earendil-works/chord/context";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import type * as A from "@earendil-works/pi-ai";
import { configure, AgentDoc, defineDoc } from "@earendil-works/pi-durable";
import type * as D from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import type * as DE from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Env, openHarness, SshExecutionEnv } from "./harness/index.ts";
import type { EnvTarget } from "./harness/env.ts";
import { SessionId, SessionKey, decode } from "./identity.ts";

export const environmentValue = (selected: EnvTarget | undefined): string =>
  selected?.type === "ssh" ? `ssh:${selected.host}` : (selected?.type ?? "");

export class InvalidForm extends Error {}

export const context = BACKGROUND_CONTEXT;
export const ConversationMetadata = defineDoc<{ title: string; createdAt: number }>({
  kind: "pds.session",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ title: "New session", createdAt: Date.now() }),
  checkpointWhen: () => true,
});

export async function discoverEnvironments(directory: string): Promise<EnvTarget[]> {
  const result: EnvTarget[] = [{ type: "local" }];
  const entries = await readdir(join(directory, "drv.run"), { withFileTypes: true }).catch(
    (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    },
  );
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[A-Za-z0-9]+$/.test(entry.name)) continue;
    const path = join(directory, "drv.run", entry.name);
    const host = `drv.run.${entry.name}`;
    try {
      await access(join(path, "ssh_config"));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    // Configuration permits a connection attempt; it does not certify activation.
    result.push({ type: "ssh", host });
  }
  return result;
}

async function openSession(options: {
  id: SessionId;
  storage: D.Storage;
  models: A.Models;
  environments: () => Promise<EnvTarget[]>;
  cwd: string;
  settings?: D.HarnessSettings;
  parallelApiKeyFile?: string;
}): Promise<Session> {
  const environments = new Map<string, Promise<DE.ExecutionEnv>>();
  const harness: D.Harness = await openHarness(
    options.storage,
    {
      models: options.models,
      ...(options.settings ? { settings: options.settings } : {}),
      parallelApiKeyFile: options.parallelApiKeyFile,
      env: async (target, ctx) => (await acquireEnvironment(target.conversationId, ctx)).env,
    },
    context,
  );
  async function acquireEnvironment(id: D.ConversationId, ctx: C.Context) {
    // Upstream's target.cwd and a later Env snapshot can straddle a configuration commit.
    const { selected, cwd } = await harness.commit(async (tx) => {
      const selection = (await tx.doc(Env, id)).env;
      return {
        selected: selection ? { ...selection } : undefined,
        cwd: (await tx.doc(AgentDoc, id)).cwd,
      };
    }, ctx);
    if (!selected) return { env: undefined, selected, cwd };
    if (!cwd) throw new InvalidForm("Select a working directory.");
    assert(
      selected.type === "local" || selected.type === "ssh",
      "Unsupported execution environment selection.",
    );
    const key = JSON.stringify([selected, cwd]);
    let pending = environments.get(key);
    if (!pending) {
      pending = (async () => {
        if (selected.type === "local") return new NodeExecutionEnv({ cwd });
        const env = new SshExecutionEnv({ target: selected, cwd });
        try {
          // Resolve relative paths and ~ against remote metadata, before anyone borrows it.
          env.cwd = (await env.connection.info(ctx.abortSignal)).cwd;
          env.cwd = getOrThrow(await env.absolutePath(cwd, ctx));
          return env;
        } catch (error) {
          try {
            await env.cleanup(context);
          } catch (cleanup) {
            throw new AggregateError(
              [error, cleanup],
              "Environment acquisition and cleanup failed",
              { cause: cleanup },
            );
          }
          throw error;
        }
      })();
      environments.set(key, pending);
      void pending.catch(() => environments.delete(key));
    }
    return { env: await pending, selected, cwd };
  }

  let available = true;
  let closing: Promise<void> | undefined;
  harness.subscribeClose(() => {
    available = false;
  });

  return {
    id: options.id,
    harness,
    get available() {
      return available;
    },
    async root(form: FormData) {
      return harness.root(context, {
        async init(tx, id) {
          await initialize(tx, id, options, form);
        },
      });
    },
    async createConversation(
      form: FormData,
      ownership: D.ConversationCreateOptions["ownership"] = { kind: "ownerless" },
    ) {
      return harness.createConversation(
        {
          ownership,
          async init(tx, id) {
            await initialize(tx, id, options, form);
          },
        },
        context,
      );
    },
    models: options.models,
    environments: options.environments,
    cwd: options.cwd,
    async conversation(id: D.ConversationId) {
      return harness.conversation(id, context);
    },
    async list() {
      const page = await harness.commit(
        (tx) => tx.scanConversations({ order: "descending" }, 50),
        context,
      );
      return Promise.all(
        page.items.map(async (record) => {
          const info = await harness.snapshot(ConversationMetadata, record.id, context);
          return {
            id: record.id,
            title: info?.title ?? `Conversation ${record.id}`,
            ...(info ? { createdAt: info.createdAt } : {}),
          };
        }),
      );
    },
    async configure(conversation: D.Conversation, form: FormData) {
      await conversation.commit(
        (tx) => applyConfiguration(tx, conversation.id, options, form),
        context,
      );
    },
    async submit(conversation: D.Conversation, form: FormData) {
      const text = field(form, "message");
      const files = uploads(form);
      return submitInput(
        conversation,
        {
          type: "input",
          content: await input(
            options.models,
            text,
            files,
            (await conversation.agent(context)).model,
          ),
        },
        text || files[0]!.name,
      );
    },
    async send(conversation: D.Conversation, form: FormData) {
      const text = field(form, "message").trim();
      const files = uploads(form);
      if (text.startsWith("/")) {
        if (files.length) throw new InvalidForm("Commands cannot include attachments.");
        const [command, ...rest] = text.split(/\s+/);
        if (command === "/cd") {
          const directory = text.slice(command.length).trim();
          if (!directory) throw new InvalidForm("Usage: /cd <path>");
          const acquired = await acquireEnvironment(conversation.id, context);
          if (!acquired.env) throw new InvalidForm("Select an execution environment before /cd.");
          const resolved = await acquired.env.absolutePath(directory, context);
          if (!resolved.ok)
            throw new InvalidForm("Could not resolve the directory in the selected environment.");
          await conversation.commit(async (tx) => {
            const agent = await tx.doc(AgentDoc, conversation.id);
            const selected = (await tx.doc(Env, conversation.id)).env;
            if (
              agent.cwd !== acquired.cwd ||
              environmentValue(selected) !== environmentValue(acquired.selected)
            )
              throw new InvalidForm("Environment configuration changed during /cd; try again.");
            await configure(tx, conversation.id, { cwd: resolved.value });
          }, context);
          return undefined;
        }
        if (command === "/compact") {
          await conversation.compact(rest.join(" ") || undefined, context);
          return undefined;
        }
        if (command === "/new" && rest.length === 0) {
          return harness.createConversation(
            {
              ownership: { kind: "ownerless" },
              async init(tx, id) {
                const agent = await tx.doc(AgentDoc, conversation.id);
                const env = (await tx.doc(Env, conversation.id)).env;
                await configure(tx, id, {
                  model: agent.model ?? null,
                  thinkingLevel: agent.thinkingLevel ?? null,
                  cwd: agent.cwd ?? null,
                });
                await selectEnvironment(tx, id, env ? { ...env } : null);
                await tx.doc(ConversationMetadata, id);
              },
            },
            context,
          );
        }
        throw new InvalidForm("Unknown command. Use /new, /cd <path>, or /compact [instructions].");
      }
      const content = await input(
        options.models,
        text,
        files,
        (await conversation.agent(context)).model,
      );
      return submitInput(
        conversation,
        { type: "input", content, whenBusy: "followUp" },
        text || files[0]!.name,
      );
    },
    close() {
      closing ??= (async () => {
        const errors: unknown[] = [];
        try {
          await harness.close(context);
        } catch (error) {
          errors.push(error);
        }
        const results = await Promise.allSettled(
          [...environments.values()].map(async (env) => (await env).cleanup(context)),
        );
        for (const result of results) {
          if (result.status === "rejected") errors.push(result.reason);
        }
        if (errors.length) throw new AggregateError(errors, "Session cleanup failed");
      })();
      return closing;
    },
  };
}

export interface Session {
  readonly id: SessionId;
  harness: D.Harness;
  readonly available: boolean;
  root(form: FormData): Promise<D.Conversation>;
  createConversation(
    form: FormData,
    ownership?: D.ConversationCreateOptions["ownership"],
  ): Promise<D.Conversation>;
  models: A.Models;
  environments(): Promise<EnvTarget[]>;
  cwd: string;
  conversation(id: D.ConversationId): Promise<D.Conversation | undefined>;
  list(): Promise<{ id: D.ConversationId; title: string; createdAt?: number }[]>;
  configure(conversation: D.Conversation, form: FormData): Promise<void>;
  submit(conversation: D.Conversation, form: FormData): Promise<D.SubmissionId>;
  send(
    conversation: D.Conversation,
    form: FormData,
  ): Promise<D.Conversation | D.SubmissionId | undefined>;
  close(): Promise<void>;
}
export const modelKey = (model: { provider: string; id: string }) =>
  `${model.provider}/${model.id}`;
export const field = (form: FormData, name: string): string => {
  const value = form.get(name);
  if (typeof value !== "string") throw new InvalidForm(`Missing ${name}.`);
  return value;
};

const uploads = (form: FormData) =>
  form
    .getAll("attachments")
    .filter((value): value is File => value instanceof File && value.size > 0);

export async function attachments(
  text: string,
  files: File[],
): Promise<Exclude<D.UserInput, string>> {
  if (!text && !files.length) throw new InvalidForm("Enter a message or attach a file.");
  const content: Exclude<D.UserInput, string> = text ? [{ type: "text", text }] : [];
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.type)) {
      content.push(
        { type: "text", text: `Attachment: ${file.name}` },
        {
          type: "image",
          mimeType: file.type,
          data: Buffer.from(bytes).toString("base64"),
        },
      );
    } else {
      if (bytes.includes(0))
        throw new InvalidForm(`${file.name}: only images and UTF-8 text files are supported.`);
      let decoded: string;
      try {
        decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new InvalidForm(`${file.name}: not a UTF-8 text file.`);
      }
      content.push({ type: "text", text: `Attachment: ${file.name}\n\n${decoded}` });
    }
  }
  return content;
}

export class SessionUnavailable extends Error {}

type Options = Omit<Parameters<typeof openSession>[0], "storage" | "id">;

function configurationChange(models: A.Models, form: FormData, current: D.AgentState = {}) {
  const clears = form.getAll("clear");
  const names = ["model", "thinking", "cwd", "env"];
  if (
    new Set(clears).size !== clears.length ||
    clears.some((name) => typeof name !== "string" || !names.includes(name) || form.has(name))
  )
    throw new InvalidForm("Clear each supported field once, without supplying a value.");
  const value = (name: string) =>
    clears.includes(name) ? null : form.has(name) ? field(form, name) : undefined;
  const modelValue = value("model");
  let model: D.AgentChange["model"] = current.model;
  if (modelValue === null) model = null;
  else if (modelValue !== undefined) {
    const found = models.getModels().find((candidate) => modelKey(candidate) === modelValue);
    if (!found) throw new InvalidForm("Select an available model.");
    model = { provider: found.provider, modelId: found.id };
  }
  const thinkingValue = value("thinking");
  const metadata = model && models.getModel(model.provider, model.modelId);
  const levels = metadata ? getSupportedThinkingLevels(metadata) : [];
  const thinking =
    thinkingValue == null ? thinkingValue : levels.find((level) => level === thinkingValue);
  if (thinkingValue != null && !thinking)
    throw new InvalidForm("Select a model and a supported thinking level.");
  if (
    modelValue &&
    current.thinkingLevel &&
    thinkingValue === undefined &&
    !levels.includes(current.thinkingLevel)
  )
    throw new InvalidForm("Select a thinking level supported by the new model.");
  const cwd = value("cwd");
  if (cwd === "") throw new InvalidForm("Working directory cannot be empty.");
  const selected = value("env");
  let env: EnvTarget | null | undefined;
  if (selected == null) env = selected;
  else if (selected === "local") env = { type: "local" };
  else if (selected.startsWith("ssh:")) {
    const host = selected.slice(4);
    if (!host || host.startsWith("-") || /[\s\p{Cc}]/u.test(host))
      throw new InvalidForm("Enter one SSH host name without options or whitespace.");
    env = { type: "ssh", host };
  } else throw new InvalidForm("Select local or ssh:<host>.");
  const agent: D.AgentChange = {
    ...(modelValue !== undefined && model !== undefined ? { model } : {}),
    ...(thinking !== undefined ? { thinkingLevel: thinking } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
  };
  return { agent, env };
}

async function selectEnvironment(
  tx: D.Tx,
  id: D.ConversationId,
  env: EnvTarget | null | undefined,
) {
  if (env === undefined) return;
  const draft = await tx.doc(Env, id);
  if (env === null) delete draft.env;
  else draft.env = env;
}

export interface Application extends Options {
  open(id?: SessionId): Promise<Session>;
  get(id: SessionId): Promise<Session | undefined>;
  list(): Promise<{ id: SessionId; status: "open" | "unavailable" }[]>;
  compose(form: FormData): Promise<{ sessionId: SessionId; conversation: D.Conversation }>;
  close(): Promise<void>;
}

/** One owner per persisted store. Only explicit open may allocate a database. */
export async function openApplication(
  options: Options & { directory: string },
): Promise<Application> {
  const directory = join(options.directory, "sessions");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  assert((await lstat(directory)).isDirectory(), "Session storage must be a directory");
  type Record = { key: SessionKey; owner?: Session; opening?: Promise<Session>; error?: unknown };
  const records = new Map<SessionId, Record>();
  let closing: Promise<void> | undefined;

  async function discover() {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const key = entry.name;
      if (!Value.Check(SessionKey, key)) continue;
      const id = Value.Decode(SessionKey, key);
      if (!records.has(id)) records.set(id, { key });
    }
  }

  function acquire(id: SessionId, create: boolean): Promise<Session> {
    if (closing) return Promise.reject(new SessionUnavailable("PDS is closing."));
    let record = records.get(id);
    if (record?.opening) return record.opening;
    if (record?.owner?.available) return Promise.resolve(record.owner);
    record ??= { key: Value.Encode(SessionKey, id) };
    records.set(id, record);
    const selected = record;
    selected.opening = (async () => {
      await selected.owner?.close();
      const path = join(directory, selected.key);
      let created = false;
      if (create) {
        try {
          await mkdir(path, { mode: 0o700 });
          created = true;
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        }
      }
      assert((await lstat(path)).isDirectory(), "Session store must be a directory");
      const database = join(path, "store.sqlite");
      if (created) await (await open(database, "wx", 0o600)).close();
      const file = await lstat(database);
      assert(
        file.isFile() && file.nlink === 1,
        "Session database must be a single-link regular file",
      );
      const owner = await openSession({
        ...options,
        id,
        storage: await openNodeSqliteStorage(database),
      });
      selected.owner = owner;
      delete selected.error;
      return owner;
    })()
      .catch((error: unknown) => {
        selected.error = error;
        throw new SessionUnavailable("Session is unavailable.", { cause: error });
      })
      .finally(() => {
        delete selected.opening;
      });
    return selected.opening;
  }

  await discover();
  // Opening reconciles interrupted task state; only startup explicitly resumes it.
  await Promise.allSettled(
    [...records.keys()].map(async (id) => {
      const app = await acquire(id, false);
      app.harness.resume();
    }),
  );

  return {
    ...options,
    async open(id = decode(SessionId, randomUUID())) {
      return acquire(id, !records.has(id));
    },
    async get(id) {
      if (closing) throw new SessionUnavailable("PDS is closing.");
      const record = records.get(id);
      if (!record) return undefined;
      const owner = record.opening ? await record.opening : record.owner;
      if (!owner?.available)
        throw new SessionUnavailable("Session is unavailable.", { cause: record.error });
      return owner;
    },
    async list() {
      await discover();
      return [...records].map(([id, record]) => ({
        id,
        status: record.owner?.available ? ("open" as const) : ("unavailable" as const),
      }));
    },
    async compose(form) {
      const { agent, env } = configurationChange(options.models, form);
      if (!agent.model || !agent.thinkingLevel || !agent.cwd || !env)
        throw new InvalidForm(
          "Select a model, thinking level, working directory, and environment.",
        );
      const text = typeof form.get("message") === "string" ? field(form, "message").trim() : "";
      const files = uploads(form);
      if (text.startsWith("/") && (text !== "/new" || files.length))
        throw new InvalidForm("Start a conversation before using this command.");
      const content =
        (text && text !== "/new") || files.length
          ? await input(options.models, text, files, agent.model)
          : undefined;
      // All validation precedes state allocation; admission after creation is a separate boundary.
      const sessionId = decode(
        SessionId,
        form.has("sessionId") ? field(form, "sessionId") : randomUUID(),
      );
      const app = await acquire(sessionId, !records.has(sessionId));
      const conversation = await app.harness.createConversation(
        {
          ownership: { kind: "ownerless" },
          agent,
          async init(tx, id) {
            await tx.doc(ConversationMetadata, id);
            await selectEnvironment(tx, id, env);
          },
        },
        context,
      );
      if (content)
        await submitInput(
          conversation,
          { type: "input", content, whenBusy: "followUp" },
          text || files[0]!.name,
        );
      return { sessionId, conversation };
    },
    close() {
      closing ??= (async () => {
        await Promise.allSettled(
          [...records.values()].flatMap((record) => (record.opening ? [record.opening] : [])),
        );
        const owners = [...records.values()].flatMap((record) =>
          record.owner ? [record.owner] : [],
        );
        const harnesses = await Promise.allSettled(
          owners.map((owner) => owner.harness.close(context)),
        );
        const environments = await Promise.allSettled(owners.map((owner) => owner.close()));
        const errors = [...harnesses, ...environments].flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (errors.length) throw new AggregateError(errors, "PDS shutdown failed");
      })();
      return closing;
    },
  };
}

async function applyConfiguration(
  tx: D.Tx,
  id: D.ConversationId,
  options: Options,
  form: FormData,
) {
  const current = await tx.doc(AgentDoc, id);
  const change = configurationChange(options.models, form, current);
  await configure(tx, id, change.agent);
  await selectEnvironment(tx, id, change.env);
}

async function initialize(tx: D.Tx, id: D.ConversationId, options: Options, form: FormData) {
  await applyConfiguration(tx, id, options, form);
  await tx.doc(ConversationMetadata, id);
}

async function input(models: A.Models, text: string, files: File[], model: D.ModelRef | undefined) {
  const content = await attachments(text, files);
  if (
    content.some((part) => part.type === "image") &&
    (!model || !models.getModel(model.provider, model.modelId)?.input.includes("image"))
  )
    throw new InvalidForm("Select a model that accepts images.");
  return content;
}

async function submitInput(
  conversation: D.Conversation,
  draft: D.InputSubmissionDraft,
  title: string,
) {
  return conversation.commit(async (tx) => {
    const id = await conversation.submit(tx, draft);
    const info = await tx.doc(ConversationMetadata, conversation.id);
    if (info.title === "New session") info.title = title.slice(0, 100);
    return id;
  }, context);
}
