import { z } from "zod";
import { PracticeAttemptSchema, type PracticeAttempt } from "./engine.js";

export const STORAGE_KEY = "az104-study-room:v1";

export interface SavedPractice {
  schemaVersion: 1;
  activeAttempt: PracticeAttempt | null;
  history: PracticeAttempt[];
}

export const SavedPracticeSchema = z.object({
  schemaVersion: z.literal(1),
  activeAttempt: PracticeAttemptSchema.nullable(),
  history: z.array(PracticeAttemptSchema).max(20),
}).strict().superRefine((state, context) => {
  if (state.activeAttempt?.status === "completed") {
    context.addIssue({
      code: "custom", path: ["activeAttempt"], message: "The active attempt must be active",
    });
  }
  const ids = new Set<string>();
  state.history.forEach((attempt, index) => {
    if (attempt.status !== "completed") {
      context.addIssue({
        code: "custom", path: ["history", index], message: "History may only contain completed attempts",
      });
    }
    if (ids.has(attempt.id)) {
      context.addIssue({
        code: "custom", path: ["history", index, "id"], message: "History attempt IDs must be unique",
      });
    }
    ids.add(attempt.id);
  });
});

export function emptyPractice(): SavedPractice {
  return { schemaVersion: 1, activeAttempt: null, history: [] };
}

export function readPractice(
  storage: Pick<Storage, "getItem">,
  key = STORAGE_KEY,
): { state: SavedPractice; warning: string | null } {
  try {
    const raw = storage.getItem(key);
    if (raw === null) return { state: emptyPractice(), warning: null };
    const parsed: unknown = JSON.parse(raw);
    const result = SavedPracticeSchema.safeParse(parsed);
    if (!result.success) {
      return {
        state: emptyPractice(),
        warning: "Saved practice data is invalid; using in-memory practice state.",
      };
    }
    return { state: result.data, warning: null };
  } catch {
    return {
      state: emptyPractice(),
      warning: "Local practice storage is unavailable; using in-memory practice state.",
    };
  }
}

export function writePractice(
  storage: Pick<Storage, "setItem">,
  state: SavedPractice,
  key = STORAGE_KEY,
): string | null {
  const result = SavedPracticeSchema.safeParse(state);
  if (!result.success) return "Practice state is invalid and could not be saved.";
  try {
    storage.setItem(key, JSON.stringify(result.data));
    return null;
  } catch {
    return "Local practice storage is unavailable; changes remain in memory only.";
  }
}

export function storeAttempt(state: SavedPractice, attempt: PracticeAttempt): SavedPractice {
  SavedPracticeSchema.parse(state);
  PracticeAttemptSchema.parse(attempt);
  if (attempt.status === "active") {
    return { ...state, activeAttempt: attempt };
  }

  const history = [
    attempt,
    ...state.history.filter((existing) => existing.id !== attempt.id),
  ].slice(0, 20);
  return {
    ...state,
    activeAttempt: state.activeAttempt?.id === attempt.id ? null : state.activeAttempt,
    history,
  };
}
