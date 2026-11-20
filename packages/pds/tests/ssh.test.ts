import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  connectSsh,
  HostKeyChangedError,
  HostKeyUnknownError,
  RemoteError,
  SshError,
} from "@earendil-works/pi-env";
import { Env, SshExecutionEnv } from "../src/harness/index.ts";
import { context, discoverEnvironments } from "../src/application.ts";
import { sessionsFixture, inventoryFixture, form } from "./fixtures.ts";

const execute = promisify(execFile);

await test(
  "host-only PDS execution uses native OpenSSH configuration",
  { timeout: 60_000 },
  async (t) => {
    const library = process.env.NSS_WRAPPER_LIBRARY;
    assert(library, "Run in nix develop: the SSH fixture requires NSS_WRAPPER_LIBRARY");
    const { uid, gid } = userInfo();
    const bash = await realpath((await execute("sh", ["-c", "command -v bash"])).stdout.trim());
    const sshd = await realpath((await execute("sh", ["-c", "command -v sshd"])).stdout.trim());
    const directory = await mkdtemp(join(tmpdir(), "pds-ssh-"));
    const client = join(directory, "client");
    const remote = join(directory, "remote");
    const passwd = join(directory, "passwd");
    const serverPasswd = join(directory, "server-passwd");
    const group = join(directory, "group");
    const serverConfig = join(directory, "sshd_config");
    const prompt = join(directory, "prompted");
    const askpass = join(directory, "askpass");
    const serverEnv = {
      ...process.env,
      LD_PRELOAD: library,
      NSS_WRAPPER_PASSWD: serverPasswd,
      NSS_WRAPPER_GROUP: group,
    };
    const children = new Set<ReturnType<typeof spawn>>();
    const exits: Promise<unknown>[] = [];
    const server = createServer((socket) => {
      // inetd mode accepts the connected socket directly, without a privileged listener.
      const child = spawn(sshd, ["-i", "-e", "-f", serverConfig], {
        env: serverEnv,
        stdio: [socket, socket, "inherit"],
      });
      children.add(child);
      exits.push(once(child, "close"));
      child.once("close", () => {
        children.delete(child);
        socket.destroy();
      });
    });
    const overrides = {
      HOME: client,
      LD_PRELOAD: library,
      NSS_WRAPPER_PASSWD: passwd,
      NSS_WRAPPER_GROUP: group,
      SSH_ASKPASS: askpass,
      SSH_ASKPASS_REQUIRE: "force",
      DISPLAY: ":fixture",
    };
    const previous = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
    t.after(async () => {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      for (const child of children) child.kill("SIGKILL");
      await Promise.all(exits);
      if (server.listening) {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
      await rm(directory, { recursive: true, force: true });
    });
    await mkdir(join(client, ".ssh"), { recursive: true, mode: 0o700 });
    await mkdir(remote, { mode: 0o700 });
    await writeFile(passwd, `client:x:${uid}:${gid}::${client}:${bash}\n`);
    await writeFile(
      serverPasswd,
      `remote:x:${uid}:${gid}::${remote}:${bash}\nsshd:x:65534:65534::/var/empty:/bin/false\n`,
    );
    await writeFile(group, `fixture:x:${gid}:\nsshd:x:65534:\n`);
    for (const name of ["identity", "host", "wrong", "locked"]) {
      await execute("ssh-keygen", [
        "-q",
        "-t",
        "ed25519",
        "-N",
        name === "locked" ? "fixture" : "",
        "-f",
        join(directory, name),
      ]);
    }
    await writeFile(
      join(remote, "authorized_keys"),
      Buffer.concat(
        await Promise.all(
          ["identity.pub", "locked.pub"].map((name) => readFile(join(directory, name))),
        ),
      ),
      { mode: 0o600 },
    );
    await writeFile(
      serverConfig,
      `
HostKey ${directory}/host
AuthorizedKeysFile ${remote}/authorized_keys
UsePAM no
StrictModes yes
PermitRootLogin yes
PasswordAuthentication no
KbdInteractiveAuthentication no
AllowUsers remote
DisableForwarding yes
SetEnv PATH=${process.env.PATH}
`,
    );
    const listening = once(server, "listening");
    server.listen(0, "127.0.0.1");
    await listening;
    const address = server.address();
    assert(address && typeof address !== "string");
    const key = await readFile(join(directory, "host.pub"), "utf8");
    const wrongKey = await readFile(join(directory, "wrong.pub"), "utf8");
    await writeFile(join(directory, "user_hosts"), `[127.0.0.1]:${address.port} ${key}`);
    await writeFile(join(directory, "global_hosts"), `configured-alias ${key}`);
    await writeFile(join(directory, "changed_hosts"), `configured-alias ${wrongKey}`);
    await writeFile(join(directory, "unknown_hosts"), "");
    await writeFile(join(client, ".ssh/config"), "Include hosts.conf\n");
    await writeFile(
      join(client, ".ssh/hosts.conf"),
      `
Host user-trust locked-identity
    UserKnownHostsFile ${directory}/user_hosts
    GlobalKnownHostsFile none
Host global-trust
    UserKnownHostsFile none
    GlobalKnownHostsFile ${directory}/global_hosts
Host unknown
    UserKnownHostsFile ${directory}/unknown_hosts
    GlobalKnownHostsFile none
Host changed
    UserKnownHostsFile ${directory}/changed_hosts
    GlobalKnownHostsFile none
Host global-trust unknown changed
    HostKeyAlias configured-alias
Host locked-identity
    IdentityFile ${directory}/locked
Host user-trust global-trust unknown changed
    IdentityFile ${directory}/identity
Host *
    HostName 127.0.0.1
    Port ${address.port}
    User remote
    IdentitiesOnly yes
    IdentityAgent none
    StrictHostKeyChecking no
    BatchMode no
`,
    );
    await writeFile(askpass, `#!${bash}\ntouch ${prompt}\nexit 1\n`, { mode: 0o700 });
    Object.assign(process.env, overrides);

    for (const host of ["user-trust", "global-trust"]) {
      await t.test(
        `${host}: configured route, user, identity and trust reach the packaged daemon`,
        async (subtest) => {
          const env = new SshExecutionEnv({ target: { host }, cwd: remote });
          subtest.after(() => env.cleanup(context));
          const result = await env.exec(["touch", host], {}, context);
          assert(result.ok, result.ok ? undefined : result.error);
          assert.equal(result.value.exitCode, 0);
          assert.equal((await env.connection.info()).home, remote);
          assert.deepEqual(await readFile(join(remote, host)), Buffer.alloc(0));
          assert(children.size > 0);
          await env.cleanup(context);
          await Promise.all(exits);
          assert.equal(children.size, 0);
        },
      );
    }

    await t.test("empty trust overrides defer to native OpenSSH configuration", async (subtest) => {
      const { connection } = await connectSsh({
        host: "global-trust",
        knownHostsFile: "",
        hostKeyAlias: "",
      });
      subtest.after(() => connection.close());
      assert.equal((await connection.info()).home, remote);
      connection.close();
      await Promise.all(exits);
      assert.equal(children.size, 0);
    });

    for (const host of ["unknown", "changed"]) {
      await t.test(
        `${host}: strict verification overrides permissive config without prompts or execution`,
        async (subtest) => {
          const path = join(directory, `${host}_hosts`);
          const before = await readFile(path);
          await assert.rejects(
            connectSsh({ host }),
            host === "unknown" ? HostKeyUnknownError : HostKeyChangedError,
          );
          const env = new SshExecutionEnv({ target: { host }, cwd: remote });
          subtest.after(() => env.cleanup(context));
          await assert.rejects(
            env.connection.info(),
            (error: unknown) => error instanceof RemoteError && error.code === "spawn_error",
          );
          assert.equal((await env.exec(["touch", host], {}, context)).ok, false);
          await assert.rejects(readFile(join(remote, host)), { code: "ENOENT" });
          assert.deepEqual(await readFile(path), before);
          await assert.rejects(readFile(prompt), { code: "ENOENT" });
        },
      );
    }

    await t.test(
      "encrypted identities fail noninteractively even when config permits prompts",
      async () => {
        await assert.rejects(
          connectSsh({ host: "locked-identity" }),
          (error: unknown) => error instanceof SshError && error.exitCode === 255,
        );
        await assert.rejects(readFile(prompt), { code: "ENOENT" });
      },
    );

    await t.test(
      "relative SSH cwd and /cd resolve on the selected host, not the PDS filesystem",
      async (subtest) => {
        const { sessions, selection } = await sessionsFixture(subtest);
        const session = await sessions.open();
        const conversation = await session.createConversation(
          form({ ...selection, env: "ssh:global-trust", cwd: "." }),
        );
        assert.equal((await conversation.agent(context)).cwd, ".");
        await session.send(conversation, form({ message: "/cd ." }));
        assert.equal((await conversation.agent(context)).cwd, remote);
        await session.send(conversation, form({ message: "/cd ~/nested directory" }));
        assert.equal((await conversation.agent(context)).cwd, join(remote, "nested directory"));
        assert.equal((await conversation.context(context)).entries.length, 0);
      },
    );

    await t.test(
      "inventory changes do not control saved or manual local and SSH execution",
      async (subtest) => {
        const inventory = await inventoryFixture(subtest);
        const ready = { ...inventory.instance, host: "global-trust" };
        const { sessions, faux, selection, open } = await sessionsFixture(subtest, () =>
          discoverEnvironments(inventory.command),
        );
        let application = sessions;
        const { sessionId, conversation } = await application.compose(
          form({ ...selection, env: "ssh:global-trust", cwd: "." }),
        );
        const states = {
          ready: [ready],
          stopped: [{ ...ready, ready: false, activeState: "inactive", subState: "dead" }],
          restarted: [ready],
          missing: [],
          remapped: [{ ...ready, host: "unknown" }],
          failed: null,
        };
        for (const [name, instances] of Object.entries(states)) {
          await inventory.respond(JSON.stringify({ version: 1, instances }), instances ? 0 : 7);
          if (instances) await application.environments();
          else await assert.rejects(application.environments(), { code: 7 });
          await rm(inventory.invoked);
          await application.close();
          application = await open();
          const session = await application.get(sessionId);
          assert(session);
          const current = await session.conversation(conversation.id);
          assert(current);
          assert.deepEqual(await session.harness.snapshot(Env, current.id, context), {
            env: { type: "ssh", host: "global-trust" },
          });
          for (const env of ["ssh:global-trust", "local"]) {
            await session.configure(current, form({ env }));
            const local = env === "local";
            const marker = `inventory-${name}-${local ? "local" : "ssh"}`;
            faux.setResponses([
              fauxAssistantMessage(fauxToolCall("bash", { command: `touch ~/${marker}` }), {
                stopReason: "toolUse",
              }),
              fauxAssistantMessage("Done"),
            ]);
            await session.send(current, form({ message: "Run the command" }));
            await current.waitForIdle(context);
            assert.deepEqual(
              await readFile(join(local ? client : remote, marker)),
              Buffer.alloc(0),
            );
            await assert.rejects(readFile(join(local ? remote : client, marker)), {
              code: "ENOENT",
            });
            await assert.rejects(readFile(inventory.invoked), { code: "ENOENT" });
          }
          await session.configure(current, form({ env: "ssh:global-trust" }));
        }
        const session = await application.get(sessionId);
        assert(session);
        const current = await session.conversation(conversation.id);
        assert(current);
        await session.configure(current, form({ env: "ssh:unknown" }));
        await assert.rejects(session.send(current, form({ message: "/cd ." })), RemoteError);
        assert.deepEqual(await session.harness.snapshot(Env, current.id, context), {
          env: { type: "ssh", host: "unknown" },
        });
        assert.equal((await current.agent(context)).cwd, ".");
        await assert.rejects(readFile(inventory.invoked), { code: "ENOENT" });
        await application.close();
      },
    );

    await t.test(
      "application persists only the host, reacquires SSH after reopen, and closes owned connections",
      async (subtest) => {
        const { sessions, faux, selection, open } = await sessionsFixture(subtest);
        const { sessionId, conversation } = await sessions.compose(
          form({ ...selection, env: "ssh:global-trust", cwd: remote }),
        );
        const session = await sessions.get(sessionId);
        assert(session);
        assert.deepEqual(await session.harness.snapshot(Env, conversation.id, context), {
          env: { type: "ssh", host: "global-trust" },
        });
        await session.configure(conversation, form({ env: "ssh:global-trust" }));
        assert.deepEqual(await session.harness.snapshot(Env, conversation.id, context), {
          env: { type: "ssh", host: "global-trust" },
        });
        await sessions.close();
        const reopened = await open();
        const restored = await reopened.get(sessionId);
        assert(restored);
        const current = await restored.conversation(conversation.id);
        assert(current);
        faux.setResponses([
          fauxAssistantMessage(fauxToolCall("bash", { command: "touch from-harness" }), {
            stopReason: "toolUse",
          }),
          fauxAssistantMessage("Done"),
        ]);
        await restored.send(current, form({ message: "Run the command" }));
        await current.waitForIdle(context);
        assert.equal(faux.state.callCount, 2);
        assert.deepEqual(await readFile(join(remote, "from-harness")), Buffer.alloc(0));
        assert(children.size > 0);
        await reopened.close();
        await Promise.all(exits);
        assert.equal(children.size, 0);
      },
    );
  },
);
