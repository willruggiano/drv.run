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
  window.addEventListener("offline", () => document.body.classList.add("offline"));
  window.addEventListener("online", () => document.body.classList.remove("offline"));

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
      .register("/hypermedia-sw.js", { scope: "/sessions" })
      .then(async (worker) => {
        registration = worker;
        worker.addEventListener("updatefound", () =>
          worker.installing?.addEventListener("statechange", installStatus),
        );
        installStatus();
        // Activation may race a navigation; claim the now-loaded document.
        void navigator.serviceWorker.ready.then((ready) => ready.active?.postMessage("claim"));
        // Retire the removed frontend's root-scoped worker, not unrelated registrations.
        const workers = await navigator.serviceWorker.getRegistrations();
        await Promise.all(
          workers
            .filter((item) =>
              [item.active, item.waiting, item.installing].some(
                (worker) => worker && new URL(worker.scriptURL).pathname === "/sw.js",
              ),
            )
            .map((item) => item.unregister()),
        );
      })
      .catch(() => {
        /* Offline first visits still render the supplied document. */
      });
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (updateRequested) location.reload();
    });
  }
}
