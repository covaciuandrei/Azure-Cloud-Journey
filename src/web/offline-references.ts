import type { OfflineReferences } from "../domain/offline.js";
import type { SavedPractice } from "./storage.js";

export function offlineSessionReferences(...states: SavedPractice[]): OfflineReferences {
  const releases = new Map<string, Set<string>>();
  for (const state of states) {
    for (const attempt of [...state.history, ...(state.activeAttempt ? [state.activeAttempt] : [])]) {
      const ids = releases.get(attempt.releaseId) ?? new Set<string>();
      attempt.questionIds.forEach((id) => ids.add(id));
      releases.set(attempt.releaseId, ids);
    }
  }
  return [...releases].map(([releaseId, ids]) => ({ releaseId, questionIds: [...ids].sort() }));
}
