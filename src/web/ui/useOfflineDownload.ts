import { useCallback, useEffect, useRef, useState } from "react";
import {
  OFFLINE_PROTOCOL, OfflineStateSchema, offlineManifestUrl, readOfflineManifest,
  selectOfflineFiles, type OfflineReferences, type OfflineState,
} from "../../domain/offline.js";
import type { ExamId } from "../../domain/exams.js";
import { activateOfflineWorker } from "../offline-worker-activation.js";

const emptyState: OfflineState = {
  status: "empty", ready: false, buildId: null, releaseId: null,
  totalFiles: 0, completedFiles: 0, totalBytes: 0, completedBytes: 0,
  downloadBytes: 0, error: null, updatedAt: null,
};

export function useOfflineDownload(examId: ExamId = "az104") {
  const supported = import.meta.env.VITE_STUDY_DEMO !== "true" &&
    typeof navigator !== "undefined" && "serviceWorker" in navigator &&
    "caches" in globalThis && window.isSecureContext &&
    (import.meta.env.PROD || (import.meta.env.VITE_OFFLINE_TEST === "true" &&
      ["localhost", "127.0.0.1"].includes(location.hostname)));
  const [online, setOnline] = useState(() => navigator.onLine);
  const [forceDownload, setForceDownload] = useState(false);
  const [snapshot, setSnapshot] = useState({ examId, state: emptyState });
  const state = snapshot.examId === examId ? snapshot.state : emptyState;
  const [initialized, setInitialized] = useState(!supported);
  const [preparing, setPreparing] = useState(false);
  const [issue, setIssue] = useState<string | null>(null);
  const [storageNote, setStorageNote] = useState<string | null>(null);
  const registration = useRef<ServiceWorkerRegistration | null>(null);
  const mounted = useRef(false);
  const currentExam = useRef(examId);
  currentExam.current = examId;
  const waiting = useRef(new Map<string, {
    resolve: (state: OfflineState) => void; reject: (error: Error) => void; timer: number;
  }>());

  const send = useCallback(async (type: "STATUS" | "DOWNLOAD" | "CANCEL" | "REMOVE" | "REMOVE_ALL", legacyRefs?: OfflineReferences) => {
    const worker = registration.current?.active;
    if (!worker) throw new Error("Offline support has not activated yet.");
    const id = crypto.randomUUID();
    return new Promise<OfflineState>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        waiting.current.delete(id);
        reject(new Error("The offline download did not respond. Reload and try again."));
      }, type === "STATUS" ? 20_000 : 60_000);
      waiting.current.set(id, { resolve, reject, timer });
      worker.postMessage({ protocol: OFFLINE_PROTOCOL, id, type, examId, ...(legacyRefs ? { legacyRefs } : {}) });
    });
  }, [examId]);

  useEffect(() => {
    mounted.current = true;
    setSnapshot({ examId, state: emptyState });
    setForceDownload(false);
    setPreparing(false);
    setIssue(null);
    setInitialized(!supported);
    let closed = false;
    const updateOnline = () => setOnline(navigator.onLine);
    const receive = (event: MessageEvent<unknown>) => {
      const data = event.data;
      if (!data || typeof data !== "object" || !("protocol" in data) || data.protocol !== OFFLINE_PROTOCOL) return;
      const record = data as Record<string, unknown>;
      if (record.type !== "STATE" && record.type !== "RESULT") return;
      if ((record.examId ?? "az104") !== examId) return;
      const parsed = OfflineStateSchema.safeParse(record.state);
      if (!parsed.success) {
        setIssue("The offline download reported invalid status. Reload before using it.");
        return;
      }
      setSnapshot({ examId, state: parsed.data });
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
        if (closed) return;
        if (value?.active) {
          if (new URL(value.active.scriptURL).pathname !== "/offline-worker.js") {
            throw new Error("A different service worker manages this origin; its caches were left untouched.");
          }
          registration.current = value;
          await send("STATUS");
        }
      }).catch((error: unknown) => {
        if (!closed) setIssue(error instanceof Error ? error.message : "Offline status could not be loaded.");
      }).finally(() => { if (!closed) setInitialized(true); });
    }
    return () => {
      mounted.current = false;
      closed = true;
      window.removeEventListener("online", updateOnline);
      window.removeEventListener("offline", updateOnline);
      navigator.serviceWorker?.removeEventListener("message", receive);
      for (const request of waiting.current.values()) {
        clearTimeout(request.timer);
        request.reject(new Error("Offline controls were closed."));
      }
      waiting.current.clear();
    };
  }, [examId, send, supported]);

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
      const response = await fetch(offlineManifestUrl(examId), { cache: "no-store", redirect: "error", credentials: "omit" });
      const manifest = await readOfflineManifest(response, examId);
      const files = selectOfflineFiles(manifest, legacyRefs);
      const required = files.reduce((sum, file) => sum + file.bytes, 0);
      if (navigator.storage?.estimate) {
        const estimate = await navigator.storage.estimate();
        if (estimate.quota !== undefined && estimate.usage !== undefined &&
            estimate.quota - estimate.usage < required * 1.15) {
          throw new Error(`Not enough browser storage. Free at least ${Math.ceil(required * 1.15 / 1_000_000)} MB before downloading.`);
        }
      }
      if (!mounted.current || currentExam.current !== examId) return;
      await activate();
      if (!mounted.current || currentExam.current !== examId) return;
      await send("DOWNLOAD", legacyRefs);
    } catch (error) {
      if (mounted.current && currentExam.current === examId) {
        setIssue(error instanceof Error ? error.message : "The offline download could not start.");
      }
    } finally { if (mounted.current && currentExam.current === examId) setPreparing(false); }
  };

  const control = async (type: "CANCEL" | "REMOVE" | "REMOVE_ALL") => {
    setIssue(null);
    try {
      await send(type);
      if (type !== "CANCEL") setForceDownload(false);
    } catch (error) { setIssue(error instanceof Error ? error.message : "Offline files could not be updated."); }
  };
  const useDownload = !online || forceDownload;
  return {
    examId, supported, initialized, online, useDownload, state, preparing, hasWorker: Boolean(registration.current?.active),
    issue: issue ?? state.error, storageNote, download,
    cancel: () => control("CANCEL"), remove: () => control("REMOVE"), removeAll: () => control("REMOVE_ALL"),
    useCopy: () => setForceDownload(true), useOnline: () => setForceDownload(false),
  };
}

export type OfflineDownload = ReturnType<typeof useOfflineDownload>;
