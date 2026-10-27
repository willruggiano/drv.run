// Cache only public assets, never pages or SSE.
const ROOT = new URL(self.registration.scope).pathname.replace(/\/$/, "");
const CACHE = `pi-${ROOT.slice(1)}-shell-v8`;
const SHELL = [`${ROOT}/manifest.webmanifest`, "/styles.css", "/icon-192.png", "/icon-512.png", "/highlight.js", ...(ROOT === "/elm" ? ["/elm/main.js", "/elm/site.js", "/elm/client.js"] : ["/htmx/client.js", "/htmx/vendor.js", "/htmx/morph.js", "/htmx/sse.js"])];
self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
});
self.addEventListener("activate", event => {
  event.waitUntil(Promise.all([
    caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith("pi-shell-") || key.startsWith("pi-hypermedia-shell-") || (key.startsWith(`pi-${ROOT.slice(1)}-shell-`) && key !== CACHE)).map(key => caches.delete(key)))),
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
  if (!SHELL.includes(url.pathname)) return;
  event.respondWith(fetch(event.request).catch(async () => {
    const cached = await caches.match(url.pathname);
    return cached ?? Response.error();
  }));
});
// Destinations are host-generated identities, not links supplied by message text.
function destination(value) {
  if (typeof value === "string" && value.startsWith(ROOT + "/")) value = value.slice(ROOT.length);
  return typeof value === "string" && /^\/sessions\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/conversations\/[1-9][0-9]*$/.test(value)
    ? ROOT + value : ROOT + "/sessions";
}
function text(value, fallback, limit) {
  return typeof value === "string" && value.trim() ? value.slice(0, limit) : fallback;
}
function icon(value) {
  return typeof value === "string" && /^\/icon(?:-(?:192|512)\.png|\.svg)$/.test(value) ? value : "/icon-192.png";
}
self.addEventListener("push", event => {
  let message;
  try { message = event.data?.json(); } catch { return; }
  if (!message || !Number.isSafeInteger(message.activity) || message.activity < 1) return;
  const url = destination(message.url);
  event.waitUntil(self.registration.showNotification(text(message.title, "drv.run activity", 256), {
    body: text(message.body, "An application has an update. Open drv.run to view it.", 4096),
    icon: icon(message.icon), badge: icon(message.badge),
    tag: text(message.tag, `drv-run-${message.activity}`, 256),
    timestamp: Number.isSafeInteger(message.timestamp) && message.timestamp >= 0 ? message.timestamp : Date.now(),
    dir: ["auto", "ltr", "rtl"].includes(message.dir) ? message.dir : "auto",
    lang: text(message.lang, "", 64),
    silent: message.silent === true,
    renotify: message.renotify === true,
    requireInteraction: message.requireInteraction === true,
    actions: [{ action: "open", title: text(message.action, url === ROOT + "/sessions" ? "Open sessions" : "Open conversation", 128) }],
    data: { activity: message.activity, url },
  }));
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const url = destination(event.notification.data?.url);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find(client => client.url === new URL(url, self.location.origin).href);
    if (existing) await existing.focus();
    else await self.clients.openWindow(url);
  })());
});
