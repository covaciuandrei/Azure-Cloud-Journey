import type { OfflineReferences } from "../domain/offline.js";
import type { SavedPractice } from "./storage.js";
import { assertExam, examIdOf, type ExamId } from "../domain/exams.js";

export function offlineSessionReferences(...states: SavedPractice[]): OfflineReferences {
  return offlineSessionReferencesForExam(states[0] ? examIdOf(states[0]) : "az104", ...states);
}

export function offlineSessionReferencesForExam(examId: ExamId, ...states: SavedPractice[]): OfflineReferences {
  const releases = new Map<string, Set<string>>();
  for (const state of states) {
    assertExam(state, examId);
    for (const attempt of [...state.history, ...(state.activeAttempt ? [state.activeAttempt] : [])]) {
      assertExam(attempt, examId);
      const ids = releases.get(attempt.releaseId) ?? new Set<string>();
      attempt.questionIds.forEach((id) => ids.add(id));
      releases.set(attempt.releaseId, ids);
    }
  }
  return [...releases].map(([releaseId, ids]) => ({ releaseId, questionIds: [...ids].sort() }));
}
