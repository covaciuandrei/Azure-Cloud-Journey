interface WorkerLifecycle extends EventTarget {
  readonly state: ServiceWorkerState;
  readonly scriptURL: string;
}

interface RegistrationLifecycle {
  readonly active: WorkerLifecycle | null;
  readonly installing: WorkerLifecycle | null;
  readonly waiting: WorkerLifecycle | null;
  update(): Promise<unknown>;
}

interface WorkerContainer<R extends RegistrationLifecycle> {
  getRegistration(scope: string): Promise<R | undefined>;
  register(scriptURL: string, options: RegistrationOptions): Promise<R>;
}

export async function activateOfflineWorker<R extends RegistrationLifecycle>(container: WorkerContainer<R>): Promise<R> {
  const existing = await container.getRegistration("/");
  if (existing?.active && new URL(existing.active.scriptURL).pathname !== "/offline-worker.js") {
    throw new Error("A different service worker manages this app.");
  }
  const next = await container.register("/offline-worker.js", { scope: "/", updateViaCache: "none" });
  // register() can return the previous active worker before its update check finishes.
  await next.update();
  const worker = next.installing ?? next.waiting ?? next.active;
  if (!worker) throw new Error("Offline support could not be installed.");
  if (worker.state !== "activated") {
    await new Promise<void>((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        worker.removeEventListener("statechange", changed);
        reject(new Error("Offline support did not activate."));
      }, 20_000);
      const changed = () => {
        if (worker.state !== "activated" && worker.state !== "redundant") return;
        clearTimeout(timer);
        worker.removeEventListener("statechange", changed);
        if (worker.state === "activated") resolve();
        else reject(new Error("The offline worker update could not be installed."));
      };
      worker.addEventListener("statechange", changed);
      changed();
    });
  }
  if (next.active !== worker || new URL(worker.scriptURL).pathname !== "/offline-worker.js") {
    throw new Error("The updated offline worker did not become active.");
  }
  return next;
}
