// Cache only public assets and a static offline page, never session HTML or SSE.
const CACHE = "pi-hypermedia-shell-v4";
const SHELL = ["/sessions/offline", "/sessions/manifest.webmanifest", "/styles.css", "/htmx/client.js", "/htmx/vendor.js", "/htmx/sse.js", "/htmx/morph.js", "/highlight.js", "/icon.svg", "/icon-192.png", "/icon-512.png"];
self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
});
self.addEventListener("activate", event => {
  event.waitUntil(Promise.all([
    caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith("pi-shell-") || (key.startsWith("pi-hypermedia-shell-") && key !== CACHE)).map(key => caches.delete(key)))),
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
self.addEventListener("push", event => {
  let activity;
  try { activity = event.data?.json()?.activity; } catch { return; }
  if (!Number.isSafeInteger(activity) || activity < 1) return;
  event.waitUntil(self.registration.showNotification("drv.run activity", {
    body: "An application has an update. Open your activity inbox.",
    icon: "/icon-192.png", tag: `drv-run-${activity}`, data: { activity },
  }));
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const activity = event.notification.data?.activity;
  if (!Number.isSafeInteger(activity) || activity < 1) return;
  // Fixed same-origin route: no URL or approval action comes from the producer.
  event.waitUntil(self.clients.openWindow(`/activity#activity-${activity}`));
});
