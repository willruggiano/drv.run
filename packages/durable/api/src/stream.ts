import type { ServerResponse } from "node:http";
import type { ConversationWatch } from "@earendil-works/pi-durable";

export async function stream(response: ServerResponse, watch: ConversationWatch): Promise<void> {
  const stop = () => {
    void watch.stop();
  };
  response.once("close", stop);
  try {
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
    const send = (value: unknown) =>
      new Promise<void>((resolve, reject) => {
        response.write(`data: ${JSON.stringify({ type: "snapshot", value })}\n\n`, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    await send(watch.value);
    let pending = Promise.resolve();
    watch.start((value) => {
      pending = send(value);
      return pending;
    });
    const end = await watch.closed;
    await pending;
    response.end(`data: ${JSON.stringify({ type: "end", value: end })}\n\n`);
  } finally {
    response.off("close", stop);
    await watch.stop();
  }
}
