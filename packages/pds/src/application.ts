import assert from "node:assert/strict";
import { readdir, access } from "node:fs/promises";
import { isAbsolute, join, posix } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getSupportedThinkingLevels, type Models } from "@earendil-works/pi-ai/models";
import {
  configure,
  AgentDoc,
  defineDoc,
  type Conversation,
  type ConversationId,
  type Cursor,
  type Harness,
  type HarnessSettings,
  type ModelRef,
  type Storage,
  type SubmissionId,
  type UserInput,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Env, openHarness, SshExecutionEnv } from "durable-harness";

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
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("drv.run.")) continue;
    const path = join(directory, entry.name);
    const target = {
      host: entry.name,
      user: "root",
      identityFile: join(path, "client-key"),
      knownHostsFile: join(path, "known_hosts"),
      configFile: join(path, "client.conf"),
      hostKeyAlias: entry.name,
    };
    try {
      await Promise.all(
        [target.identityFile, target.knownHostsFile, target.configFile].map((file) => access(file)),
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    result.push({ id: entry.name, label: entry.name, target });
  }
  return result;
}

export async function openApplication(options: {
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
        const cwd = target.cwd ?? options.cwd;
        const key = JSON.stringify([selected, cwd]);
        let env = environments.get(key);
        if (!env) {
          env = selected
            ? new SshExecutionEnv({ target: selected, cwd })
            : new NodeExecutionEnv({ cwd });
          environments.set(key, env);
        }
        return env;
      },
    },
    context,
  );
  harness.resume();

  async function selection(form: FormData) {
    const model = options.models
      .getModels()
      .find((candidate) => modelKey(candidate) === field(form, "model"));
    if (!model) throw new InvalidForm("Select an available model.");
    const thinkingLevel = getSupportedThinkingLevels(model).find(
      (level) => level === field(form, "thinking"),
    );
    if (!thinkingLevel) throw new InvalidForm("Select a thinking level supported by this model.");
    const cwd = field(form, "cwd");
    if (!isAbsolute(cwd)) throw new InvalidForm("Working directory must be an absolute path.");
    const environment = (await options.environments()).find(
      (item) => item.id === field(form, "environment"),
    );
    if (!environment) throw new InvalidForm("Environment is no longer available.");
    return {
      agent: { model: { provider: model.provider, modelId: model.id }, thinkingLevel, cwd },
      environment,
    };
  }

  async function input(text: string, files: File[], model: ModelRef | undefined) {
    const content = await attachments(text, files);
    if (content.some((part) => part.type === "image")) {
      assert(model);
      if (!options.models.getModel(model.provider, model.modelId)?.input.includes("image")) {
        throw new InvalidForm("This model does not accept images.");
      }
    }
    return content;
  }

  async function submit(conversation: Conversation, content: UserInput, title: string) {
    return conversation.commit(async (tx) => {
      const id = await conversation.submit(tx, { type: "input", content, whenBusy: "followUp" });
      const session = await tx.doc(Session, conversation.id);
      if (session.title === "New session") session.title = title.slice(0, 100);
      return id;
    }, context);
  }

  async function create(form: FormData) {
    const { agent, environment } = await selection(form);
    const prompt = form.get("message");
    const text = typeof prompt === "string" ? prompt.trim() : "";
    const files = uploads(form);
    if (text.startsWith("/") && (text !== "/new" || files.length))
      throw new InvalidForm(
        "Start a conversation before using /compact. Use /new to create an empty session.",
      );
    const content =
      (text && text !== "/new") || files.length ? await input(text, files, agent.model) : undefined;
    const conversation = await harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent,
        async init(tx, id) {
          await tx.doc(Session, id);
          if (environment.target)
            (await tx.doc(Env, id)).env = { type: "ssh", ...environment.target };
        },
      },
      context,
    );
    if (content) await submit(conversation, content, text || files[0]!.name);
    return conversation;
  }

  return {
    harness,
    models: options.models,
    environments: options.environments,
    cwd: options.cwd,
    create,
    async conversation(id: string) {
      const number = Number(id);
      if (!Number.isSafeInteger(number) || number < 0) return undefined;
      return harness.conversation(number as ConversationId, context);
    },
    async list() {
      const items: { id: ConversationId; title: string; createdAt: number }[] = [];
      let cursor: Cursor | undefined;
      do {
        const page = await harness.commit(
          (tx) => tx.scanConversations({ order: "descending" }, 256, cursor),
          context,
        );
        for (const record of page.items) {
          const session = await harness.snapshot(Session, record.id, context);
          if (session) items.push({ id: record.id, ...session });
        }
        cursor = page.next;
      } while (cursor);
      return items;
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
          else delete draft.env;
        }
      }, context);
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
      const content = await input(text, files, (await conversation.agent(context)).model);
      return submit(conversation, content, text || files[0]!.name);
    },
    async close() {
      try {
        await harness.close(context);
      } finally {
        await Promise.all([...environments.values()].map((env) => env.cleanup(context)));
      }
    },
  };
}

export interface Application {
  harness: Harness;
  models: Models;
  environments(): Promise<Environment[]>;
  cwd: string;
  create(form: FormData): Promise<Conversation>;
  conversation(id: string): Promise<Conversation | undefined>;
  list(): Promise<{ id: ConversationId; title: string; createdAt: number }[]>;
  configure(conversation: Conversation, form: FormData): Promise<void>;
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
