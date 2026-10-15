import { join } from "node:path";
import { test } from "node:test";
import { remoteFixture } from "../packages/pi-extensions/drv-run/tests/fixture.ts";
import { browserFlow } from "../packages/pi-serve/testing.ts";

await test("mobile browser uses the optional drv.run integration and reconnects", async (t) => {
  const f = await remoteFixture(t);
  // The daemon runs locally in this test. The NixOS test exercises real guest /workspace.
  await browserFlow(t, { ...f, filePath: join(f.workspace, "browser.json") });
});
