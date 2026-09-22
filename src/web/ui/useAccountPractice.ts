import { useCallback, useEffect, useRef, useState } from "react";
import { ExamIdSchema, type ExamId } from "../../domain/exams.js";
import { loadAccountProgress, saveAccountAttempt, ProgressConflictError } from "../account-progress.js";
import type { PracticeAttempt } from "../engine.js";
import {
  accountCacheSchema, accountStorageKey, emptyAccountCache, queueAttempt, acknowledgeAttempt,
  accountCloudState, type AccountCache, type DataSource,
} from "../profile-storage.js";
import { readPractice, writePractice, storeAttempt } from "../storage.js";

const message = (error: unknown) => error instanceof Error ? error.message : "Account progress could not be synchronized.";

function initialCache(uid: string | null, examId: ExamId): { cache: AccountCache; warning: string | null; storageBlocked: boolean } {
  try {
    if (!uid) {
      const guest = readPractice(window.localStorage, undefined, examId);
      return { cache: { ...emptyAccountCache(examId), saved: guest.state, dataSource: "snapshot" },
        warning: guest.warning, storageBlocked: Boolean(guest.warning) };
    }
    const raw = window.localStorage.getItem(accountStorageKey(uid, examId));
    return { cache: raw ? accountCacheSchema(examId).parse(JSON.parse(raw)) : emptyAccountCache(examId), warning: null, storageBlocked: false };
  } catch {
    return {
      cache: { ...emptyAccountCache(examId), dataSource: uid ? "firebase" : "snapshot" },
      warning: "This browser's saved state could not be read and will not be overwritten. New device changes remain in memory until account recovery.",
      storageBlocked: true,
    };
  }
}

