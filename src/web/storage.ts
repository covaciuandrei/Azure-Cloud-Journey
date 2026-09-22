import { z } from "zod";
import { assertExam, ExamIdSchema, examIdOf, type ExamId } from "../domain/exams.js";
import { PracticeAttemptSchema, type PracticeAttempt } from "./engine.js";

export const STORAGE_KEY = "az104-study-room:v1";

export interface SavedPractice {
  schemaVersion: 1;
  examId?: ExamId | undefined;
  activeAttempt: PracticeAttempt | null;
  history: PracticeAttempt[];
}

export const SavedPracticeSchema = z.object({
  schemaVersion: z.literal(1),
  examId: ExamIdSchema.optional(),
  activeAttempt: PracticeAttemptSchema.nullable(),
  history: z.array(PracticeAttemptSchema).max(20),
}).strict().superRefine((state, context) => {
  const examId = examIdOf(state);
  if (state.activeAttempt && examIdOf(state.activeAttempt) !== examId) {
    context.addIssue({
      code: "custom", path: ["activeAttempt", "examId"], message: "The active attempt belongs to another exam",
    });
  }
  if (state.activeAttempt?.status === "completed") {
    context.addIssue({
      code: "custom", path: ["activeAttempt"], message: "The active attempt must be active",
    });
  }
  const ids = new Set<string>();
  state.history.forEach((attempt, index) => {
    if (examIdOf(attempt) !== examId) {
      context.addIssue({
        code: "custom", path: ["history", index, "examId"], message: "History belongs to another exam",
      });
    }
    if (attempt.status !== "completed") {
      context.addIssue({
        code: "custom", path: ["history", index], message: "History may only contain completed attempts",
      });
    }
    if (ids.has(attempt.id) || state.activeAttempt?.id === attempt.id) {
      context.addIssue({
        code: "custom", path: ["history", index, "id"], message: "History attempt IDs must be unique",
      });
    }
    ids.add(attempt.id);
  });
});

export function practiceStorageKey(examId: ExamId = "az104", key = STORAGE_KEY): string {
  ExamIdSchema.parse(examId);
  return examId === "az104" ? key : `${key}:exam:${examId}`;
}

export function savedPracticeSchema(examId: ExamId = "az104") {
  ExamIdSchema.parse(examId);
  return SavedPracticeSchema.refine((state) => examIdOf(state) === examId, "Practice belongs to another exam");
}

export function emptyPractice(examId: ExamId = "az104"): SavedPractice {
  ExamIdSchema.parse(examId);
  return { schemaVersion: 1, ...(examId === "az104" ? {} : { examId }), activeAttempt: null, history: [] };
}

export function readPractice(
  storage: Pick<Storage, "getItem">,
  key = STORAGE_KEY,
  examId: ExamId = "az104",
): { state: SavedPractice; warning: string | null } {
  const schema = savedPracticeSchema(examId);
  try {
    const raw = storage.getItem(practiceStorageKey(examId, key));
    if (raw === null) return { state: emptyPractice(examId), warning: null };
    const parsed: unknown = JSON.parse(raw);
    const result = schema.safeParse(parsed);
    if (!result.success) {
      return {
        state: emptyPractice(examId),
        warning: "Saved practice data is invalid; using in-memory practice state.",
      };
    }
    return { state: result.data, warning: null };
  } catch {
    return {
      state: emptyPractice(examId),
      warning: "Local practice storage is unavailable; using in-memory practice state.",
    };
  }
}

export function writePractice(
  storage: Pick<Storage, "setItem">,
  state: SavedPractice,
  key = STORAGE_KEY,
  examId: ExamId = "az104",
): string | null {
  const result = savedPracticeSchema(examId).safeParse(state);
  if (!result.success) return "Practice state is invalid and could not be saved.";
  try {
    storage.setItem(practiceStorageKey(examId, key), JSON.stringify(result.data));
    return null;
  } catch {
    return "Local practice storage is unavailable; changes remain in memory only.";
  }
}

export function storeAttempt(
  state: SavedPractice, attempt: PracticeAttempt, examId: ExamId = "az104",
): SavedPractice {
  const schema = savedPracticeSchema(examId);
  state = schema.parse(state);
  attempt = PracticeAttemptSchema.parse(attempt);
  assertExam(attempt, examId);
  if (attempt.status === "active") {
    return schema.parse({ ...state, activeAttempt: attempt });
  }

  const history = [
    attempt,
    ...state.history.filter((existing) => existing.id !== attempt.id),
  ].slice(0, 20);
  return schema.parse({
    ...state,
    activeAttempt: state.activeAttempt?.id === attempt.id ? null : state.activeAttempt,
    history,
  });
}
