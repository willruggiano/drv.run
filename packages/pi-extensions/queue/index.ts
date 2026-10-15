import {
  CustomEditor,
  InteractiveMode,
  type ExtensionAPI,
  type ExtensionContext,
  type InputEvent,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { Container, TruncatedText, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

type DeliveryMode = "steer" | "followUp";
type QueueBoundary = "turn" | "settled" | "compacted";
type QueuedAction =
  | {
      kind: "compact";
      mode: DeliveryMode;
      instructions?: string;
    }
  | {
      kind: "message";
      mode: DeliveryMode;
      text: string;
      images?: InputEvent["images"];
    };

type CompactCommand = { instructions?: string };
type DequeuedActions = { texts: string[]; dequeueNative: boolean };

const WIDGET_KEY = "queued-compact";

function parseCompactCommand(text: string): CompactCommand | undefined {
  const match = /^\/compact(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return undefined;

  const instructions = match[1]?.trim();
  return instructions ? { instructions } : {};
}

function actionText(action: QueuedAction): string {
  if (action.kind === "message") return action.text;
  return action.instructions ? `/compact ${action.instructions}` : "/compact";
}

class QueuedCompactEditor extends CustomEditor {
  readonly #keybindings: KeybindingsManager;
  readonly #dequeue: () => DequeuedActions;
  readonly #enqueue: (text: string, mode: DeliveryMode) => boolean;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    enqueue: (text: string, mode: DeliveryMode) => boolean,
    dequeue: () => DequeuedActions,
  ) {
    super(tui, theme, keybindings, { embedWorkingStatus: true });
    this.#keybindings = keybindings;
    this.#dequeue = dequeue;
    this.#enqueue = enqueue;
  }

  override handleInput(data: string): void {
    if (this.#keybindings.matches(data, "app.message.dequeue")) {
      const restored = this.#dequeue();
      if (restored.texts.length > 0) {
        const queuedText = restored.texts.join("\n\n");
        const currentText = this.getText();
        this.setText([queuedText, currentText].filter((text) => text.trim()).join("\n\n"));
        if (restored.dequeueNative) {
          this.actionHandlers.get("app.message.dequeue")?.();
        }
        return;
      }
    }

    const mode = this.#keybindings.matches(data, "app.message.followUp")
      ? "followUp"
      : this.#keybindings.matches(data, "tui.input.submit")
        ? "steer"
        : undefined;

    if (mode) {
      const text = this.getExpandedText().trim();
      if (text && this.#enqueue(text, mode)) {
        this.addToHistory(text);
        this.setText("");
        return;
      }
    }

    super.handleInput(data);
  }
}

export default function queuedCompactExtension(pi: ExtensionAPI): void {
  const queue: QueuedAction[] = [];
  let compacting = false;
  let dequeueKeys = "";
  let disposed = false;

  const syncQueueWidget = (ctx: ExtensionContext): void => {
    if (ctx.mode !== "tui") return;
    if (queue.length === 0) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }

    const pending = [...queue];
    ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => {
      const container = new Container();
      for (const action of pending) {
        const label = action.mode === "followUp" ? "Follow-up" : "Steering";
        container.addChild(
          new TruncatedText(theme.fg("dim", `${label}: ${actionText(action)}`), 1, 0),
        );
      }
      container.addChild(
        new TruncatedText(theme.fg("dim", `↳ ${dequeueKeys} to edit all queued messages`), 1, 0),
      );
      return container;
    });
  };

  const enqueue = (
    text: string,
    mode: DeliveryMode,
    ctx: ExtensionContext,
    images?: InputEvent["images"],
  ): boolean => {
    const compact = parseCompactCommand(text);
    const pipelineActive = compacting || queue.length > 0;

    if (compact && !pipelineActive && ctx.isIdle()) return false;
    if (!compact && !pipelineActive) return false;
    if (!compact && text.startsWith("/")) return false;

    if (compact) {
      queue.push({ kind: "compact", mode, instructions: compact.instructions });
    } else {
      queue.push({ kind: "message", mode, text, images });
    }

    syncQueueWidget(ctx);
    return true;
  };

  const pump = (ctx: ExtensionContext, boundary: QueueBoundary): void => {
    if (disposed || compacting || queue.length === 0) return;

    const next = queue[0];
    if (boundary === "turn" && next.mode !== "steer") return;

    queue.shift();
    syncQueueWidget(ctx);

    if (next.kind === "message") {
      const content = next.images?.length
        ? [{ type: "text" as const, text: next.text }, ...next.images]
        : next.text;
      pi.sendUserMessage(content, {
        deliverAs: boundary === "turn" ? "steer" : undefined,
        expandPromptTemplates: true,
      });
      return;
    }

    compacting = true;
    ctx.compact({
      customInstructions: next.instructions,
      onComplete: () => {
        if (disposed) return;
        compacting = false;
        syncQueueWidget(ctx);
        pump(ctx, "compacted");
      },
      onError: () => {
        if (disposed) return;
        compacting = false;
        syncQueueWidget(ctx);
        pump(ctx, "compacted");
      },
    });
  };

  pi.on("session_start", (_event, ctx) => {
    disposed = false;
    if (ctx.mode !== "tui") return;

    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      // @ts-expect-error: Internal Pi method used to match built-in key formatting.
      dequeueKeys = InteractiveMode.prototype.getAppKeyDisplay("app.message.dequeue");
      return new QueuedCompactEditor(
        tui,
        theme,
        keybindings,
        (text, mode) => enqueue(text, mode, ctx),
        () => {
          const texts = queue.map(actionText);
          queue.length = 0;
          syncQueueWidget(ctx);
          return { texts, dequeueNative: ctx.hasPendingMessages() };
        },
      );
    });
  });

  pi.on("input", (event, ctx) => {
    if (event.source === "extension" || !event.streamingBehavior) {
      return { action: "continue" };
    }

    return enqueue(event.text, event.streamingBehavior, ctx, event.images)
      ? { action: "handled" }
      : { action: "continue" };
  });

  pi.on("turn_end", (_event, ctx) => {
    pump(ctx, "turn");
  });

  pi.on("agent_settled", (_event, ctx) => {
    pump(ctx, "settled");
  });

  pi.on("session_shutdown", (_event, ctx) => {
    disposed = true;
    queue.length = 0;
    compacting = false;
    if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET_KEY, undefined);
  });
}
