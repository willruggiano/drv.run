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
async function pushPost(path: string, value: unknown): Promise<void> {
  const response = await fetch(`${frontendRoot}/settings/push/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
  if (!response.ok) throw new Error(`Request failed (${response.status}).`);
}
async function enablePush(enabled: boolean, publicKey: string | null): Promise<string> {
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
    await pushPost("unsubscribe", { endpoint: subscription.endpoint });
    await subscription.unsubscribe();
    subscription = null;
  }
  if (enabled) {
    subscription ??= await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: key,
    });
    await pushPost("subscribe", subscription.toJSON());
  }
  return enabled ? "Push enabled on this device." : "Push disabled on this device.";
}
// Both frontends leave this element's controls and device-local state to the browser.
class PushSettings extends HTMLElement {
  private enabled: boolean | undefined;
  private busy = false;
  private initialized = false;
  private message = "";
  private error = "";
  private supported =
    "PushManager" in window && "Notification" in window && "serviceWorker" in navigator;
  private off = document.createElement("input");
  private on = document.createElement("input");
  private retry = document.createElement("button");
  private status = document.createElement("p");
  private alert = document.createElement("p");

  connectedCallback() {
    if (this.initialized) return;
    this.initialized = true;
    const section = document.createElement("section");
    section.className = "settings-group";
    section.setAttribute("aria-labelledby", "push-title");
    const heading = document.createElement("h2");
    heading.id = "push-title";
    heading.textContent = "Notifications";
    const row = document.createElement("div");
    row.className = "setting-row";
    const title = document.createElement("span");
    title.textContent = "Push on this device";
    const toggle = document.createElement("div");
    toggle.className = "setting-toggle";
    toggle.setAttribute("role", "radiogroup");
    toggle.setAttribute("aria-label", title.textContent);
    for (const [control, enabled] of [
      [this.off, false],
      [this.on, true],
    ] as const) {
      const label = document.createElement("label");
      label.className = "toggle-option";
      control.type = "radio";
      control.name = "device-push";
      control.value = String(enabled);
      control.id = enabled ? "push-on" : "push-off";
      control.addEventListener("change", () => {
        if (control.checked) void this.change(enabled);
      });
      const caption = document.createElement("span");
      caption.textContent = enabled ? "On" : "Off";
      label.append(control, caption);
      toggle.append(label);
    }
    row.append(title, toggle);
    this.retry.type = "button";
    this.retry.id = "check-push";
    this.retry.textContent = "Retry";
    this.status.id = "push-status";
    this.status.setAttribute("role", "status");
    this.alert.id = "push-error";
    this.alert.setAttribute("role", "alert");
    this.retry.addEventListener("click", () => void this.check());
    section.append(heading, row, this.status, this.alert, this.retry);
    this.replaceChildren(section);
    void this.check();
  }

  private render() {
    this.off.checked = this.enabled === false;
    this.on.checked = this.enabled === true;
    this.off.disabled = this.busy || !this.supported || this.enabled === undefined;
    this.on.disabled = this.off.disabled || !this.getAttribute("public-key");
    this.retry.hidden = this.busy || !this.supported || this.enabled !== undefined;
    this.status.textContent = this.busy ? "Updating push…" : this.message;
    this.alert.textContent = this.error;
    this.alert.hidden = !this.error;
    this.setAttribute("aria-busy", String(this.busy));
  }

  private async check() {
    this.busy = true;
    this.error = "";
    this.render();
    try {
      if (!this.supported) throw new Error("Web Push is unavailable in this browser.");
      const registration = await registerWorker();
      this.enabled = !!(await registration.pushManager.getSubscription());
      this.message = !this.getAttribute("public-key")
        ? "Push is disabled by host policy."
        : this.enabled
          ? "Push enabled on this device."
          : "Push disabled on this device.";
    } catch (error) {
      this.error = error instanceof Error ? error.message : "Could not check push subscription.";
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private async change(enabled: boolean) {
    if (this.busy) return;
    this.busy = true;
    this.error = "";
    this.render();
    try {
      this.message = await enablePush(enabled, this.getAttribute("public-key"));
      this.enabled = enabled;
    } catch (error) {
      this.error = error instanceof Error ? error.message : "Request failed.";
    } finally {
      this.busy = false;
      this.render();
    }
  }
}
customElements.define("push-settings", PushSettings);

export const localPreferences = {
  "wrap-code": { key: "pi.html.wrap-code", fallback: false },
  "bottom-align": { key: "pi.bottomAlign", fallback: true },
} as const;
export function restorePreferences() {
  for (const [name, { key, fallback }] of Object.entries(localPreferences)) {
    let enabled = document.body.classList.contains(name);
    try {
      const stored = localStorage.getItem(key);
      enabled = stored === null ? fallback : stored === "true";
    } catch {
      /* Keep the in-memory preference when storage is unavailable. */
    }
    document.body.classList.toggle(name, enabled);
    for (const input of document.querySelectorAll<HTMLInputElement>(`[data-preference="${name}"]`))
      input.checked = input.value === String(enabled);
  }
}
export function installPreferences() {
  restorePreferences();
  document.addEventListener("change", (event) => {
    if (
      !(event.target instanceof HTMLInputElement) ||
      event.target.type !== "radio" ||
      !event.target.checked
    )
      return;
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
