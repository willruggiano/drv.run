import type { Context } from "@earendil-works/chord/context";
import {
  Harness,
  createRegistry,
  defineExtension,
  section,
  type HarnessOptions,
  type HarnessSettings,
  type Storage,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { createContextExtension } from "./context.ts";
import { createWebExtension } from "./web.ts";

export { DrvRunEnv } from "./drv-run.ts";

type Options = Omit<HarnessOptions, "registry" | "settings"> & {
  readonly settings?: Omit<HarnessSettings, "extensions">;
};

export async function openHarness(
  storage: Storage,
  options: Options,
  context: Context,
): Promise<Harness> {
  const registry = createRegistry();
  registry.install(CodingTools);
  registry.install(
    defineExtension({
      name: "coding",
      sections: [
        section("pre", () => "You are Pi, a coding agent.", { tag: false }),
        section("cwd", (input) => input.env?.cwd),
      ],
    }),
  );
  registry.install(createContextExtension());
  registry.install(createWebExtension());
  const extensions = registry.snapshot().installed();
  const harness = await Harness.open(
    storage,
    {
      ...options,
      registry,
      get settings() {
        return { ...options.settings, extensions };
      },
    },
    context,
  );
  return harness;
}
