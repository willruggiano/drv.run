import { once } from "node:events";
import type { Duplex } from "node:stream";
import { object, observation, type Observation } from "./activity.ts";

export type NotificationEvent = Extract<
  Observation,
  { type: "notify" | "close" | "retire" | "gap" }
>;
export type Envelope = {
  v: 1;
  vm: string;
  server: string;
  operation: number;
  sequence: number;
  event: NotificationEvent;
};
export const frameLimit = 16384;
export function incarnation(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  )
    throw new TypeError("Invalid incarnation.");
  return value;
}
export function counter(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new TypeError("Invalid sequence.");
  return value;
}
export function envelope(input: unknown, vm: string): Envelope {
  const data = object(input);
  if (
    data.v !== 1 ||
    data.vm !== vm ||
    Object.keys(data).sort().join(",") !== "event,operation,sequence,server,v,vm"
  )
    throw new TypeError("Invalid notification envelope.");
  const event = observation(data.event);
  if (
    event.type !== "notify" &&
    event.type !== "close" &&
    event.type !== "retire" &&
    event.type !== "gap"
  )
    throw new TypeError("Guest ingress accepts notification lifecycle events only.");
  return {
    v: 1,
    vm,
    server: incarnation(data.server),
    operation: counter(data.operation),
    sequence: counter(data.sequence),
    event,
  };
}
/** JSON Lines, bounded before decoding. One unacknowledged operation per stream. */
export async function* frames(stream: Duplex): AsyncGenerator<unknown> {
  let buffered = Buffer.alloc(0);
  for await (const chunk of stream) {
    if (!Buffer.isBuffer(chunk)) throw new TypeError("Expected bytes.");
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf(10, start);
      const part = chunk.subarray(start, end < 0 ? chunk.length : end);
      if (buffered.length + part.length > frameLimit)
        throw new Error("Notification frame exceeds limit.");
      buffered = Buffer.concat([buffered, part]);
      if (end < 0) break;
      yield JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffered)) as unknown;
      buffered = Buffer.alloc(0);
      start = end + 1;
    }
  }
  if (buffered.length) throw new Error("Truncated notification frame.");
}
export async function sendFrame(stream: Duplex, value: unknown): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  if (bytes.length > frameLimit + 1) throw new Error("Notification frame exceeds limit.");
  if (stream.destroyed || stream.writableEnded) throw new Error("Notification transport closed.");
  if (!stream.write(bytes)) {
    const abort = new AbortController();
    const closed = () => abort.abort();
    stream.once("close", closed);
    try {
      await once(stream, "drain", { signal: abort.signal });
    } finally {
      stream.off("close", closed);
    }
  }
}
