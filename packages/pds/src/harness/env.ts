import type * as C from "@earendil-works/chord/context";
import { defineDoc } from "@earendil-works/pi-durable";
import { RemoteExecutionEnv, sshArguments, sshConnection } from "@earendil-works/pi-env";
import type * as E from "@earendil-works/pi-env";

export type EnvTarget = { type: "local" } | ({ type: "ssh" } & Pick<E.SshTarget, "host">);

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
    target: Pick<E.SshTarget, "host">;
    cwd: string;
    connect?: typeof sshConnection;
  }) {
    // Connection policy belongs to OpenSSH configuration, never application input.
    const target = { host: options.target.host };
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
