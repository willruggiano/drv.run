import { mkdir, writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { Connection, localDaemon, type SshConnectOptions } from "@earendil-works/pi-env";
import { tmpdir } from "node:os";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { openApplication, type ApplicationOptions } from "../../pi-serve/application.ts";
import { listInstances } from "../index.ts";

/** Real inventory files and daemon; only systemd state and the SSH transport are substituted. */
export async function remoteFixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "pi-remote-state-"));
  const workspace = await mkdtemp(join(tmpdir(), "pi-remote-work-"));
  const faux = fauxProvider({ models: [{ id: "faux-1", reasoning: true }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const f = { directory, workspace };
  const runtimeDirectory = join(f.directory, "runtime");
  const calls = join(f.directory, "systemctl-calls.jsonl");
  const states = join(f.directory, "states.json");
  const systemctl = join(f.directory, "systemctl");
  await writeFile(states, JSON.stringify({ test1: "active" }));
  await writeFile(
    systemctl,
    `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n");
const id = process.argv[4].slice("drv.run@".length, -".service".length);
process.stdout.write(JSON.parse(readFileSync(${JSON.stringify(states)}, "utf8"))[id] ?? "inactive");
`,
    { mode: 0o700 },
  );
  async function instance(id: string, reference: string | undefined, ready = true) {
    const path = join(f.directory, "drv.run", id);
    await mkdir(path, { recursive: true });
    if (reference !== undefined) await writeFile(join(path, "reference"), reference);
    if (ready) {
      const runtime = join(runtimeDirectory, `drv.run.${id}`);
      await mkdir(runtime, { recursive: true });
      await writeFile(join(runtime, "client.conf"), "");
    }
  }
  await instance("test1", "path:/test");
  const connections: Connection[] = [];
  const sshOptions: SshConnectOptions[] = [];
  const options = {
    stateDirectory: f.directory,
    runtimeDirectory,
    systemctl,
    connect(options: SshConnectOptions) {
      sshOptions.push(options);
      const connection = new Connection({ command: [localDaemon()] });
      connections.push(connection);
      return { connection, remote: () => undefined };
    },
  };
  const application = { directory, models, cwd: workspace, local: false, drvRun: options };
  let sessions = await openApplication(application);
  t.after(async () => {
    await sessions.close();
    for (const connection of connections) connection.close();
    await rm(directory, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  });
  return {
    directory,
    workspace,
    faux,
    get sessions() {
      return sessions;
    },
    binding: { provider: "drv.run", target: "test1", cwd: "/workspace" },
    options,
    instance,
    calls,
    states,
    connections,
    sshOptions,
    async reopen(overrides: Partial<ApplicationOptions> = {}) {
      await sessions.close();
      sessions = await openApplication({ ...application, ...overrides });
    },
    targets: async () =>
      (await listInstances(options)).map((instance) => ({
        provider: "drv.run",
        target: instance.id,
        cwd: "/workspace",
        directoryRoot: workspace,
        label: instance.reference,
        available: instance.running,
      })),
  };
}
