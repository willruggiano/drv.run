import { isAbsolute, join } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import { RemoteExecutionEnv, sshConnection } from "@earendil-works/pi-env";

/** One environment owns one lazy SSH connection. Cleanup closes both. */
export class DrvRunEnv extends RemoteExecutionEnv {
  constructor(options: {
    instance: string;
    runtimeDirectory: string;
    cwd: string;
    ssh?: string;
    connect?: typeof sshConnection;
  }) {
    if (!/^[a-zA-Z0-9]+$/.test(options.instance)) throw new TypeError("Invalid drv.run instance.");
    if (!isAbsolute(options.cwd) || !isAbsolute(options.runtimeDirectory))
      throw new TypeError("Expected absolute guest and runtime directories.");
    const host = `drv.run.${options.instance}`;
    const runtime = join(options.runtimeDirectory, host);
    const { connection } = (options.connect ?? sshConnection)({
      host,
      user: "root",
      ssh: options.ssh ?? "ssh",
      configFile: "/etc/ssh/ssh_config",
      identityFile: join(runtime, "client-key"),
      knownHostsFile: join(runtime, "known_hosts"),
      hostKeyAlias: host,
    });
    super({ connection, id: host, cwd: options.cwd });
  }

  override async cleanup(context: Context): Promise<void> {
    try {
      await super.cleanup(context);
    } finally {
      this.connection.close();
    }
  }
}
