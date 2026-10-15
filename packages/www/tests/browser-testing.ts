import assert from "node:assert/strict";
import { type TestContext } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { buildSchema, graphql, GraphQLError, Kind, parse } from "graphql";
import { type Browser, type Page } from "playwright";

const schema = buildSchema(
  await readFile(
    process.env.GRAPHQL_SCHEMA ??
      new URL("../../durable/api/graphql/schema.graphql", import.meta.url),
    "utf8",
  ),
);

type Catalog =
  | "harnesses"
  | "models"
  | "instances"
  | "harness"
  | "settings"
  | "open"
  | "root"
  | "submit"
  | "configure"
  | "compact"
  | "abort"
  | "abortSubmission"
  | "resume";
type Target = {
  type: string;
  host: string;
  hostKeyAlias: string;
  knownHostsFile: string;
  user?: string | null;
  port?: number | null;
  identityFile?: string | null;
  configFile?: string | null;
};
type Agent = {
  cwd: string | null;
  model: { provider: string; modelId: string } | null;
  thinkingLevel: string;
};
type Options = { agent?: Partial<Agent>; env?: Target | null };
type Submitted = {
  conversationId: string;
  submission: {
    input: {
      requestId: string;
      whenBusy: string;
      content: {
        blocks: ({ text: { text: string } } | { image: { mimeType: string; data: string } })[];
      };
    };
  };
};
const target: Target = {
  type: "ssh",
  host: "guest-one",
  hostKeyAlias: "guest-one-key",
  knownHostsFile: "/run/known-hosts",
  user: "dev",
  port: 2222,
  identityFile: "/run/identity",
  configFile: "/dev/null",
};

type Fault =
  | "too-large"
  | "http"
  | "network"
  | "malformed"
  | "denied"
  | "unauthenticated"
  | "graphql"
  | "graphql-denied"
  | "graphql-unauthenticated";
export const initialModels = [
  {
    id: "same/id",
    provider: "one",
    name: "Reasoning model",
    thinkingLevels: ["off", "low", "high"],
  },
  { id: "same/id", provider: "two", name: "Fast model", thinkingLevels: ["off"] },
];
export const initialSessions: {
  id: string;
  externalId: string;
  root: {
    durableId: number;
    agent: { cwd: string; model: { provider: string; modelId: string } };
    env: Target;
  } | null;
}[] = [
  {
    id: "global:a",
    externalId: "alpha",
    root: {
      durableId: 1,
      agent: { cwd: "/workspace/one", model: { provider: "one", modelId: "same/id" } },
      env: { ...target },
    },
  },
  { id: "global:z", externalId: "zeta", root: null },
];
export const instance = {
  id: "instance:one",
  unit: "drv.run@one.service",
  connect: { ...target },
};

export type Entry = {
  id: number;
  conversationId: number;
  kind: string;
  model?: Record<string, unknown>[];
  data?: unknown;
  head?: number;
};
export const user = (text: string) => ({ role: "user", timestamp: 1700000000000, content: text });
export const usage = {
  input: 1200,
  output: 350,
  cacheRead: 4000,
  cacheWrite: 20,
  totalTokens: 5570,
  cost: { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0.004, total: 0.037 },
};
export const assistant = (text: string) => ({
  role: "assistant",
  timestamp: 1700000001000,
  api: "test",
  provider: "one",
  model: "same/id",
  stopReason: "stop",
  content: [{ type: "text", text }],
  usage,
});
export const entry = (id: number, message: Record<string, unknown>): Entry => ({
  id,
  conversationId: 1,
  kind: message.role === "user" ? "pi.user" : "pi.assistant",
  model: [message],
});
export function snapshot() {
  return {
    view: {
      conversation: { id: 1 },
      entries: [entry(1, user("Hello")), entry(2, assistant("Hello from Pi."))],
      docs: {} as Record<string, unknown>,
      before: undefined as number | undefined,
    },
    head: null as Entry | null,
  };
}
function graphqlEntry(record: Entry) {
  const content = (part: Record<string, unknown>) => ({
    ...part,
    __typename: (
      {
        text: "TextContent",
        thinking: "ThinkingContent",
        image: "ImageContent",
        toolCall: "ToolCall",
      } as Record<string, string>
    )[String(part.type)],
  });
  return {
    ...record,
    id: `global:entry:${record.id}`,
    durableId: record.id,
    model: record.model?.map((message) => ({
      ...message,
      __typename: (
        {
          user: "UserMessage",
          assistant: "AssistantMessage",
          toolResult: "ToolResultMessage",
          system: "SystemMessage",
        } as Record<string, string>
      )[String(message.role)],
      content:
        message.role === "user" || message.role === "system"
          ? typeof message.content === "string"
            ? { __typename: "StringContent", text: message.content }
            : {
                __typename: message.role === "user" ? "UserContentList" : "TextContentList",
                blocks: (message.content as Record<string, unknown>[]).map(content),
              }
          : (message.content as Record<string, unknown>[]).map(content),
    })),
  };
}

