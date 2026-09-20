import { useCallback, useEffect, useRef, useState } from "react";
import { loadAccountProgress, saveAccountAttempt, ProgressConflictError } from "../account-progress.js";
import type { PracticeAttempt } from "../engine.js";
import {
  AccountCacheSchema, accountStorageKey, emptyAccountCache, queueAttempt, acknowledgeAttempt,
  accountCloudState, type AccountCache, type DataSource,
} from "../profile-storage.js";
import { readPractice, writePractice, storeAttempt } from "../storage.js";

const message = (error: unknown) => error instanceof Error ? error.message : "Account progress could not be synchronized.";

function initialCache(uid: string | null): { cache: AccountCache; warning: string | null; storageBlocked: boolean } {
  try {
    if (!uid) {
      const guest = readPractice(window.localStorage);
      return { cache: { ...emptyAccountCache(), saved: guest.state, dataSource: "snapshot" },
        warning: guest.warning, storageBlocked: Boolean(guest.warning) };
    }
    const raw = window.localStorage.getItem(accountStorageKey(uid));
    return { cache: raw ? AccountCacheSchema.parse(JSON.parse(raw)) : emptyAccountCache(), warning: null, storageBlocked: false };
  } catch {
    return {
      cache: { ...emptyAccountCache(), dataSource: uid ? "firebase" : "snapshot" },
      warning: "This browser's saved state could not be read and will not be overwritten. New device changes remain in memory until account recovery.",
      storageBlocked: true,
    };
  }
}

export function useAccountPractice(uid: string | null, cloudEnabled = true) {
  const [initial] = useState(() => initialCache(uid));
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

  const persist = useCallback((next: AccountCache) => {
    ref.current = next;
    if (mounted.current) setCache(next);
    if (blockedRef.current) return;
    try {
      if (uid) window.localStorage.setItem(accountStorageKey(uid), JSON.stringify(AccountCacheSchema.parse(next)));
      else {
        const failure = writePractice(window.localStorage, next.saved);
        if (failure) {
          if (mounted.current) setDiskWarning(failure);
          return;
        }
      }
      if (mounted.current) setDiskWarning(null);
    } catch {
      if (mounted.current) setDiskWarning("Browser storage is unavailable. Unsynced progress is only in memory; keep this tab open and use Save progress.");
    }
  }, [uid]);

  const flush = useCallback(async (immediate = false): Promise<void> => {
    if (!uid || !cloudRef.current || !readyRef.current || conflictRef.current) return;
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
          if (!mounted.current || !cloudRef.current) break;
          const record = ref.current.pending.find((item) => item.id === queued.id);
          if (!record) continue;
          const { revision } = await saveAccountAttempt(uid, record, ref.current.revision);
          persist(acknowledgeAttempt(ref.current, record, revision));
        }
        if (mounted.current) setWarning(null);
      } catch (error) {
        const changed = error instanceof ProgressConflictError;
        if (changed) conflictRef.current = true;
        if (mounted.current) {
          setConflict(changed);
          setWarning(changed
            ? "Your account changed on another device. This device's unsynced progress is kept separately; choose which version to continue with."
            : cloudRef.current ? `Cloud save failed. Progress is kept on this device. ${message(error)}` : null);
        }
      } finally {
        running.current = null;
        if (mounted.current) setSyncing(false);
        if (urgent.current && mounted.current) {
          urgent.current = false;
          void flushRef.current();
        }
      }
    })();
    running.current = pending;
    return pending;
  }, [persist, uid]);
  flushRef.current = flush;

  const load = useCallback(async (replaceLocal = false) => {
    if (!uid || !cloudRef.current) return;
    const sequence = ++loadSequence.current;
    if (running.current) await running.current;
    if (mounted.current) setSyncing(true);
    try {
      const cloud = await loadAccountProgress(uid);
      if (!mounted.current || sequence !== loadSequence.current) return;
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
        persist({ ...local, saved: accountCloudState(cloud.activeAttempt, cloud.history), revision: cloud.revision, pending: [] });
        setWarning(null);
      }
      readyRef.current = true;
      setReady(true);
      if (!changed) pausedSinceLoad.current = false;
      if (!changed && ref.current.pending.length) void flushRef.current();
    } catch (error) {
      if (mounted.current && sequence === loadSequence.current) {
        setWarning(`Account progress could not be loaded. Device progress is preserved. ${message(error)}`);
        setReady(true);
      }
      // Writes remain blocked until a server revision has been obtained.
    } finally { if (mounted.current && sequence === loadSequence.current) setSyncing(false); }
  }, [persist, uid]);

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
    const current = ref.current;
    const next = uid ? queueAttempt(current, record) : { ...current, saved: storeAttempt(current.saved, record) };
    persist(next);
    if (saveImmediately && uid) void flushRef.current(true);
  }, [persist, uid]);

  return {
    saved: cache.saved, getSaved: () => ref.current.saved, ready, warning: diskWarning ?? warning, syncing, conflict, storageBlocked,
    dataSource: cache.dataSource, pendingCount: cache.pending.length,
    setDataSource(source: DataSource) {
      if (source === "firebase" && !uid) { setWarning("Sign in with Google to use the Firestore question bank."); return; }
      persist({ ...ref.current, dataSource: source });
    },
    commitRecord,
    clearLocalHistory() {
      if (uid) { setWarning("Cloud history is retained in your account."); return; }
      persist({ ...ref.current, saved: { ...ref.current.saved, history: [] } });
    },
    sync: () => readyRef.current ? flush(true) : load(),
    loadCloudVersion: () => load(true),
    useDeviceVersion: async () => {
      if (!uid || !cloudRef.current || running.current) return;
      try {
        const cloud = await loadAccountProgress(uid);
        if (!mounted.current) return;
        persist({ ...ref.current, revision: cloud.revision });
        conflictRef.current = false;
        setConflict(false);
        readyRef.current = true;
        pausedSinceLoad.current = false;
        await flush(true);
      } catch (error) { if (mounted.current) setWarning(`Could not resolve account progress: ${message(error)}`); }
    },
  };
}
