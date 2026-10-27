import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

type Empty = Record<string, never>;
type Commands = {
  "Target.createTarget": [{ url: string }, { targetId: string }];
  "Target.attachToTarget": [{ targetId: string; flatten: true }, { sessionId: string }];
  "Browser.close": [Empty, Empty];
  "Browser.getVersion": [
    Empty,
    { product: string; protocolVersion: string; userAgent: string; jsVersion: string },
  ];
  "Page.enable": [Empty, Empty];
  "Runtime.enable": [Empty, Empty];
  "Network.enable": [Empty, Empty];
  "Network.setCacheDisabled": [{ cacheDisabled: boolean }, Empty];
  "Network.setBypassServiceWorker": [{ bypass: boolean }, Empty];
  "Fetch.enable": [{ patterns: { urlPattern: string }[] }, Empty];
  "Fetch.continueRequest": [{ requestId: string }, Empty];
  "Fetch.failRequest": [{ requestId: string; errorReason: "BlockedByClient" }, Empty];
  "Page.addScriptToEvaluateOnNewDocument": [{ source: string }, { identifier: string }];
  "Page.navigate": [{ url: string }, { errorText?: string }];
  "Page.captureScreenshot": [{ format: "png"; captureBeyondViewport: false }, { data: string }];
  "Runtime.evaluate": [
    { expression: string; awaitPromise: true; returnByValue: true },
    { result: { value?: unknown }; exceptionDetails?: unknown },
  ];
  "Emulation.setDeviceMetricsOverride": [
    { width: number; height: number; deviceScaleFactor: number; mobile: boolean },
    Empty,
  ];
  "Emulation.setTouchEmulationEnabled": [{ enabled: boolean }, Empty];
  "Emulation.setSafeAreaInsetsOverride": [
    { insets: { top: number; bottom: number; left: number; right: number } },
    Empty,
  ];
  "Emulation.setLocaleOverride": [{ locale: string }, Empty];
  "Emulation.setTimezoneOverride": [{ timezoneId: string }, Empty];
  "Emulation.setEmulatedMedia": [{ features: { name: string; value: string }[] }, Empty];
  "Input.dispatchMouseEvent": [
    {
      type: "mousePressed" | "mouseReleased" | "mouseMoved";
      x: number;
      y: number;
      button?: "left";
      clickCount?: number;
    },
    Empty,
  ];
  "Input.dispatchTouchEvent": [
    { type: "touchStart" | "touchEnd"; touchPoints: { x: number; y: number }[] },
    Empty,
  ];
  "Input.dispatchKeyEvent": [
    { type: "keyDown" | "keyUp"; key: string; code: string; windowsVirtualKeyCode: number },
    Empty,
  ];
  "Input.insertText": [{ text: string }, Empty];
};
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout };

export class CDP {
  private nextID = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<
    (method: string, params: unknown, session?: string) => void
  >();
  private closed = false;
  private readonly socket: WebSocket;
  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      try {
        assert(typeof event.data === "string");
        const message: unknown = JSON.parse(event.data);
        assert(record(message));
        if (typeof message.id === "number") {
          const pending = this.pending.get(message.id);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pending.delete(message.id);
          if (message.error) pending.reject(new Error(`CDP: ${JSON.stringify(message.error)}`));
          else pending.resolve(message.result);
        } else if (typeof message.method === "string") {
          for (const listener of this.listeners)
            listener(
              message.method,
              message.params,
              typeof message.sessionId === "string" ? message.sessionId : undefined,
            );
        }
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.addEventListener("error", () => this.fail(new Error("CDP socket failed")));
    socket.addEventListener("close", () => this.fail(new Error("CDP socket closed")));
  }
  static async connect(url: string): Promise<CDP> {
    const socket = new WebSocket(url);
    const cdp = new CDP(socket);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cdp.close();
        reject(new Error("CDP connection timed out"));
      }, 10_000);
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("CDP connection failed"));
        },
        { once: true },
      );
    });
    return cdp;
  }
  private fail(error: Error) {
    this.closed = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
  on(listener: (method: string, params: unknown, session?: string) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async send<M extends keyof Commands>(
    method: M,
    params: Commands[M][0],
    sessionId?: string,
  ): Promise<Commands[M][1]> {
    assert(!this.closed, "CDP is closed");
    const id = ++this.nextID;
    const response = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 10_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({ id, method, params, sessionId }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
    // The only protocol cast: Chromium is the typed RPC peer. App/tape data is
    // independently validated; no untrusted artifact can issue protocol calls.
    return response as Commands[M][1];
  }
  close() {
    this.fail(new Error("CDP closed by caller"));
    this.socket.close();
  }
}

async function terminate(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}
export async function launch(directory: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const child = spawn(
    process.env.CHROMIUM_BINARY ?? "chromium",
    [
      "--headless=new",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      `--user-data-dir=${directory}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--disable-extensions",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      // Repaint full tiles: incremental rasterization changes retained DOM edge pixels.
      "--disable-partial-raster",
      "--font-render-hinting=none",
      "--force-color-profile=srgb",
      // Root cannot use Chromium's sandbox. Non-root runs retain it.
      ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let cdp: CDP | undefined;
  const abort = () => {
    cdp?.close();
    child.kill("SIGTERM");
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    const url = await new Promise<string>((resolve, reject) => {
      let stderr = "";
      const timer = setTimeout(
        () => reject(new Error(`Chromium startup timeout: ${stderr}`)),
        10_000,
      );
      const finish = (error?: Error, url?: string) => {
        clearTimeout(timer);
        if (error) reject(error);
        else if (url) resolve(url);
      };
      child.once("error", (error) => finish(error));
      child.once("exit", () => finish(new Error(`Chromium exited: ${stderr}`)));
      child.stderr!.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-8192);
        const url = /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr)?.[1];
        if (url) finish(undefined, url);
      });
    });
    cdp = await CDP.connect(url);
    signal.throwIfAborted();
    return {
      cdp,
      async close() {
        signal.removeEventListener("abort", abort);
        // Let Chromium flush and stop its child processes before removing the profile.
        await cdp!.send("Browser.close", {}).catch(() => undefined);
        cdp!.close();
        await terminate(child);
      },
    };
  } catch (error) {
    signal.removeEventListener("abort", abort);
    cdp?.close();
    if (child.pid) await terminate(child);
    throw error;
  }
}

export class Page {
  readonly cdp: CDP;
  readonly session: string;
  readonly signal: AbortSignal;
  constructor(cdp: CDP, session: string, signal: AbortSignal) {
    this.cdp = cdp;
    this.session = session;
    this.signal = signal;
  }
  static async create(cdp: CDP, signal: AbortSignal) {
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    return new Page(cdp, sessionId, signal);
  }
  send<M extends keyof Commands>(method: M, params: Commands[M][0]) {
    this.signal.throwIfAborted();
    return this.cdp.send(method, params, this.session);
  }
  async evaluate(expression: string): Promise<unknown> {
    const value = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    assert(
      !value.exceptionDetails,
      `Browser evaluation failed: ${JSON.stringify(value.exceptionDetails)}`,
    );
    return value.result.value;
  }
  async wait(expression: string, description: string) {
    const until = Date.now() + 10_000;
    while (Date.now() < until) {
      if (await this.evaluate(expression)) return;
      await delay(25, undefined, { signal: this.signal });
    }
    throw new Error(`Browser readiness timeout: ${description}`);
  }
}