export async function fixture(t: TestContext, browser: Browser, width = 1280, height = 800) {
  const state = {
    models: structuredClone(initialModels).map((model) => ({ ...model, contextWindow: 200000 })),
    sessions: structuredClone(initialSessions),
    instances: [instance],
    next: null as null | { after: string },
    faults: {} as Partial<Record<Catalog, Fault>>,
    hold: {} as Partial<Record<Catalog, Promise<void>>>,
    holdReply: {} as Partial<Record<Catalog, { ready: () => void; wait: Promise<void> }>>,
    partial: false,
    snapshot: snapshot(),
    history: [] as Entry[],
    historyNext: null as null | { after: number },
    historyModelFailure: null as number | null,
    branchesNext: null as null | { after: number },
    branches: [1, 2],
    tasks: [] as Record<string, unknown>[],
    failTimings: false,
    failBranches: false,
    tasksNext: null as null | { after: number },
    placements: new Map<number, number>(),
    settings: {
      __typename: "WebSettings",
      wrapCode: false,
      bottomAlign: true,
      hideThinkingBlock: false,
      showImages: true,
      defaultDeliveryMode: "followUp",
    },
    automaticBaseline: true,
    agent: {
      cwd: "/workspace/one",
      model: { provider: "one", modelId: "same/id" },
      thinkingLevel: "high",
    } as Agent,
    env: { ...target } as Target | null,
    submissions: [] as Submitted[],
    receipts: new Map<string, string>(),
    configurations: [] as { conversationId: string; change: Partial<Agent>; env?: Target | null }[],
    compactions: [] as { conversationId: string; instructions?: string }[],
    resumes: [] as string[],
    withdrawals: [] as { conversationId: string; id: number }[],
    aborts: [] as string[],
    roots: [] as { harnessId: string; options?: Options }[],
    opens: [] as string[],
    loseAcknowledgement: new Set<Catalog>(),
    busyReject: false,
  };
  const requests: { field: Catalog; cursor: unknown; query?: unknown }[] = [];
  const streams = new Map<
    import("node:http").ServerResponse,
    { externalId: string; conversationId: number }
  >();
  const watchRequests: { externalId: string; conversationId: number }[] = [];
  const errors: unknown[] = [];
  const emit = (batch: unknown) => {
    for (const response of streams.keys()) response.write(`data: ${JSON.stringify(batch)}\n\n`);
  };
  const publish = () => emit([["r", state.snapshot]]);
  const rootValue = {
    open({ input }: { input: { externalId: string } }) {
      state.opens.push(input.externalId);
      let session = state.sessions.find((item) => item.externalId === input.externalId);
      if (!session) {
        session = { id: `global:${input.externalId}`, externalId: input.externalId, root: null };
        state.sessions.push(session);
      }
      return { harness: { id: session.id } };
    },
    root({ input }: { input: { harnessId: string; options?: Options } }) {
      state.roots.push(structuredClone(input));
      const session = state.sessions.find((item) => item.id === input.harnessId);
      assert(session);
      if (!session.root) {
        state.agent = {
          cwd: null,
          model: null,
          ...input.options?.agent,
          thinkingLevel: input.options?.agent?.thinkingLevel ?? "off",
        };
        state.env = input.options?.env ?? null;
        session.root = {
          durableId: 1,
          agent: {
            cwd: state.agent.cwd ?? "",
            model: state.agent.model ?? { provider: "", modelId: "" },
          },
          env: state.env ?? { ...target },
        };
        state.snapshot = snapshot();
        state.snapshot.view.entries = [];
      }
      return {
        conversation: {
          id: `global:${session.externalId}:1`,
          durableId: 1,
          agent: state.agent,
          env: state.env,
        },
      };
    },
    submit({ input }: { input: Submitted }) {
      if (state.busyReject)
        throw new GraphQLError("Busy", { extensions: { code: "CONVERSATION_BUSY" } });
      const requestId = input.submission.input.requestId;
      const existing = state.receipts.get(requestId);
      if (existing) return { submissionId: existing };
      state.submissions.push(structuredClone(input));
      const submissionId = `global:submission:${state.submissions.length}`;
      state.receipts.set(requestId, submissionId);
      const content = input.submission.input.content.blocks.map((block) =>
        "text" in block
          ? { type: "text", text: block.text.text }
          : { type: "image", ...block.image },
      );
      state.snapshot.view.entries.push(
        entry(state.snapshot.view.entries.length + 1, {
          role: "user",
          timestamp: 1700000000000,
          content,
        }),
      );
      state.snapshot.view.docs["pi.live"] = { run: { taskId: 1, inputs: [], turns: 0 } };
      publish();
      return { submissionId };
    },
    configure({
      input,
    }: {
      input: { conversationId: string; change: Partial<Agent>; env?: Target | null };
    }) {
      state.configurations.push(structuredClone(input));
      state.agent = {
        ...state.agent,
        ...input.change,
        thinkingLevel:
          input.change.thinkingLevel === null
            ? "off"
            : (input.change.thinkingLevel ?? state.agent.thinkingLevel),
      };
      if ("env" in input) state.env = input.env ?? null;
      state.snapshot.view.docs["pi.agent"] = state.agent;
      publish();
      return true;
    },
    compact({ input }: { input: { conversationId: string; instructions?: string } }) {
      state.compactions.push(structuredClone(input));
      return { taskId: "global:task:99" };
    },
    abort({ input }: { input: { conversationId: string } }) {
      state.aborts.push(input.conversationId);
      state.snapshot.view.docs["pi.live"] = {};
      publish();
      return true;
    },
    resume({ input }: { input: { harnessId: string } }) {
      state.resumes.push(input.harnessId);
      return true;
    },
    abortSubmission({ input }: { input: { conversationId: string; id: number } }) {
      state.withdrawals.push(structuredClone(input));
      return { result: "aborted" };
    },
    harness({ externalId }: { externalId: string }) {
      const session = state.sessions.find((item) => item.externalId === externalId);
      if (!session) return null;
      if (state.faults.harness === "graphql") throw new GraphQLError("Unavailable");
      const record = (durableId: number) => ({
        id: `global:${externalId}:${durableId}`,
        durableId,
        agent: state.agent,
        env: state.env,
        submissionByRequest({ requestId }: { requestId: string }) {
          const id = state.receipts.get(requestId);
          return id ? { id } : null;
        },
        parent: durableId === 1 ? null : { conversationId: 1, at: 1 },
        owner: null,
        status({ id }: { id: number }) {
          const placed = state.placements.get(id);
          return placed === undefined ? null : { entry: placed };
        },
        entries(
          { cursor, query }: { cursor?: unknown; query: unknown },
          context: { cursor: unknown; query?: unknown },
        ) {
          context.cursor = cursor;
          context.query = query;
          return {
            nodes: state.history.map((entry) => {
              const record = graphqlEntry(entry);
              return {
                ...record,
                model() {
                  if (entry.id === state.historyModelFailure)
                    throw new GraphQLError("Entry model unavailable");
                  return record.model;
                },
              };
            }),
            pageInfo: { next: state.historyNext },
          };
        },
      });
      return {
        id: session.id,
        externalId,
        root: session.root ? record(session.root.durableId) : null,
        conversation({ id }: { id: number }) {
          return state.branches.includes(id) ? record(id) : null;
        },
        scanTasks() {
          if (state.failTimings) throw new GraphQLError("Task scan unavailable");
          return { nodes: state.tasks, pageInfo: { next: state.tasksNext } };
        },
        scanConversations({ cursor }: { cursor?: unknown }, context: { cursor: unknown }) {
          context.cursor = cursor;
          if (state.failBranches) throw new GraphQLError("Branch scan unavailable");
          return { nodes: state.branches.map(record), pageInfo: { next: state.branchesNext } };
        },
      };
    },
    settings() {
      return state.settings;
    },
    harnesses() {
      switch (state.faults.harnesses) {
        case "graphql":
          throw new GraphQLError("unavailable");
        case "graphql-denied":
          throw new GraphQLError("private diagnostic", { extensions: { code: "FORBIDDEN" } });
        case "graphql-unauthenticated":
          throw new GraphQLError("private diagnostic", { extensions: { code: "UNAUTHENTICATED" } });
      }
      return state.sessions;
    },
    models() {
      if (state.faults.models === "graphql") throw new GraphQLError("unavailable");
      return state.models;
    },
    instances({ cursor }: { cursor?: unknown }, record: { cursor: unknown }) {
      record.cursor = cursor;
      if (state.faults.instances === "graphql") throw new GraphQLError("unavailable");
      return {
        nodes: state.instances.map((item) => ({
          ...item,
          connect() {
            if (state.partial && item.id === instance.id)
              throw new GraphQLError("Connection data unavailable");
            return item.connect;
          },
        })),
        pageInfo: { next: state.next },
      };
    },
  };
  const assets: Record<string, string> = {
    "/": "index.html",
    "/main.js": "main.js",
    "/styles.css": "styles.css",
    "/bootstrap.js": "bootstrap.js",
  };
  const server = createServer((request, response) => {
    void (async () => {
      if (request.url === "/api/graphql") {
        assert.equal(request.method, "POST");
        assert.equal(request.headers["content-type"], "application/json");
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString()) as { query: string };
        const operation = parse(body.query).definitions[0];
        assert.equal(operation?.kind, Kind.OPERATION_DEFINITION);
        assert(operation?.kind === Kind.OPERATION_DEFINITION);
        assert(["query", "mutation"].includes(operation.operation));
        const selection = operation.selectionSet.selections[0];
        assert(selection?.kind === Kind.FIELD);
        const field = selection.name.value;
        assert(
          field === "harnesses" ||
            field === "models" ||
            field === "instances" ||
            field === "harness" ||
            field === "settings" ||
            field === "open" ||
            field === "root" ||
            field === "submit" ||
            field === "configure" ||
            field === "compact" ||
            field === "abort" ||
            field === "abortSubmission" ||
            field === "resume",
        );
        const record: { field: Catalog; cursor: unknown } = { field, cursor: undefined };
        requests.push(record);
        await state.hold[field];
        const fault = state.faults[field];
        if (fault === "network") return request.socket.destroy();
        if (fault === "too-large") {
          response.writeHead(413).end();
          return;
        }
        if (fault === "http" || fault === "denied" || fault === "unauthenticated") {
          response.writeHead({ http: 503, denied: 403, unauthenticated: 401 }[fault]).end();
          return;
        }
        if (fault === "malformed") {
          response.writeHead(200, { "content-type": "application/json" }).end("{");
          return;
        }
        const result = await graphql({
          schema,
          source: body.query,
          rootValue,
          contextValue: record,
        });
        const replyGate = state.holdReply[field];
        replyGate?.ready();
        await replyGate?.wait;
        if (state.loseAcknowledgement.delete(field)) {
          // The mutation committed, but its acknowledgement body was lost.
          response.writeHead(200, { "content-type": "application/json" }).end("{");
          return;
        }
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
        return;
      }
      const requestUrl = new URL(request.url ?? "/", "http://localhost");
      const path = requestUrl.pathname;
      if (path === "/api/watch") {
        assert.equal(request.method, "GET");
        const address = {
          externalId: requestUrl.searchParams.get("externalId")!,
          conversationId: Number(requestUrl.searchParams.get("conversationId")),
        };
        watchRequests.push(address);
        streams.set(response, address);
        response.on("close", () => streams.delete(response));
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
        });
        response.flushHeaders();
        if (state.automaticBaseline)
          response.write(
            `data: ${JSON.stringify([["r", { ...state.snapshot, view: { ...state.snapshot.view, conversation: { id: address.conversationId } } }]])}\n\n`,
          );
        return;
      }
      const name =
        assets[path] ?? (request.headers.accept?.includes("text/html") ? "index.html" : undefined);
      if (!name) {
        response.writeHead(404).end();
        return;
      }
      const bytes = await readFile(new URL(`../dist/${name}`, import.meta.url));
      response
        .writeHead(200, {
          "content-type": name.endsWith(".js")
            ? "text/javascript"
            : name.endsWith(".css")
              ? "text/css"
              : "text/html",
        })
        .end(bytes);
    })().catch((error) => {
      errors.push(error);
      response.writeHead(500).end();
    });
  });
  let activePage: Page | undefined;
  t.after(async () => {
    await activePage?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    assert.deepEqual(errors, []);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/`;
  const page = await browser.newPage({ viewport: { width, height } });
  activePage = page;
  page.on("pageerror", (error) => errors.push(error));

  return {
    page,
    state,
    requests,
    url,
    streams,
    watchRequests,
    emit,
  };
}

export async function ready(page: Page) {
  await page.locator("#models option").nth(2).waitFor({ state: "attached" });
  await page.locator("#targets option").nth(1).waitFor({ state: "attached" });
  await page.locator("#session-list .session").nth(1).waitFor();
  await page.locator(".read-status").waitFor({ state: "detached" });
}

export async function refresh(page: Page, name: string) {
  await page.getByRole("button", { name: `Refresh ${name}`, exact: true }).click({ force: true });
}
