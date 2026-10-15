import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export default function notifyExtension(pi: ExtensionAPI): void {
  let enabled = true;

  pi.registerCommand("notify", {
    description: "Toggle desktop notifications, or set on|off",
    handler: async (args, ctx) => {
      const value = args.trim();
      if (value !== "" && value !== "on" && value !== "off") {
        ctx.ui.notify("Usage: /notify [on|off]", "warning");
        return;
      }
      enabled = value === "" ? !enabled : value === "on";
      ctx.ui.notify(`Notifications ${enabled ? "on" : "off"}`, "info");
    },
  });

  const notify = async (status: string, ctx: ExtensionContext): Promise<void> => {
    if (!enabled) return;

    // Notification bodies support markup; the working directory is literal text.
    try {
      const result = await pi.exec(
        "notify-send",
        ["--app-name", "pi-notify", "--", "Pi", `${status}\n${ctx.cwd}`],
        { timeout: 5000 },
      );
      if (result.code !== 0 || result.killed) {
        throw new Error(`notify-send failed (exit ${result.code}, killed: ${result.killed})`);
      }
    } catch (error) {
      ctx.ui.notify(
        `pi-notify: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }
  };

  // agent_end can precede automatic retries, compaction, and queued continuations.
  pi.on("agent_settled", (_, ctx) => notify("Ready for input", ctx));
  pi.on("ui_prompt_start", (_, ctx) => notify("Waiting for your response", ctx));
}
