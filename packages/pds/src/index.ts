import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { hostAuth } from "./auth.ts";
import { discoverEnvironments, openApplication } from "./application.ts";
import { serve } from "./server.ts";

const directory = resolve(
  process.env.PDS_STATE_DIR ??
    join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "drv.run/pds"),
);
await mkdir(directory, { recursive: true, mode: 0o700 });
const auth = hostAuth();
const { models } = auth;
await models.refresh();
const app = await openApplication({
  directory,
  models,
  cwd: process.cwd(),
  environments: () => discoverEnvironments(process.env.PDS_DRV_RUN),
  ...(process.env.PARALLEL_API_KEY_FILE
    ? { parallelApiKeyFile: process.env.PARALLEL_API_KEY_FILE }
    : {}),
});
try {
  const server = await serve(app, {
    auth,
    port: Number(process.env.PORT ?? 8082),
    host: process.env.HOST ?? "127.0.0.1",
    ...(process.env.ORIGIN ? { origin: process.env.ORIGIN } : {}),
  });
  console.log(`pds: ${server.origin}`);
  await new Promise<void>((fulfill) => {
    process.once("SIGINT", () => fulfill());
    process.once("SIGTERM", () => fulfill());
  });
  await server.close();
} finally {
  await auth.close();
  await app.close();
}
