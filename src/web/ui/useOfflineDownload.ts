import { useCallback, useEffect, useRef, useState } from "react";
import {
  OFFLINE_MANIFEST_URL, OFFLINE_PROTOCOL, OfflineManifestSchema, OfflineStateSchema,
  selectOfflineFiles, type OfflineReferences, type OfflineState,
} from "../../domain/offline.js";
import { activateOfflineWorker } from "../offline-worker-activation.js";

const emptyState: OfflineState = {
  status: "empty", ready: false, buildId: null, releaseId: null,
  totalFiles: 0, completedFiles: 0, totalBytes: 0, completedBytes: 0,
  downloadBytes: 0, error: null, updatedAt: null,
};

export function useOfflineDownload() {
  const supported = import.meta.env.VITE_STUDY_DEMO !== "true" &&
    typeof navigator !== "undefined" && "serviceWorker" in navigator &&
    "caches" in globalThis && window.isSecureContext &&
    (import.meta.env.PROD || (import.meta.env.VITE_OFFLINE_TEST === "true" &&
      ["localhost", "127.0.0.1"].includes(location.hostname)));
  const [online, setOnline] = useState(() => navigator.onLine);
  const [forceDownload, setForceDownload] = useState(false);
  const [state, setState] = useState<OfflineState>(emptyState);
  const [initialized, setInitialized] = useState(!supported);
  const [preparing, setPreparing] = useState(false);
  const [issue, setIssue] = useState<string | null>(null);
  const [storageNote, setStorageNote] = useState<string | null>(null);
  const registration = useRef<ServiceWorkerRegistration | null>(null);
  const mounted = useRef(false);
  const waiting = useRef(new Map<string, {
    resolve: (state: OfflineState) => void; reject: (error: Error) => void; timer: number;
  }>());

  const send = useCallback(async (type: "STATUS" | "DOWNLOAD" | "CANCEL" | "REMOVE", legacyRefs?: OfflineReferences) => {
    const worker = registration.current?.active;
    if (!worker) throw new Error("Offline support has not activated yet.");
    const id = crypto.randomUUID();
    return new Promise<OfflineState>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        waiting.current.delete(id);
        reject(new Error("The offline download did not respond. Reload and try again."));
      }, type === "STATUS" ? 20_000 : 60_000);
      waiting.current.set(id, { resolve, reject, timer });
      worker.postMessage({ protocol: OFFLINE_PROTOCOL, id, type, ...(legacyRefs ? { legacyRefs } : {}) });
    });
  }, []);

  useEffect(() => {
    mounted.current = true;
    const updateOnline = () => setOnline(navigator.onLine);
    const receive = (event: MessageEvent<unknown>) => {
      const data = event.data;
      if (!data || typeof data !== "object" || !("protocol" in data) || data.protocol !== OFFLINE_PROTOCOL) return;
      const record = data as Record<string, unknown>;
      if (record.type !== "STATE" && record.type !== "RESULT") return;
      const parsed = OfflineStateSchema.safeParse(record.state);
      if (!parsed.success) {
        setIssue("The offline download reported invalid status. Reload before using it.");
        return;
      }
      setState(parsed.data);
      if (!parsed.data.ready) setForceDownload(false);
      if (record.type === "RESULT" && typeof record.id === "string") {
        const request = waiting.current.get(record.id);
        if (request) {
          clearTimeout(request.timer);
          waiting.current.delete(record.id);
          if (typeof record.error === "string") request.reject(new Error(record.error));
          else request.resolve(parsed.data);
        }
      }
    };
    window.addEventListener("online", updateOnline);
    window.addEventListener("offline", updateOnline);
    if (supported) {
      navigator.serviceWorker.addEventListener("message", receive);
      void navigator.serviceWorker.getRegistration("/").then(async (value) => {
        if (!mounted.current) return;
        if (value?.active) {
          if (new URL(value.active.scriptURL).pathname !== "/offline-worker.js") {
            throw new Error("A different service worker manages this origin; its caches were left untouched.");
          }
          registration.current = value;
          await send("STATUS");
        }
      }).catch((error: unknown) => {
        if (mounted.current) setIssue(error instanceof Error ? error.message : "Offline status could not be loaded.");
      }).finally(() => { if (mounted.current) setInitialized(true); });
    }
    return () => {
      mounted.current = false;
      window.removeEventListener("online", updateOnline);
      window.removeEventListener("offline", updateOnline);
      navigator.serviceWorker?.removeEventListener("message", receive);
      for (const request of waiting.current.values()) {
        clearTimeout(request.timer);
        request.reject(new Error("Offline controls were closed."));
      }
      waiting.current.clear();
    };
  }, [send, supported]);

  const activate = async () => {
    registration.current = await activateOfflineWorker(navigator.serviceWorker);
  };

  const download = async (legacyRefs: OfflineReferences) => {
    if (!supported || !online) { setIssue("Connect to the hosted app to download an offline copy."); return; }
    setPreparing(true);
    setIssue(null);
    try {
      if (navigator.storage?.persist) {
        try {
          const persistent = await navigator.storage.persist();
          setStorageNote(persistent ? "Persistent storage granted." : "Your browser may remove this download when storage is low.");
        } catch {
          setStorageNote("Persistent storage was not granted. Your browser may remove downloaded files.");
        }
      } else setStorageNote("Your browser may remove downloaded files when storage is low.");
      const response = await fetch(OFFLINE_MANIFEST_URL, { cache: "no-store", redirect: "error", credentials: "omit" });
      if (!response.ok) throw new Error("This app build does not provide an offline download.");
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > 4 * 1024 * 1024) throw new Error("Offline manifest is too large.");
      const manifest = OfflineManifestSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
      const files = selectOfflineFiles(manifest, legacyRefs);
      const required = files.reduce((sum, file) => sum + file.bytes, 0);
      if (navigator.storage?.estimate) {
        const estimate = await navigator.storage.estimate();
        if (estimate.quota !== undefined && estimate.usage !== undefined &&
            estimate.quota - estimate.usage < required * 1.15) {
          throw new Error(`Not enough browser storage. Free at least ${Math.ceil(required * 1.15 / 1_000_000)} MB before downloading.`);
        }
      }
      await activate();
      await send("DOWNLOAD", legacyRefs);
    } catch (error) {
      setIssue(error instanceof Error ? error.message : "The offline download could not start.");
    } finally { if (mounted.current) setPreparing(false); }
  };

  const control = async (type: "CANCEL" | "REMOVE") => {
    setIssue(null);
    try {
      await send(type);
      if (type === "REMOVE") setForceDownload(false);
    } catch (error) { setIssue(error instanceof Error ? error.message : "Offline files could not be updated."); }
  };
  const useDownload = !online || forceDownload;
  return {
    supported, initialized, online, useDownload, state, preparing, hasWorker: Boolean(registration.current?.active),
    issue: issue ?? state.error, storageNote, download,
    cancel: () => control("CANCEL"), remove: () => control("REMOVE"),
    useCopy: () => setForceDownload(true), useOnline: () => setForceDownload(false),
  };
}

export type OfflineDownload = ReturnType<typeof useOfflineDownload>;