export function useAccountPractice(uid: string | null, cloudEnabled = true, examId: ExamId = "az104") {
  ExamIdSchema.parse(examId);
  const [initial] = useState(() => initialCache(uid, examId));
  const [cache, setCache] = useState(initial.cache);
  const ref = useRef(cache);
  const [ready, setReady] = useState(!uid || !cloudEnabled);
  const readyRef = useRef(!uid);
  const cloudRef = useRef(cloudEnabled);
  cloudRef.current = cloudEnabled;
  const pausedSinceLoad = useRef(!cloudEnabled);
  const [warning, setWarning] = useState<string | null>(initial.warning);
  const [diskWarning, setDiskWarning] = useState<string | null>(initial.warning);
  const [storageBlocked, setStorageBlocked] = useState(initial.storageBlocked);
  const blockedRef = useRef(initial.storageBlocked);
  const [syncing, setSyncing] = useState(false);
  const [conflict, setConflict] = useState(false);
  const conflictRef = useRef(false);
  const mounted = useRef(true);
  const running = useRef<Promise<void> | null>(null);
  const urgent = useRef(false);
  const loadSequence = useRef(0);
  const flushRef = useRef<(immediate?: boolean) => Promise<void>>(async () => {});
  const scopeRef = useRef({ uid, examId });

  if (scopeRef.current.uid !== uid || scopeRef.current.examId !== examId) {
    const next = initialCache(uid, examId);
    scopeRef.current = { uid, examId };
    ref.current = next.cache;
    readyRef.current = !uid;
    pausedSinceLoad.current = !cloudEnabled;
    blockedRef.current = next.storageBlocked;
    conflictRef.current = false;
    running.current = null;
    urgent.current = false;
    loadSequence.current++;
    setCache(next.cache);
    setReady(!uid || !cloudEnabled);
    setWarning(next.warning);
    setDiskWarning(next.warning);
    setStorageBlocked(next.storageBlocked);
    setSyncing(false);
    setConflict(false);
  }
  const scope = scopeRef.current;
  const isCurrent = useCallback(() => mounted.current && scopeRef.current === scope, [scope]);

  const persist = useCallback((next: AccountCache) => {
    if (!isCurrent()) return;
    next = accountCacheSchema(examId).parse(next);
    ref.current = next;
    if (mounted.current) setCache(next);
    if (blockedRef.current) return;
    try {
      if (uid) window.localStorage.setItem(accountStorageKey(uid, examId), JSON.stringify(next));
      else {
        const failure = writePractice(window.localStorage, next.saved, undefined, examId);
        if (failure) {
          if (mounted.current) setDiskWarning(failure);
          return;
        }
      }
      if (mounted.current) setDiskWarning(null);
    } catch {
      if (mounted.current) setDiskWarning("Browser storage is unavailable. Unsynced progress is only in memory; keep this tab open and use Save progress.");
    }
  }, [uid, examId, isCurrent]);

  const flush = useCallback(async (immediate = false): Promise<void> => {
    if (!isCurrent() || !uid || !cloudRef.current || !readyRef.current || conflictRef.current) return;
    if (running.current) {
      urgent.current ||= immediate;
      return running.current;
    }
    if (!ref.current.pending.length) return;
    const batch = [...ref.current.pending];
    const pending = (async () => {
      if (mounted.current) setSyncing(true);
      try {
        for (const queued of batch) {
          if (!isCurrent() || !cloudRef.current) break;
          const record = ref.current.pending.find((item) => item.id === queued.id);
          if (!record) continue;
          const { revision } = await saveAccountAttempt(uid, record, ref.current.revision, examId);
          if (!isCurrent()) return;
          persist(acknowledgeAttempt(ref.current, record, revision, examId));
        }
        if (isCurrent()) setWarning(null);
      } catch (error) {
        if (!isCurrent()) return;
        const changed = error instanceof ProgressConflictError;
        if (changed) conflictRef.current = true;
        if (mounted.current) {
          setConflict(changed);
          setWarning(changed
            ? "Your account changed on another device. This device's unsynced progress is kept separately; choose which version to continue with."
            : cloudRef.current ? `Cloud save failed. Progress is kept on this device. ${message(error)}` : null);
        }
      } finally {
        if (isCurrent()) {
          running.current = null;
          setSyncing(false);
          if (urgent.current) {
            urgent.current = false;
            void flushRef.current();
          }
        }
      }
    })();
    running.current = pending;
    return pending;
  }, [persist, uid, examId, isCurrent]);
  flushRef.current = flush;

  const load = useCallback(async (replaceLocal = false) => {
    if (!isCurrent() || !uid || !cloudRef.current) return;
    const sequence = ++loadSequence.current;
    if (running.current) await running.current;
    if (!isCurrent()) return;
    if (mounted.current) setSyncing(true);
    try {
      const cloud = await loadAccountProgress(uid, examId);
      if (!isCurrent() || sequence !== loadSequence.current) return;
      const local = ref.current;
      const hadVisibleCachedProgress = pausedSinceLoad.current &&
        Boolean(local.saved.activeAttempt || local.saved.history.length);
      const changed = !replaceLocal && (local.pending.length > 0 || hadVisibleCachedProgress) &&
        local.revision !== cloud.revision;
      conflictRef.current = changed;
      setConflict(changed);
      if (changed) {
        setWarning("Your account changed on another device. Unsynced progress on this device has been preserved.");
      } else if (replaceLocal || !local.pending.length) {
        if (replaceLocal) {
          blockedRef.current = false;
          setStorageBlocked(false);
          setDiskWarning(null);
        }
        persist({ ...local, saved: accountCloudState(cloud.activeAttempt, cloud.history, examId), revision: cloud.revision, pending: [] });
        setWarning(null);
      }
      readyRef.current = true;
      setReady(true);
      if (!changed) pausedSinceLoad.current = false;
      if (!changed && ref.current.pending.length) void flushRef.current();
    } catch (error) {
      if (isCurrent() && sequence === loadSequence.current) {
        setWarning(`Account progress could not be loaded. Device progress is preserved. ${message(error)}`);
        setReady(true);
      }
      // Writes remain blocked until a server revision has been obtained.
    } finally { if (isCurrent() && sequence === loadSequence.current) setSyncing(false); }
  }, [persist, uid, examId, isCurrent]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!uid) return;
    if (!cloudEnabled) {
      loadSequence.current++;
      readyRef.current = false;
      pausedSinceLoad.current = true;
      setReady(true);
      return;
    }
    void load();
  }, [cloudEnabled, uid, load]);

  useEffect(() => {
    if (!uid) return;
    const timer = window.setInterval(() => {
      if (!cloudRef.current) return;
      if (readyRef.current) void flush();
      else void load();
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [uid, flush, load]);

  const commitRecord = useCallback((record: PracticeAttempt, saveImmediately = false) => {
    if (!isCurrent()) return;
    const current = ref.current;
    const next = uid ? queueAttempt(current, record, examId) : { ...current, saved: storeAttempt(current.saved, record, examId) };
    persist(next);
    if (saveImmediately && uid) void flushRef.current(true);
  }, [persist, uid, examId, isCurrent]);

  return {
    saved: cache.saved, getSaved: () => isCurrent() ? ref.current.saved : cache.saved,
    ready, warning: diskWarning ?? warning, syncing, conflict, storageBlocked,
    dataSource: cache.dataSource, pendingCount: cache.pending.length,
    setDataSource(source: DataSource) {
      if (!isCurrent()) return;
      if (source === "firebase" && !uid) { setWarning("Sign in with Google to use the Firestore question bank."); return; }
      persist({ ...ref.current, dataSource: source });
    },
    commitRecord,
    clearLocalHistory() {
      if (!isCurrent()) return;
      if (uid) { setWarning("Cloud history is retained in your account."); return; }
      persist({ ...ref.current, saved: { ...ref.current.saved, history: [] } });
    },
    sync: () => readyRef.current ? flush(true) : load(),
    loadCloudVersion: () => load(true),
    useDeviceVersion: async () => {
      if (!isCurrent() || !uid || !cloudRef.current || running.current) return;
      try {
        const cloud = await loadAccountProgress(uid, examId);
        if (!isCurrent()) return;
        persist({ ...ref.current, revision: cloud.revision });
        conflictRef.current = false;
        setConflict(false);
        readyRef.current = true;
        pausedSinceLoad.current = false;
        await flush(true);
      } catch (error) { if (isCurrent()) setWarning(`Could not resolve account progress: ${message(error)}`); }
    },
  };
}
