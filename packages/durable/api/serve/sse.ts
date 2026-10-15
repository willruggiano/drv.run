export function sse(events: ReadableStream<unknown>): Response {
  const encoder = new TextEncoder();
  const body = events.pipeThrough(
    new TransformStream<unknown, Uint8Array>({
      transform(event, controller) {
        const json = JSON.stringify(event);
        if (json === undefined) throw new TypeError("SSE data is not JSON-serializable");
        controller.enqueue(encoder.encode(`data: ${json}\n\n`));
      },
    }),
  );
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
