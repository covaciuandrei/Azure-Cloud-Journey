import { z } from "zod";
import { assertExam, ExamIdSchema, examIdOf, type ExamId } from "../domain/exams.js";
import { PracticeAttemptSchema, type PracticeAttempt } from "./engine.js";
import { SavedPracticeSchema, savedPracticeSchema, practiceStorageKey, emptyPractice, storeAttempt, type SavedPractice } from "./storage.js";

export const DataSourceSchema = z.enum(["firebase", "snapshot"]);
export type DataSource = z.infer<typeof DataSourceSchema>;
export const AccountCacheSchema = z.object({
  schemaVersion: z.literal(1),
  examId: ExamIdSchema.optional(),
  saved: SavedPracticeSchema,
  revision: z.string().min(1).nullable(),
  pending: z.array(PracticeAttemptSchema).max(100),
  dataSource: DataSourceSchema,
}).strict().refine((value) => examIdOf(value.saved) === examIdOf(value) &&
  value.pending.every((item) => examIdOf(item) === examIdOf(value)),
  "Cached practice belongs to another exam").refine((value) => new Set(value.pending.map((item) => item.id)).size === value.pending.length,
  "Pending session IDs must be unique");
export type AccountCache = z.infer<typeof AccountCacheSchema>;

export function accountCacheSchema(examId: ExamId = "az104") {
  ExamIdSchema.parse(examId);
  return AccountCacheSchema.refine((cache) => examIdOf(cache) === examId, "Account cache belongs to another exam");
}

export function accountStorageKey(uid: string, examId: ExamId = "az104"): string {
  if (!uid || uid.length > 128 || /[/\\\u0000-\u001f]/.test(uid)) throw new Error("Invalid account identity.");
  return `${practiceStorageKey(examId)}:account:${encodeURIComponent(uid)}`;
}

export function emptyAccountCache(examId: ExamId = "az104"): AccountCache {
  return {
    schemaVersion: 1, ...(examId === "az104" ? {} : { examId }),
    saved: emptyPractice(examId), revision: null, pending: [], dataSource: "firebase",
  };
}

export function queueAttempt(cache: AccountCache, attempt: PracticeAttempt, examId: ExamId = "az104"): AccountCache {
  const schema = accountCacheSchema(examId);
  cache = schema.parse(cache);
  attempt = PracticeAttemptSchema.parse(attempt);
  assertExam(attempt, examId);
  const pending = [...cache.pending];
  const index = pending.findIndex((item) => item.id === attempt.id);
  if (index < 0) pending.push(attempt);
  else pending[index] = attempt;
  return schema.parse({ ...cache, saved: storeAttempt(cache.saved, attempt, examId), pending });
}

export function acknowledgeAttempt(
  cache: AccountCache, uploaded: PracticeAttempt, revision: string, examId: ExamId = "az104",
): AccountCache {
  const schema = accountCacheSchema(examId);
  cache = schema.parse(cache);
  uploaded = PracticeAttemptSchema.parse(uploaded);
  assertExam(uploaded, examId);
  return schema.parse({
    ...cache, revision,
    pending: cache.pending.filter((item) => item.id !== uploaded.id || JSON.stringify(item) !== JSON.stringify(uploaded)),
  });
}

export function accountCloudState(
  activeAttempt: PracticeAttempt | null, history: PracticeAttempt[], examId: ExamId = "az104",
): SavedPractice {
  return savedPracticeSchema(examId).parse({ ...emptyPractice(examId), activeAttempt, history });
}
