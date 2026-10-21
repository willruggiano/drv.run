import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry, defineExtension, section } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { createContextExtension } from "./context.ts";
import { AskExtension, ReviewExtension, Workflows } from "./workflows.ts";
import { Environment, Sessions, type SessionOptions } from "./index.ts";

const context = BACKGROUND_CONTEXT;

/** Standard application configuration. Sessions itself has no coding dependencies. */
export async function openCodingSessions(options: Omit<SessionOptions, "open">): Promise<Sessions> {
  return Sessions.open({
    ...options,
    async open(storage) {
      const registry = createRegistry();
      registry.install(CodingTools);
      registry.install(
        defineExtension({
          name: "coding",
          sections: [
            section(
              "preamble",
              () =>
                "You are Pi, a coding agent. Follow the supplied context files in order: system, user, then repository documentation; more-specific guidance takes precedence on conflicts. Use edit/write for file mutations. CONTRIBUTING.md is supplied before mutations when present. Never claim an operation succeeded without checking its result.",
              { tag: false },
            ),
            section("cwd", (input) => input.env?.cwd),
            section("execution", async (input, context) => {
              const selected = await input.read.snapshot(
                Environment,
                input.conversationId,
                context,
              );
              return selected?.provider === "drv.run" && input.env
                ? `File and command tools run in the selected drv.run guest, in ${input.env.cwd}.`
                : undefined;
            }),
          ],
        }),
      );
      registry.install(
        createContextExtension(async (id, context) => {
          const conversation = await harness.conversation(id, context);
          assert(conversation, "Context conversation must exist.");
          return conversation;
        }),
      );
      registry.install(AskExtension);
      const defaults = registry.snapshot().installed();
      registry.install(ReviewExtension);
      const harness = await Harness.open(
        storage,
        {
          models: options.models,
          registry,
          get settings() {
            return { ...options.settings, extensions: options.settings?.extensions ?? defaults };
          },
          env: options.env,
          onReport: options.onReport,
          async conversationCreated(tx, conversation) {
            if (conversation.parent) return;
            await tx.doc(Workflows, conversation.id);
            const selected = await tx.doc(Environment, conversation.id);
            if (conversation.owner)
              Object.assign(selected, await tx.doc(Environment, conversation.owner.conversationId));
          },
        },
        context,
      );
      return harness;
    },
  });
}
