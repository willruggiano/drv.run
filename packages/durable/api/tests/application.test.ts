import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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
      query: `{
        harnesses { externalId }
        accounts(limit: 10) { nodes { id } pageInfo { next } }
        authorizationServers(limit: 10) { nodes { id } pageInfo { next } }
        push { applicationServerKey }
        web: settings(app: web) {
          __typename
          ... on WebSettings { revision wrapCode bottomAlign }
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
    web: { revision: string; wrapCode: boolean; bottomAlign: boolean };
    missing: unknown;
  };
  assert.deepEqual(queryData.harnesses, []);
  assert.deepEqual(queryData.accounts.nodes, []);
  assert.deepEqual(queryData.authorizationServers.nodes, []);
  assert.equal(queryData.authorizationServers.pageInfo.next, null);
  assert.equal(queryData.push.applicationServerKey, null);
  assert.equal(queryData.web.wrapCode, false);
  assert.equal(queryData.web.bottomAlign, true);
  assert.equal(queryData.web.revision.length > 0, true);
  assert.equal(queryData.missing, null);
  const saved = await app.api.graphql(
    {
      query: `mutation Save($input: SaveSettingsInput!) {
        saveSettings(input: $input) { ... on WebSettings { revision wrapCode } }
      }`,
      variables: {
        input: {
          web: {
            expectedRevision: queryData.web.revision,
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
      query: `mutation {
        registerPushSubscription(input: {
          endpoint: "https://push.invalid/subscription",
          keys: { auth: "auth", p256dh: "key" }
        })
      }`,
    },
    signal,
  );
  assert.equal(unavailable.errors?.[0]?.extensions.code, "INTERNAL_SERVER_ERROR");
  const unavailableRemoval = await app.api.graphql(
    {
      query: `mutation {
        removePushSubscription(input: { endpoint: "https://push.invalid/subscription" })
      }`,
    },
    signal,
  );
  assert.equal(unavailableRemoval.errors?.[0]?.extensions.code, "INTERNAL_SERVER_ERROR");
  const opened = await app.api.graphql(
    {
      query: `mutation { open(input: { externalId: "test_session" }) { harness { externalId } } }`,
    },
    signal,
  );
  assert.equal(opened.errors, undefined);
  const openedData = opened.data as {
    open: { harness: { externalId: string } };
  };
  assert.equal(openedData.open.harness.externalId, "test_session");
  assert.equal(
    (
      await stat(join(directory, "instance-state/drv.run/harness/sessions/test_session.sqlite"))
    ).isFile(),
    true,
  );
  const listed = await app.api.graphql({ query: "{ harnesses { externalId } }" }, signal);
  assert.equal(listed.errors, undefined);
  const listedData = listed.data as { harnesses: { externalId: string }[] };
  assert.equal(listedData.harnesses[0]?.externalId, "test_session");
  await app.close();

  const reopened = await openApplication(config);
  t.after(async () => reopened.close());
  const persisted = await reopened.api.graphql({ query: "{ harnesses { externalId } }" }, signal);
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
    { query: `mutation { open(input: { externalId: "recover" }) { harness { id } } }` },
    signal,
  );
  assert.equal(failed.errors?.[0]?.extensions.code, "INTERNAL_SERVER_ERROR");
  await writeFile(harnessSettings, "{}");
  const recovered = await app.api.graphql(
    { query: `mutation { open(input: { externalId: "recover" }) { harness { externalId } } }` },
    signal,
  );
  assert.equal(recovered.errors, undefined);
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
    { query: `mutation { open(input: { externalId: "../unsafe" }) { harness { id } } }` },
    new AbortController().signal,
  );
  assert.equal(result.errors?.[0]?.extensions.code, "BAD_REQUEST");
});
