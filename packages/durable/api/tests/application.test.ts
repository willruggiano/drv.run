import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Env } from "durable-harness";
import { DatabaseSync } from "node:sqlite";
import { Harness, type ConversationId } from "@earendil-works/pi-durable";
import { readDeploymentConfiguration } from "../src/configuration.ts";
import { openApplication } from "../src/application.ts";

await test("application composes GraphQL with persistent Harness discovery and open", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "durable-api-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const config = readDeploymentConfiguration(
    {
      XDG_CONFIG_HOME: join(directory, "config"),
      XDG_RUNTIME_DIR: join(directory, "runtime"),
      XDG_STATE_HOME: join(directory, "instance-state"),
    },
    1000,
    directory,
  );
  const app = await openApplication(config);
  t.after(async () => app.close());
  const signal = new AbortController().signal;
  const query = await app.api.graphql(
    {
      source: `{
        harnesses { externalId }
        accounts(limit: 10) { nodes { id } pageInfo { next } }
        authorizationServers(limit: 10) { nodes { id } pageInfo { next } }
        push { applicationServerKey }
        web: settings(app: web) {
          __typename
          ... on WebSettings { wrapCode bottomAlign }
        }
        missing: harness(externalId: "absent") { id }
      }`,
    },
    signal,
  );
  assert.equal(query.errors, undefined);
  const queryData = query.data as {
    harnesses: unknown[];
    accounts: { nodes: unknown[] };
    authorizationServers: { nodes: unknown[]; pageInfo: { next: unknown } };
    push: { applicationServerKey: string | null };
    web: { wrapCode: boolean; bottomAlign: boolean };
    missing: unknown;
  };
  assert.deepEqual(queryData.harnesses, []);
  assert.deepEqual(queryData.accounts.nodes, []);
  assert.deepEqual(queryData.authorizationServers.nodes, []);
  assert.equal(queryData.authorizationServers.pageInfo.next, null);
  assert.equal(queryData.push.applicationServerKey, null);
  assert.equal(queryData.web.wrapCode, false);
  assert.equal(queryData.web.bottomAlign, true);
  assert.equal(queryData.missing, null);
  const saved = await app.api.graphql(
    {
      source: `mutation Save($input: SaveSettingsInput!) {
        saveSettings(input: $input) { ... on WebSettings { wrapCode } }
      }`,
      variableValues: {
        input: {
          web: {
            settings: {
              wrapCode: true,
              bottomAlign: true,
              hideThinkingBlock: false,
              showImages: true,
              defaultDeliveryMode: "followUp",
            },
          },
        },
      },
    },
    signal,
  );
  assert.equal(saved.errors, undefined);
  assert.equal((saved.data as { saveSettings: { wrapCode: boolean } }).saveSettings.wrapCode, true);
  const unavailable = await app.api.graphql(
    {
      source: `mutation {
        registerPushSubscription(input: {
          endpoint: "https://push.invalid/subscription",
          keys: { auth: "auth", p256dh: "key" }
        })
      }`,
    },
    signal,
  );
  assert.equal(unavailable.errors?.[0]?.extensions.code, "BAD_REQUEST");
  const unavailableRemoval = await app.api.graphql(
    {
      source: `mutation {
        removePushSubscription(input: { endpoint: "https://push.invalid/subscription" })
      }`,
    },
    signal,
  );
  assert.equal(unavailableRemoval.errors, undefined);
  assert.equal(unavailableRemoval.data?.removePushSubscription, true);
  const opened = await app.api.graphql(
    {
      source: `mutation { open(input: { externalId: "test_session" }) { harness { id externalId } } }`,
    },
    signal,
  );
  assert.equal(opened.errors, undefined);
  const openedData = opened.data as {
    open: { harness: { id: string; externalId: string } };
  };
  assert.equal(openedData.open.harness.externalId, "test_session");
  const root = await app.api.graphql(
    {
      source: `mutation($id:ID!) { root(input:{harnessId:$id}) { conversation { durableId } } }`,
      variableValues: { id: openedData.open.harness.id },
    },
    signal,
  );
  assert.equal(root.errors, undefined);
  const rootData = root.data as { root: { conversation: { durableId: number } } };
  const scope = { kind: "conversation", conversationId: rootData.root.conversation.durableId };
  const documents = await app.api.graphql(
    {
      source: `query($scope:DocumentScopeInput!) { harness(externalId:"test_session") {
      documentDefinitions(scope:$scope) { kind }
      snapshot(address:{kind:"pi.agent",scope:$scope})
    } }`,
      variableValues: { scope },
    },
    signal,
  );
  assert.equal(documents.errors, undefined);
  const documentData = documents.data as {
    harness: { documentDefinitions: { kind: string }[]; snapshot: unknown };
  };
  assert.deepEqual(documentData.harness.documentDefinitions.map(({ kind }) => kind).sort(), [
    "app.env",
    "pi.agent",
  ]);
  assert.ok(documentData.harness.snapshot);

  assert.equal(
    (
      await stat(join(directory, "instance-state/drv.run/harness/sessions/test_session.sqlite"))
    ).isFile(),
    true,
  );
  const listed = await app.api.graphql({ source: "{ harnesses { externalId } }" }, signal);
  assert.equal(listed.errors, undefined);
  const listedData = listed.data as { harnesses: { externalId: string }[] };
  assert.equal(listedData.harnesses[0]?.externalId, "test_session");
  await app.close();

  const reopened = await openApplication(config);
  t.after(async () => reopened.close());
  const persisted = await reopened.api.graphql({ source: "{ harnesses { externalId } }" }, signal);
  const persistedData = persisted.data as { harnesses: { externalId: string }[] };
  assert.equal(persistedData.harnesses[0]?.externalId, "test_session");
});

