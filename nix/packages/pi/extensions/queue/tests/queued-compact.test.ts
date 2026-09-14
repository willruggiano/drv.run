import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { getKeybindings, setKeybindings } from "@earendil-works/pi-tui";

import ext from "../index.ts";

type ActionHandler = () => void;
type Keybindings = {
  matches(data: string, binding: string): boolean;
  getKeys(binding: string): string[];
};
type TestEditor = {
  readonly actionHandlers: Map<string, ActionHandler>;
  onSubmit?: (text: string) => void;
  getText(): string;
  handleInput(data: string): void;
  setText(text: string): void;
};
type TestTheme = {
  borderColor(text: string): string;
  fg(color: string, text: string): string;
};
type TestWidget = {
  render(width: number): string[];
};
type EditorFactory = (tui: unknown, theme: TestTheme, keybindings: Keybindings) => TestEditor;
type WidgetFactory = (tui: unknown, theme: TestTheme) => TestWidget;
type CompactOptions = {
  onComplete(): void;
  onError(error: Error): void;
};
type Notification = { message: string; level: string };
type TestContext = {
  mode: "tui";
  hasUI: true;
  isIdle(): boolean;
  hasPendingMessages(): boolean;
  compact(options: CompactOptions): void;
  ui: {
    setEditorComponent(factory: EditorFactory): void;
    setWidget(key: string, content: WidgetFactory | undefined): void;
    notify(message: string, level: string): void;
  };
};
type Handler = (event: unknown, context: TestContext) => unknown;

function harness() {
  const handlers = new Map<string, Handler>();
  const widgetChanges: Array<WidgetFactory | undefined> = [];
  const notifications: Notification[] = [];
  const sentUserMessages: unknown[] = [];
  const submitted: string[] = [];
  let compactOptions: CompactOptions | undefined;
  let editorFactory: EditorFactory | undefined;
  let widget: WidgetFactory | undefined;
  let idle = true;
  let nativePending = false;

  const pi = {
    on(name: string, handler: Handler): void {
      handlers.set(name, handler);
    },
    sendUserMessage(content: unknown): void {
      sentUserMessages.push(content);
    },
  };
  ext(pi as unknown as Parameters<typeof ext>[0]);

  const context: TestContext = {
    mode: "tui",
    hasUI: true,
    isIdle: () => idle,
    hasPendingMessages: () => nativePending,
    compact(options) {
      compactOptions = options;
    },
    ui: {
      setEditorComponent(factory) {
        editorFactory = factory;
      },
      setWidget(_key, content) {
        widget = content;
        widgetChanges.push(content);
      },
      notify(message, level) {
        notifications.push({ message, level });
      },
    },
  };

  handlers.get("session_start")?.({}, context);
  if (!editorFactory) throw new Error("Extension did not register an editor");

  const tui = { requestRender() {} };
  const theme: TestTheme = {
    borderColor: (text) => text,
    fg: (_color, text) => text,
  };
  const keybindings: Keybindings = {
    matches(data, binding) {
      return (
        (data === "alt+enter" && binding === "app.message.followUp") ||
        (data === "\r" && binding === "tui.input.submit") ||
        (data === "alt+up" && binding === "app.message.dequeue")
      );
    },
    getKeys: (binding) => (binding === "app.message.dequeue" ? ["alt+up"] : []),
  };
  const previousKeybindings = getKeybindings();
  setKeybindings(keybindings as Parameters<typeof setKeybindings>[0]);
  const editor = editorFactory(tui, theme, keybindings);
  setKeybindings(previousKeybindings);
  editor.onSubmit = (text) => submitted.push(text);

  return {
    editor,
    failCompaction(error: Error) {
      if (!compactOptions) throw new Error("Compaction was not started");
      notifications.push({ message: `Compaction failed: ${error.message}`, level: "error" });
      compactOptions.onError(error);
    },
    notifications,
    sentUserMessages,
    settle() {
      handlers.get("agent_settled")?.({}, context);
    },
    setIdle(value: boolean) {
      idle = value;
    },
    setNativePending(value: boolean) {
      nativePending = value;
    },
    submitted,
    widgetChanges,
    widgetLines() {
      return (
        widget?.(tui, theme)
          .render(120)
          .map((line) => line.trimEnd()) ?? []
      );
    },
  };
}

function submit(editor: TestEditor, text: string, key = "alt+enter"): void {
  editor.setText(text);
  editor.handleInput(key);
}

void describe("queued compact extension", async () => {
  await test("passes idle compact commands to Pi", () => {
    const instance = harness();
    submit(instance.editor, "/compact", "\r");
    assert.deepEqual(instance.submitted, ["/compact"]);
    assert.deepEqual(instance.widgetChanges, []);
  });

  await test("renders every queued action and removes the widget after dequeue", () => {
    const instance = harness();
    instance.setIdle(false);
    submit(instance.editor, "/compact");
    submit(instance.editor, "check tests");
    submit(instance.editor, "/compact focus on failures");
    submit(instance.editor, "summarize");

    assert.deepEqual(instance.widgetLines(), [
      " Follow-up: /compact",
      " Follow-up: check tests",
      " Follow-up: /compact focus on failures",
      " Follow-up: summarize",
      ` ↳ ${process.platform === "darwin" ? "Option" : "Alt"}+Up to edit all queued messages`,
    ]);

    instance.editor.setText("draft");
    instance.editor.handleInput("alt+up");
    assert.equal(
      instance.editor.getText(),
      "/compact\n\ncheck tests\n\n/compact focus on failures\n\nsummarize\n\ndraft",
    );
    assert.equal(instance.widgetChanges.at(-1), undefined);
  });

  await test("prepends native queued messages before extension actions", () => {
    const instance = harness();
    instance.setIdle(false);
    submit(instance.editor, "/compact");
    submit(instance.editor, "after compact");
    instance.setNativePending(true);
    instance.editor.actionHandlers.set("app.message.dequeue", () => {
      instance.editor.setText(`native message\n\n${instance.editor.getText()}`);
    });

    instance.editor.handleInput("alt+up");
    assert.equal(instance.editor.getText(), "native message\n\n/compact\n\nafter compact");
  });

  await test("reports failed queued compactions once and continues the queue", () => {
    const instance = harness();
    instance.setIdle(false);
    submit(instance.editor, "/compact");
    submit(instance.editor, "after compact");

    instance.settle();
    instance.failCompaction(new Error("Nothing to compact (session too small)"));

    assert.deepEqual(instance.notifications, [
      {
        message: "Compaction failed: Nothing to compact (session too small)",
        level: "error",
      },
    ]);
    assert.deepEqual(instance.sentUserMessages, ["after compact"]);
    assert.equal(instance.widgetChanges.at(-1), undefined);
  });
});
