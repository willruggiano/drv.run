import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function website(
  directory: string | undefined,
): Promise<(request: Request) => Response> {
  const assets = new Map<string, { body: Uint8Array<ArrayBuffer>; type: string }>();
  if (directory !== undefined) {
    for (const [path, file, type] of [
      ["/", "index.html", "text/html; charset=utf-8"],
      ["/main.js", "main.js", "text/javascript; charset=utf-8"],
      ["/bootstrap.js", "bootstrap.js", "text/javascript; charset=utf-8"],
      ["/styles.css", "styles.css", "text/css; charset=utf-8"],
    ] as const) {
      assets.set(path, { body: new Uint8Array(await readFile(join(directory, file))), type });
    }
  }
  return (request) => {
    const path = new URL(request.url).pathname;
    const document =
      request.headers
        .get("accept")
        ?.split(",")
        .some((type) => type.trim().split(";")[0] === "text/html") &&
      path !== "/api" &&
      !path.startsWith("/api/");
    const asset = assets.get(path) ?? (document ? assets.get("/") : undefined);
    if (!asset) return new Response(null, { status: 404 });
    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
    return new Response(request.method === "HEAD" ? null : asset.body, {
      headers: {
        "Content-Type": asset.type,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy":
          "default-src 'none'; script-src 'self'; style-src 'self'; img-src data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      },
    });
  };
}