await test("application retries a Harness open after invalid persisted runtime settings", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "durable-api-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const config = readDeploymentConfiguration(
    {
      XDG_CONFIG_HOME: join(directory, "config"),
      XDG_RUNTIME_DIR: join(directory, "runtime"),
      XDG_STATE_HOME: join(directory, "instance-state"),
    },
    1000,
    directory,
  );
  await mkdir(join(config.configDirectory, "harness"), { recursive: true });
  const harnessSettings = join(config.configDirectory, "harness", "settings.json");
  await writeFile(harnessSettings, JSON.stringify({ unexpected: true }));
  const app = await openApplication(config);
  t.after(async () => app.close());
  const signal = new AbortController().signal;
  const failed = await app.api.graphql(
    { source: `mutation { open(input: { externalId: "recover" }) { harness { id } } }` },
    signal,
  );
  assert.equal(failed.errors?.[0]?.extensions.code, "INTERNAL_SERVER_ERROR");
  await writeFile(
    harnessSettings,
    JSON.stringify({
      stream: { transport: "websocket-cached" },
      steeringMode: "all",
      followUpMode: "all",
    }),
  );
  const open = t.mock.method(Harness, "open");
  const recovered = await app.api.graphql(
    { source: `mutation { open(input: { externalId: "recover" }) { harness { externalId } } }` },
    signal,
  );
  assert.equal(recovered.errors, undefined);
  assert.equal(open.mock.callCount(), 1);
  const policy = open.mock.calls[0]!.arguments[1].settings;
  assert.ok(policy && typeof policy !== "function");
  assert.deepEqual(policy.stream, { transport: "websocket-cached" });
  assert.equal(policy.steeringMode, "all");
  assert.equal(policy.followUpMode, "all");
  assert.equal(
    (recovered.data as { open: { harness: { externalId: string } } }).open.harness.externalId,
    "recover",
  );
});

await test("application refuses unsafe external session identifiers before storage lookup", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "durable-api-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const config = readDeploymentConfiguration(
    {
      XDG_CONFIG_HOME: join(directory, "config"),
      XDG_RUNTIME_DIR: join(directory, "runtime"),
      XDG_STATE_HOME: join(directory, "instance-state"),
    },
    1000,
    directory,
  );
  const app = await openApplication(config);
  t.after(async () => app.close());
  const result = await app.api.graphql(
    { source: `mutation { open(input: { externalId: "../unsafe" }) { harness { id } } }` },
    new AbortController().signal,
  );
  assert.equal(result.errors?.[0]?.extensions.code, "BAD_REQUEST");
});

async function applicationFixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "application-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = readDeploymentConfiguration(
    { XDG_STATE_HOME: directory, XDG_CONFIG_HOME: join(directory, "config") },
    1000,
    directory,
  );
  const app = await openApplication(config);
  t.after(() => app.close().catch(() => {}));
  return { app, config, directory };
}

await test("application environment acquisitions follow persisted selection without closing borrowed SSH environments", async (t) => {
  const { app } = await applicationFixture(t);
  const opened = t.mock.method(Harness, "open");
  const result = await app.api.graphql(
    { source: 'mutation { open(input:{externalId:"env"}) { harness { id } } }' },
    new AbortController().signal,
  );
  assert.equal(result.errors, undefined);
  const call = opened.mock.calls[0]!;
  const harness = await call.result;
  assert(harness);
  const factory = call.arguments[1].env;
  assert(factory);
  const root = await harness.root(BACKGROUND_CONTEXT);
  const target = { conversationId: root.id, read: harness };
  const models = await app.api.graphql(
    { source: "{ models { id } }" },
    new AbortController().signal,
  );
  assert.equal(models.errors, undefined);
  assert(Array.isArray(models.data?.models));
  const watched = await app.api.watch(
    { externalId: "env", conversationId: root.id },
    new AbortController().signal,
  );
  await watched.cancel();
  assert.equal(await factory(target, BACKGROUND_CONTEXT), undefined);
  await harness.commit(async (tx) => {
    (await tx.doc(Env, root.id)).env = {
      type: "ssh",
      host: "guest",
      knownHostsFile: "/known-hosts",
      hostKeyAlias: "guest",
    };
  }, BACKGROUND_CONTEXT);
  const first = await factory(target, BACKGROUND_CONTEXT);
  assert(first);
  const cleanup = t.mock.method(first, "cleanup");
  assert.equal(await factory(target, BACKGROUND_CONTEXT), first);
  const otherCwd = await factory({ ...target, cwd: "/other" }, BACKGROUND_CONTEXT);
  assert.notEqual(otherCwd, first);
  await harness.commit(async (tx) => {
    delete (await tx.doc(Env, root.id)).env;
  }, BACKGROUND_CONTEXT);
  assert.equal(await factory(target, BACKGROUND_CONTEXT), undefined);
  assert.equal(cleanup.mock.callCount(), 0);
  await app.close();
  assert.equal(cleanup.mock.callCount(), 1);
});

