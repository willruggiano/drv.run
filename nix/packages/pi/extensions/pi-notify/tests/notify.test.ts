import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";

import extension from "../index.ts";

type Notice = { message: string; level?: "info" | "warning" | "error" };
type Context = {
  cwd: string;
  ui: { notify(message: string, level?: Notice["level"]): void };
};
type Handler = (event: unknown, ctx: Context) => void | Promise<void>;
type Command = { handler(args: string, ctx: Context): Promise<void> };

function harness() {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, Command>();
  const calls: { command: string; args: string[]; options?: ExecOptions }[] = [];
  const notices: Notice[] = [];
  const context: Context = {
    cwd: "/workspace/project",
    ui: {
      notify(message, level) {
        notices.push({ message, level });
      },
    },
  };
  let result: ExecResult | Error = {
    code: 0,
    killed: false,
    stdout: "",
    stderr: "",
  };
  const pi = {
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
    },
    registerCommand(name: string, command: Command) {
      commands.set(name, command);
    },
    async exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult> {
      calls.push({ command, args, options });
      if (result instanceof Error) throw result;
      return result;
    },
  };
  extension(pi as unknown as Parameters<typeof extension>[0]);
  return {
    calls,
    commands,
    context,
    handlers,
    notices,
    async command(args: string) {
      const command = commands.get("notify");
      assert.ok(command);
      await command.handler(args, context);
    },
    async emit(name: string, event: unknown = { type: name }) {
      await handlers.get(name)?.(event, context);
    },
    setResult(next: ExecResult | Error) {
      result = next;
    },
  };
}

void describe("pi-notify extension", async () => {
  await test("registers one command and only the two notification boundaries; startup is silent", async () => {
    const h = harness();
    assert.deepEqual([...h.commands.keys()], ["notify"]);
    assert.deepEqual([...h.handlers.keys()], ["agent_settled", "ui_prompt_start"]);
    await h.emit("session_start");
    await h.emit("agent_end");
    await h.emit("ui_prompt_end");
    assert.equal(h.calls.length, 0);
  });

  await test("enabled by default; submits status and cwd as arguments with a process timeout", async () => {
    const h = harness();
    await h.emit("agent_settled");
    await h.emit("ui_prompt_start", {
      type: "ui_prompt_start",
      kind: "custom",
    });
    assert.deepEqual(h.calls, [
      {
        command: "notify-send",
        args: ["--app-name", "pi-notify", "--", "Pi", "Ready for input\n/workspace/project"],
        options: { timeout: 5000 },
      },
      {
        command: "notify-send",
        args: [
          "--app-name",
          "pi-notify",
          "--",
          "Pi",
          "Waiting for your response\n/workspace/project",
        ],
        options: { timeout: 5000 },
      },
    ]);
    assert.equal(h.notices.length, 0);
  });

  await test("on/off are idempotent; omitted arguments toggle both notification types", async () => {
    const h = harness();
    for (const args of ["off", "off"]) {
      await h.command(args);
      await h.emit("agent_settled");
      await h.emit("ui_prompt_start");
    }
    assert.equal(h.calls.length, 0);
    for (const args of ["on", "on"]) {
      await h.command(args);
      await h.emit("agent_settled");
      await h.emit("ui_prompt_start");
    }
    assert.equal(h.calls.length, 4);
    await h.command("");
    await h.emit("agent_settled");
    await h.emit("ui_prompt_start");
    assert.equal(h.calls.length, 4);
    await h.command("   ");
    await h.emit("agent_settled");
    await h.emit("ui_prompt_start");
    assert.equal(h.calls.length, 6);
    assert.equal(h.notices.length, 6);
    assert.ok(h.notices.every((notice) => notice.level === "info"));
  });

  await test("invalid arguments preserve either state; surrounding whitespace is accepted", async () => {
    const h = harness();
    for (const enabled of [false, true]) {
      await h.command(enabled ? " on \n" : "\toff ");
      const before = h.calls.length;
      for (const args of ["ON", "toggle", "on off", "off extra"]) {
        await h.command(args);
        assert.equal(h.notices.at(-1)?.level, "warning");
        await h.emit("agent_settled");
      }
      assert.equal(h.calls.length - before, enabled ? 4 : 0);
    }
  });

  await test("state is isolated to each runtime and is not persisted", async () => {
    const first = harness();
    await first.command("off");
    const second = harness();
    await first.emit("agent_settled");
    await second.emit("agent_settled");
    assert.equal(first.calls.length, 0);
    assert.equal(second.calls.length, 1);
  });

  await test("execution failures warn without rejecting the event or disabling future notifications", async () => {
    const failures: (ExecResult | Error)[] = [
      { code: 1, killed: false, stdout: "", stderr: "" },
      { code: 0, killed: true, stdout: "", stderr: "" },
      new Error("spawn failed"),
    ];
    for (const failure of failures) {
      const h = harness();
      h.setResult(failure);
      await assert.doesNotReject(() => h.emit("agent_settled"));
      assert.equal(h.notices.length, 1);
      assert.equal(h.notices[0]?.level, "warning");
      h.setResult({ code: 0, killed: false, stdout: "", stderr: "" });
      await h.emit("ui_prompt_start");
      assert.equal(h.calls.length, 2);
      assert.equal(h.notices.length, 1);
    }
  });
});
