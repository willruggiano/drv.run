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
import {
  createCodemodeExtension,
  type CodemodeToolOptions,
} from "@earendil-works/pi-durable/codemode";
import { createConversationExtension } from "./conversations.ts";
import { createContextExtension } from "./context.ts";
import { createWebExtension } from "./web.ts";
import { createReviewExtension } from "./review.ts";

export { Review } from "./review.ts";
export { DrvRunEnv } from "./drv-run.ts";

type Options = Omit<HarnessOptions, "registry" | "settings"> & {
  readonly settings?: Omit<HarnessSettings, "extensions">;
  /** Opt-in prototype. The caller owns the sandbox and closes it after the harness. */
  readonly codemode?: CodemodeToolOptions["sandbox"];
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
  registry.install(createReviewExtension(options.env));
  let harness: Harness;
  if (options.codemode) {
    const codemode = { sandbox: options.codemode, models: false };
    registry.install(createCodemodeExtension(codemode));
    registry.install(createConversationExtension(() => harness, codemode));
  }
  const extensions = registry.snapshot().installed();
  harness = await Harness.open(
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
