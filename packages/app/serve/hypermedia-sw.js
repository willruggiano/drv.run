// Cache only public assets and a static offline page, never session HTML or SSE.
const CACHE = "pi-hypermedia-shell-v1";
const SHELL = ["/sessions/offline", "/sessions/manifest.webmanifest", "/styles.css", "/hypermedia.css", "/hypermedia-client.js", "/htmx.js", "/highlight.js", "/icon.svg", "/icon-192.png", "/icon-512.png"];
self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
});
self.addEventListener("activate", event => {
  event.waitUntil(Promise.all([
    caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith("pi-hypermedia-shell-") && key !== CACHE).map(key => caches.delete(key)))),
    self.clients.claim(),
  ]));
});
self.addEventListener("message", event => {
  if (event.data === "activate") self.skipWaiting();
  if (event.data === "claim") event.waitUntil(self.clients.claim());
});
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  const navigation = event.request.mode === "navigate" && (url.pathname === "/sessions" || url.pathname.startsWith("/sessions/"));
  if (!navigation && !SHELL.includes(url.pathname)) return;
  event.respondWith(fetch(event.request).catch(async () => {
    const cached = await caches.match(navigation ? "/sessions/offline" : url.pathname);
    return cached ?? Response.error();
  }));
});
