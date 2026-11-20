import type * as C from "@earendil-works/chord/context";
import { defineDoc } from "@earendil-works/pi-durable";
import { RemoteExecutionEnv, sshArguments, sshConnection } from "@earendil-works/pi-env";
import type * as E from "@earendil-works/pi-env";

export type EnvTarget = { type: "local" } | ({ type: "ssh" } & Omit<E.SshTarget, "ssh">);

export const Env = defineDoc<{ env?: EnvTarget }>({
  kind: "app.env",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({}),
  checkpointWhen: () => true,
});

/** One lazy SSH connection. The application owns cleanup, not document writes. */
export class SshExecutionEnv extends RemoteExecutionEnv {
  constructor(options: {
    target: Omit<E.SshTarget, "ssh">;
    cwd: string;
    connect?: typeof sshConnection;
  }) {
    // Project explicitly: executable/daemon options must not enter through extra properties.
    const { host, user, port, identityFile, knownHostsFile, hostKeyAlias, configFile } =
      options.target;
    const target = {
      host,
      knownHostsFile,
      hostKeyAlias,
      ...(user === undefined ? {} : { user }),
      ...(port === undefined ? {} : { port }),
      ...(identityFile === undefined ? {} : { identityFile }),
      ...(configFile === undefined ? {} : { configFile }),
    };
    const args = sshArguments(target);
    const { connection } = (options.connect ?? sshConnection)(target);
    // A stable file namespace across cwd changes; distinct SSH routes stay separate.
    super({ connection, id: JSON.stringify(args), cwd: options.cwd });
  }

  override async cleanup(context: C.Context): Promise<void> {
    try {
      await super.cleanup(context);
    } finally {
      // RemoteExecutionEnv.cleanup only kills commands; this owner also closes SSH.
      this.connection.close();
    }
  }
}
