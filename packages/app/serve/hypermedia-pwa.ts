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
    void navigator.serviceWorker
      .getRegistrations()
      .then(async (workers) => {
        // Retire obsolete registrations before creating the root-scoped worker.
        // Unregistering afterward could also remove its pending replacement.
        await Promise.all(
          workers
            .filter((item) =>
              [item.active, item.waiting, item.installing].some(
                (worker) =>
                  worker &&
                  (new URL(worker.scriptURL).pathname === "/sw.js" ||
                    (new URL(worker.scriptURL).pathname === "/hypermedia-sw.js" &&
                      new URL(item.scope).pathname !== "/")),
              ),
            )
            .map((item) => item.unregister()),
        );
        return navigator.serviceWorker.register("/hypermedia-sw.js", { scope: "/" });
      })
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
