import assert from "node:assert/strict";
import { readdir, access, mkdir, lstat, open } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, posix } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getSupportedThinkingLevels, type Models } from "@earendil-works/pi-ai/models";
import {
  configure,
  AgentDoc,
  defineDoc,
  type AgentChange,
  type ConversationCreateOptions,
  type Conversation,
  type ConversationId,
  type Harness,
  type HarnessSettings,
  type ModelRef,
  type InputSubmissionDraft,
  type Tx,
  type Storage,
  type SubmissionId,
  type UserInput,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Env, openHarness, SshExecutionEnv } from "./harness/index.ts";
import type { EnvironmentSelection } from "./harness/env.ts";

export const environmentId = (selected: EnvironmentSelection | undefined): string =>
  selected?.type === "ssh" ? selected.host : (selected?.type ?? "");

export class InvalidForm extends Error {}

export const context = BACKGROUND_CONTEXT;
export const Session = defineDoc<{ title: string; createdAt: number }>({
  kind: "pds.session",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ title: "New session", createdAt: Date.now() }),
  checkpointWhen: () => true,
});

export type Environment = {
  id: string;
  label: string;
  target?: ConstructorParameters<typeof SshExecutionEnv>[0]["target"];
};

export async function discoverEnvironments(directory: string): Promise<Environment[]> {
  const result: Environment[] = [{ id: "local", label: "Local (server)" }];
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
    const target = {
      host,
      user: "root",
      identityFile: join(path, "id_ed25519"),
      knownHostsFile: join(path, "known_hosts"),
      configFile: "/etc/ssh/ssh_config",
      hostKeyAlias: host,
    };
    try {
      await Promise.all(
        [target.identityFile, target.knownHostsFile, join(path, "ssh_config")].map((file) =>
          access(file),
        ),
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    // Configuration permits a connection attempt; it does not certify activation.
    result.push({ id: host, label: host, target });
  }
  return result;
}

export async function openApplication(options: {
  id: string;
  storage: Storage;
  models: Models;
  environments: () => Promise<Environment[]>;
  cwd: string;
  settings?: HarnessSettings;
  parallelApiKeyFile?: string;
}): Promise<Application> {
  const environments = new Map<string, NodeExecutionEnv | SshExecutionEnv>();
  const harness: Harness = await openHarness(
    options.storage,
    {
      models: options.models,
      ...(options.settings ? { settings: options.settings } : {}),
      parallelApiKeyFile: options.parallelApiKeyFile,
      async env(target, ctx) {
        const selected = (await target.read.snapshot(Env, target.conversationId, ctx))?.env;
        if (!selected) return undefined;
        assert(
          selected.type === "local" || selected.type === "ssh",
          "Unsupported execution environment selection.",
        );
        const cwd = target.cwd ?? options.cwd;
        const key = JSON.stringify([selected, cwd]);
        let env = environments.get(key);
        if (!env) {
          env =
            selected.type === "ssh"
              ? new SshExecutionEnv({ target: selected, cwd })
              : new NodeExecutionEnv({ cwd });
          environments.set(key, env);
        }
        return env;
      },
    },
    context,
  );
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
          const initial = await initialOptions(options, form);
          await configure(tx, id, initial.agent);
          await initialize(tx, id, initial.environment);
        },
      });
    },
    async createConversation(
      form: FormData,
      ownership: ConversationCreateOptions["ownership"] = { kind: "ownerless" },
    ) {
      const initial = await initialOptions(options, form);
      return harness.createConversation(
        {
          ownership,
          agent: initial.agent,
          async init(tx, id) {
            await initialize(tx, id, initial.environment);
          },
        },
        context,
      );
    },
    models: options.models,
    environments: options.environments,
    cwd: options.cwd,
    async conversation(id: string) {
      const number = nativeId(id);
      return harness.conversation(number as ConversationId, context);
    },
    async list() {
      const page = await harness.commit(
        (tx) => tx.scanConversations({ order: "descending" }, 50),
        context,
      );
      return Promise.all(
        page.items.map(async (record) => {
          const info = await harness.snapshot(Session, record.id, context);
          return {
            id: record.id,
            title: info?.title ?? `Conversation ${record.id}`,
            ...(info ? { createdAt: info.createdAt } : {}),
          };
        }),
      );
    },
    async configure(conversation: Conversation, form: FormData) {
      const environment = form.has("environment")
        ? (await options.environments()).find((item) => item.id === field(form, "environment"))
        : undefined;
      if (form.has("environment") && !environment)
        throw new InvalidForm("Environment is no longer available.");
      await conversation.commit(async (tx) => {
        const current = await tx.doc(AgentDoc, conversation.id);
        const model = form.has("model")
          ? options.models
              .getModels()
              .find((candidate) => modelKey(candidate) === field(form, "model"))
          : current.model && options.models.getModel(current.model.provider, current.model.modelId);
        if (!model) throw new InvalidForm("Select an available model.");
        const levels = getSupportedThinkingLevels(model);
        const thinkingLevel = form.has("thinking")
          ? levels.find((level) => level === field(form, "thinking"))
          : (levels.find((level) => level === current.thinkingLevel) ?? levels[0]);
        if (!thinkingLevel)
          throw new InvalidForm("Select a thinking level supported by this model.");
        const directory = form.has("cwd") ? field(form, "cwd").trim() : undefined;
        if (directory === "") throw new InvalidForm("Working directory cannot be empty.");
        await configure(tx, conversation.id, {
          ...(form.has("model")
            ? { model: { provider: model.provider, modelId: model.id }, thinkingLevel }
            : {}),
          ...(form.has("thinking") ? { thinkingLevel } : {}),
          ...(directory ? { cwd: posix.resolve(current.cwd ?? options.cwd, directory) } : {}),
        });
        if (environment) {
          const draft = await tx.doc(Env, conversation.id);
          if (environment.target) draft.env = { type: "ssh", ...environment.target };
          else draft.env = { type: "local" };
        }
      }, context);
    },
    async submit(conversation: Conversation, form: FormData) {
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
    async send(conversation: Conversation, form: FormData) {
      const text = field(form, "message").trim();
      const files = uploads(form);
      if (text.startsWith("/")) {
        if (files.length) throw new InvalidForm("Commands cannot include attachments.");
        const [command, ...rest] = text.split(/\s+/);
        if (command === "/cd") {
          const directory = text.slice(command.length).trim();
          if (!directory) throw new InvalidForm("Usage: /cd <path>");
          await conversation.commit(async (tx) => {
            const agent = await tx.doc(AgentDoc, conversation.id);
            await configure(tx, conversation.id, {
              cwd: posix.resolve(agent.cwd ?? options.cwd, directory),
            });
          }, context);
          return undefined;
        }
        if (command === "/compact") {
          await conversation.compact(rest.join(" ") || undefined, context);
          return undefined;
        }
        if (command === "/new" && rest.length === 0) {
          const agent = await conversation.agent(context);
          const env = await harness.snapshot(Env, conversation.id, context);
          return harness.createConversation(
            {
              ownership: { kind: "ownerless" },
              agent: {
                model: agent.model ?? null,
                thinkingLevel: agent.thinkingLevel,
                cwd: agent.cwd ?? null,
              },
              async init(tx, id) {
                await tx.doc(Session, id);
                if (env?.env) (await tx.doc(Env, id)).env = { ...env.env };
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
        try {
          await harness.close(context);
        } finally {
          const results = await Promise.allSettled(
            [...environments.values()].map((env) => env.cleanup(context)),
          );
          const errors = results.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : [],
          );
          if (errors.length) throw new AggregateError(errors, "Environment cleanup failed");
        }
      })();
      return closing;
    },
  };
}

export interface Application {
  readonly id: string;
  harness: Harness;
  readonly available: boolean;
  root(form: FormData): Promise<Conversation>;
  createConversation(
    form: FormData,
    ownership?: ConversationCreateOptions["ownership"],
  ): Promise<Conversation>;
  models: Models;
  environments(): Promise<Environment[]>;
  cwd: string;
  conversation(id: string): Promise<Conversation | undefined>;
  list(): Promise<{ id: ConversationId; title: string; createdAt?: number }[]>;
  configure(conversation: Conversation, form: FormData): Promise<void>;
  submit(conversation: Conversation, form: FormData): Promise<SubmissionId>;
  send(
    conversation: Conversation,
    form: FormData,
  ): Promise<Conversation | SubmissionId | undefined>;
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
): Promise<Exclude<UserInput, string>> {
  if (!text && !files.length) throw new InvalidForm("Enter a message or attach a file.");
  const content: Exclude<UserInput, string> = text ? [{ type: "text", text }] : [];
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

export class InvalidRequest extends Error {}
export class SessionUnavailable extends Error {}

export function nativeId(value: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 0 || String(id) !== value)
    throw new InvalidRequest("Use a nonnegative safe decimal integer.");
  return id;
}

function sessionKey(id: string): string {
  if (
    !id.isWellFormed() ||
    !id.length ||
    Buffer.byteLength(id) > 128 ||
    [...id].some(
      (character) => character.codePointAt(0)! < 32 || character.codePointAt(0) === 127,
    ) ||
    id === "." ||
    id === ".."
  )
    throw new InvalidRequest(
      "Session IDs must be 1–128 UTF-8 bytes without control characters or URL dot segments.",
    );
  return Buffer.from(id).toString("base64url");
}

type Options = Omit<Parameters<typeof openApplication>[0], "storage" | "id">;

async function initialOptions(options: Options, form: FormData) {
  let agent: AgentChange = {};
  const model = form.has("model")
    ? options.models.getModels().find((candidate) => modelKey(candidate) === field(form, "model"))
    : undefined;
  if (form.has("model") && !model) throw new InvalidForm("Select an available model.");
  if (model) agent = { ...agent, model: { provider: model.provider, modelId: model.id } };
  if (form.has("thinking")) {
    const value = field(form, "thinking");
    const level = model && getSupportedThinkingLevels(model).find((level) => level === value);
    if (!level) throw new InvalidForm("Select a model and a supported thinking level.");
    agent = { ...agent, thinkingLevel: level };
  }
  if (form.has("cwd")) {
    const cwd = field(form, "cwd");
    if (!cwd) throw new InvalidForm("Working directory cannot be empty.");
    agent = { ...agent, cwd };
  }
  const environment = form.has("environment")
    ? (await options.environments()).find((item) => item.id === field(form, "environment"))
    : undefined;
  if (form.has("environment") && !environment)
    throw new InvalidForm("Environment is no longer available.");
  return { agent, environment };
}

export interface Sessions extends Options {
  open(id?: string): Promise<Application>;
  get(id: string): Promise<Application | undefined>;
  list(): Promise<{ id: string; status: "open" | "unavailable" }[]>;
  compose(form: FormData): Promise<{ sessionId: string; conversation: Conversation }>;
  close(): Promise<void>;
}

/** One owner per persisted store. Only explicit open may allocate a database. */
export async function openSessions(options: Options & { directory: string }): Promise<Sessions> {
  const legacy = await lstat(join(options.directory, "sessions.sqlite")).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (legacy) throw new Error("Legacy sessions.sqlite requires an explicit operator decision.");
  const directory = join(options.directory, "sessions");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  assert((await lstat(directory)).isDirectory(), "Session storage must be a directory");
  type Record = { owner?: Application; opening?: Promise<Application>; error?: unknown };
  const records = new Map<string, Record>();
  let closing: Promise<void> | undefined;

  async function discover() {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const id = Buffer.from(entry.name, "base64url").toString("utf8");
      try {
        if (sessionKey(id) !== entry.name) continue;
      } catch (error) {
        if (error instanceof InvalidRequest) continue;
        throw error;
      }
      if (!records.has(id)) records.set(id, {});
    }
  }

  function acquire(id: string, create: boolean): Promise<Application> {
    const key = sessionKey(id);
    if (closing) return Promise.reject(new SessionUnavailable("PDS is closing."));
    let record = records.get(id);
    if (record?.opening) return record.opening;
    if (record?.owner?.available) return Promise.resolve(record.owner);
    record ??= {};
    records.set(id, record);
    const selected = record;
    selected.opening = (async () => {
      await selected.owner?.close();
      const path = join(directory, key);
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
      const owner = await openApplication({
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
    async open(id = randomUUID()) {
      return acquire(id, !records.has(id));
    },
    async get(id) {
      sessionKey(id);
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
      const { agent, environment } = await initialOptions(options, form);
      if (!agent.model || !agent.thinkingLevel || !agent.cwd || !environment)
        throw new InvalidForm(
          "Select a model, thinking level, working directory, and environment.",
        );
      if (!isAbsolute(agent.cwd))
        throw new InvalidForm("Working directory must be an absolute path.");
      const text = typeof form.get("message") === "string" ? field(form, "message").trim() : "";
      const files = uploads(form);
      if (text.startsWith("/") && (text !== "/new" || files.length))
        throw new InvalidForm("Start a conversation before using this command.");
      const content =
        (text && text !== "/new") || files.length
          ? await input(options.models, text, files, agent.model)
          : undefined;
      // All validation precedes state allocation; admission after creation is a separate boundary.
      const sessionId = form.has("sessionId") ? field(form, "sessionId") : randomUUID();
      const app = await acquire(sessionId, !records.has(sessionId));
      const conversation = await app.harness.createConversation(
        {
          ownership: { kind: "ownerless" },
          agent,
          init: (tx, id) => initialize(tx, id, environment),
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

async function initialize(tx: Tx, id: ConversationId, environment?: Environment) {
  await tx.doc(Session, id);
  if (environment) {
    const draft = await tx.doc(Env, id);
    if (environment.target) draft.env = { type: "ssh", ...environment.target };
    else draft.env = { type: "local" };
  }
}

async function input(models: Models, text: string, files: File[], model: ModelRef | undefined) {
  const content = await attachments(text, files);
  if (
    content.some((part) => part.type === "image") &&
    (!model || !models.getModel(model.provider, model.modelId)?.input.includes("image"))
  )
    throw new InvalidForm("Select a model that accepts images.");
  return content;
}

async function submitInput(conversation: Conversation, draft: InputSubmissionDraft, title: string) {
  return conversation.commit(async (tx) => {
    const id = await conversation.submit(tx, draft);
    const info = await tx.doc(Session, conversation.id);
    if (info.title === "New session") info.title = title.slice(0, 100);
    return id;
  }, context);
}
