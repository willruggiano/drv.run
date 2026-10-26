export const frontendRoot = location.pathname.startsWith("/elm") ? "/elm" : "/htmx";
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
}
let installPrompt: InstallPromptEvent | undefined;
let registration: ServiceWorkerRegistration | undefined;
let updateRequested = false;
export function installStatus() {
  const install = document.querySelector<HTMLButtonElement>("#install");
  if (install) install.hidden = !installPrompt;
  const update = document.querySelector<HTMLButtonElement>("#update");
  if (update) update.hidden = !registration?.waiting;
}

export function installPwa() {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installPrompt = event as InstallPromptEvent;
    installStatus();
  });
  document.addEventListener("click", (event) => {
    if (!(event.target instanceof HTMLButtonElement)) return;
    if (event.target.id === "install")
      void installPrompt?.prompt().finally(() => {
        installPrompt = undefined;
        installStatus();
      });
    if (event.target.id === "update") {
      updateRequested = true;
      registration?.waiting?.postMessage("activate");
    }
  });
  if ("serviceWorker" in navigator) {
    void registerWorker()
      .then((worker) => {
        registration = worker;
        worker.addEventListener("updatefound", () =>
          worker.installing?.addEventListener("statechange", installStatus),
        );
        installStatus();
        // Activation may race a navigation; claim the now-loaded document.
        void navigator.serviceWorker.ready.then((ready) => ready.active?.postMessage("claim"));
      })
      .catch(() => {
        /* Offline first visits still render the supplied document. */
      });
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (updateRequested) location.reload();
    });
  }
}

let worker: Promise<ServiceWorkerRegistration> | undefined;
export function registerWorker(): Promise<ServiceWorkerRegistration> {
  if (!("serviceWorker" in navigator))
    return Promise.reject(new Error("Service workers are unavailable."));
  worker ??= register();
  return worker;
}
function register(): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.getRegistrations().then(async (workers) => {
    // Retire the obsolete root-scoped worker without touching the other frontend.
    // Unregistering afterward could also remove its pending replacement.
    await Promise.all(
      workers
        .filter((item) =>
          [item.active, item.waiting, item.installing].some(
            (worker) =>
              worker &&
              (new URL(worker.scriptURL).pathname === "/sw.js" ||
                (new URL(worker.scriptURL).pathname === "/htmx/sw.js" &&
                  new URL(item.scope).pathname === "/") ||
                (new URL(worker.scriptURL).pathname === `${frontendRoot}/sw.js` &&
                  new URL(item.scope).pathname !== frontendRoot)),
          ),
        )
        .map((item) => item.unregister()),
    );
    return navigator.serviceWorker.register(`${frontendRoot}/sw.js`, { scope: frontendRoot });
  });
}
export async function activityPost(path: string, value: unknown): Promise<void> {
  const response = await fetch(`${frontendRoot}/activity/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
  if (!response.ok) throw new Error(`Request failed (${response.status}).`);
}
export async function enablePush(enabled: boolean, publicKey: string | null): Promise<string> {
  if (!("PushManager" in window)) throw new Error("Web Push is unavailable in this browser.");
  if (enabled && !publicKey) throw new Error("Push is disabled by host policy.");
  if (
    enabled &&
    (!("Notification" in window) || (await Notification.requestPermission()) !== "granted")
  )
    throw new Error("Notification permission was not granted.");
  const registration = await registerWorker();
  if (!registration.active)
    await new Promise<void>((resolve, reject) => {
      const worker = registration.installing ?? registration.waiting;
      if (!worker) {
        reject(new Error("Service worker did not install."));
        return;
      }
      worker.addEventListener("statechange", () => {
        if (worker.state === "activated") resolve();
        if (worker.state === "redundant") reject(new Error("Service worker installation failed."));
      });
    });
  let subscription = await registration.pushManager.getSubscription();
  const key = publicKey
    ? Uint8Array.from(atob(publicKey.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))
    : undefined;
  const previous = subscription?.options.applicationServerKey;
  if (
    subscription &&
    (!enabled ||
      !previous ||
      !key ||
      new Uint8Array(previous).length !== key.length ||
      !new Uint8Array(previous).every((byte, index) => byte === key[index]))
  ) {
    await activityPost("unsubscribe", { endpoint: subscription.endpoint });
    await subscription.unsubscribe();
    subscription = null;
  }
  if (enabled) {
    subscription ??= await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: key,
    });
    await activityPost("subscribe", subscription.toJSON());
  }
  return enabled ? "Push enabled on this device." : "Push disabled on this device.";
}
export const localPreferences = {
  "wrap-code": { key: "pi.html.wrap-code", fallback: false },
  "bottom-align": { key: "pi.bottomAlign", fallback: true },
} as const;
export function restorePreferences() {
  try {
    for (const [name, { key, fallback }] of Object.entries(localPreferences)) {
      const stored = localStorage.getItem(key);
      const enabled = stored === null ? fallback : stored === "true";
      document.body.classList.toggle(name, enabled);
      const select = document.querySelector<HTMLSelectElement>(`[data-preference="${name}"]`);
      if (select) select.value = String(enabled);
    }
  } catch {
    /* Optional browser preferences. */
  }
}
export function installPreferences() {
  restorePreferences();
  document.addEventListener("change", (event) => {
    if (!(event.target instanceof HTMLSelectElement)) return;
    const preference = event.target.dataset.preference;
    if (preference !== "wrap-code" && preference !== "bottom-align") return;
    const value = event.target.value;
    document.body.classList.toggle(preference, value === "true");
    try {
      localStorage.setItem(localPreferences[preference].key, value);
    } catch {
      /* Optional browser preferences. */
    }
  });
}