await test("application surfaces storage lookup failures and invalid document addresses", async (t) => {
  const { app, config } = await applicationFixture(t);
  const signal = new AbortController().signal;
  await assert.rejects(
    app.api.watch({ externalId: "../unsafe", conversationId: 1 as ConversationId }, signal),
  );
  const sessions = join(config.stateDirectory, "sessions");
  await mkdir(join(sessions, "directory.sqlite"));
  await symlink("loop.sqlite", join(sessions, "loop.sqlite"));
  const missing = await app.api.graphql(
    { source: '{ harness(externalId:"directory") { id } }' },
    signal,
  );
  assert.equal(missing.errors, undefined);
  assert.equal(missing.data?.harness, null);
  const failed = await app.api.graphql({ source: '{ harness(externalId:"loop") { id } }' }, signal);
  assert.equal(failed.errors?.[0]?.extensions.code, "INTERNAL_SERVER_ERROR");
  await app.api.graphql(
    { source: 'mutation { open(input:{externalId:"documents"}) { harness { id } } }' },
    signal,
  );
  const docs = await app.api.graphql(
    {
      source:
        '{ harness(externalId:"documents") { documentDefinitions(scope:{kind:session}) { kind } snapshot(address:{kind:"absent",scope:{kind:session}}) } }',
    },
    signal,
  );
  assert.equal(docs.errors, undefined);
  const data = docs.data?.harness as { documentDefinitions: unknown[]; snapshot: unknown };
  assert.deepEqual(data.documentDefinitions, []);
  assert.equal(data.snapshot, null);
});

await test("application releases every owner when shutdown fails", async (t) => {
  const { app } = await applicationFixture(t);
  const original = t.mock.method(DatabaseSync.prototype, "close");
  const close = t.mock.method(DatabaseSync.prototype, "close", function (this: DatabaseSync) {
    original.call(this);
    throw new Error("close failed");
  });
  const first = app.close();
  assert.equal(app.close(), first);
  await assert.rejects(first, AggregateError);
  assert.equal(close.mock.callCount(), 2);
});

await test("application closes accounts when push startup fails", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "application-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = readDeploymentConfiguration(
    {
      XDG_STATE_HOME: directory,
      VAPID_PRIVATE_KEY_FILE: join(directory, "absent"),
      VAPID_SUBJECT: "mailto:a@b.example",
      PUSH_ORIGINS: '["https://push.example"]',
    },
    1000,
    directory,
  );
  const close = t.mock.method(DatabaseSync.prototype, "close");
  await assert.rejects(openApplication(config));
  assert.equal(close.mock.callCount(), 1);
});

await test("application aggregates Harness and SSH cleanup failures", async (t) => {
  const { app } = await applicationFixture(t);
  const opened = t.mock.method(Harness, "open");
  await app.api.graphql(
    { source: 'mutation { open(input:{externalId:"closing"}) { harness { id } } }' },
    new AbortController().signal,
  );
  const call = opened.mock.calls[0]!;
  const harness = await call.result;
  assert(harness);
  const root = await harness.root(BACKGROUND_CONTEXT);
  await harness.commit(async (tx) => {
    (await tx.doc(Env, root.id)).env = {
      type: "ssh",
      host: "guest",
      knownHostsFile: "/known-hosts",
      hostKeyAlias: "guest",
    };
  }, BACKGROUND_CONTEXT);
  const env = await call.arguments[1].env?.(
    { conversationId: root.id, read: harness },
    BACKGROUND_CONTEXT,
  );
  assert(env);
  const cleanup = env.cleanup.bind(env);
  t.mock.method(env, "cleanup", async () => {
    await cleanup(BACKGROUND_CONTEXT);
    throw new Error("SSH cleanup failed");
  });
  const close = harness.close.bind(harness);
  t.mock.method(harness, "close", async () => {
    await close(BACKGROUND_CONTEXT);
    throw new Error("Harness close failed");
  });
  await assert.rejects(app.close(), (error: unknown) => {
    assert(error instanceof AggregateError);
    assert.equal(error.errors.length, 2);
    return true;
  });
});
