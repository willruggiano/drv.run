export type StreamEvent =
  | { kind: "frame"; payload: unknown }
  | { kind: "disconnected" | "stream-failed"; payload: null };
export type StreamSource = {
  listen(message: (data: string) => void, error: (terminal: boolean) => void): void;
  close(): void;
};
export type StreamRuntime = {
  open(url: string): StreamSource;
  now(): number;
  random(): number;
  schedule(callback: () => void, delay: number): () => void;
};

const browser: StreamRuntime = {
  open(url) {
    const source = new EventSource(url);
    return {
      listen(message, error) {
        source.onmessage = (event) => message(event.data);
        source.onerror = () => error(source.readyState === EventSource.CLOSED);
      },
      close: () => source.close(),
    };
  },
  now: () => performance.now(),
  random: () => Math.random(),
  schedule(callback, delay) {
    const timer = setTimeout(callback, delay);
    return () => clearTimeout(timer);
  },
};

/** One subscription owns its source and every retry until stopped or terminally failed. */
export function openStream(
  url: string,
  receive: (event: StreamEvent) => void,
  runtime: StreamRuntime = browser,
): () => void {
  let current: StreamSource | undefined;
  let cancelRetry: (() => void) | undefined;
  let retryWindow = 250;
  let stopped = false;
  function connect() {
    if (stopped) return;
    const connection = runtime.open(url);
    current = connection;
    let receivedAt: number | undefined;
    connection.listen(
      (data) => {
        if (connection !== current) return;
        receivedAt ??= runtime.now();
        let payload: unknown;
        try {
          payload = JSON.parse(data);
        } catch {
          payload = null;
        }
        receive({ kind: "frame", payload });
      },
      (terminal) => {
        if (connection !== current) return;
        current = undefined;
        // Cancel the browser's retry timer; only this subscription schedules retries.
        connection.close();
        if (terminal) {
          stopped = true;
          receive({ kind: "stream-failed", payload: null });
          return;
        }
        receive({ kind: "disconnected", payload: null });
        if (stopped) return;
        // Opening, or receiving a snapshot then immediately closing, is not recovery.
        if (receivedAt !== undefined && runtime.now() - receivedAt >= 30_000) retryWindow = 250;
        // Equal jitter: [125, 250) ms initially, doubling up to [15, 30) seconds.
        const delay = retryWindow * (0.5 + runtime.random() * 0.5);
        retryWindow = Math.min(retryWindow * 2, 30_000);
        cancelRetry = runtime.schedule(connect, delay);
      },
    );
  }
  connect();
  return () => {
    stopped = true;
    cancelRetry?.();
    const closing = current;
    current = undefined;
    closing?.close();
  };
}
