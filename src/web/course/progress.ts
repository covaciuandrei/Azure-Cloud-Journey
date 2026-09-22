import { z } from "zod";
import type { Course, CourseLesson } from "../../domain/course.js";
import { ExamIdSchema, type ExamId } from "../../domain/exams.js";

const id = z.string().regex(/^[a-z][a-z0-9-]{2,79}$/);
const timestamp = z.number().int().nonnegative().finite();
export const LessonProgressSchema = z.object({
  revision: z.string().regex(/^[a-f0-9]{64}$/), studiedAt: timestamp.nullable(), bookmarked: z.boolean(),
  answers: z.record(id, z.object({
    selectedIds: z.array(id).min(1).max(5).refine((values) => new Set(values).size === values.length),
    checkedAt: timestamp, attempts: z.number().int().min(1).max(100000),
  }).strict()).refine((answers) => Object.keys(answers).length <= 5),
}).strict();
export type LessonProgress = z.infer<typeof LessonProgressSchema>;
export const CourseProgressSchema = z.object({
  schemaVersion: z.literal(1), lastLessonId: id.nullable(),
  lessons: z.record(id, LessonProgressSchema).refine((lessons) => Object.keys(lessons).length <= 100),
}).strict();
export type CourseProgress = z.infer<typeof CourseProgressSchema>;
export const emptyCourseProgress = (): CourseProgress => ({ schemaVersion: 1, lastLessonId: null, lessons: {} });
export function courseStorageKey(uid: string | null, examId: ExamId = "az104") {
  if (uid !== null && !/^[A-Za-z0-9_-]{1,128}$/.test(uid)) throw new Error("Invalid learning account identity.");
  ExamIdSchema.parse(examId);
  return `${examId === "az104" ? "az104-networking-course" : "sc900-course"}:v1:${uid ? `account:${uid}` : "guest"}`;
}
export function readCourseProgress(storage: Pick<Storage, "getItem">, key: string) {
  try {
    const raw = storage.getItem(key);
    return { progress: raw ? CourseProgressSchema.parse(JSON.parse(raw)) : emptyCourseProgress(), writable: true, warning: null };
  } catch {
    return {
      progress: emptyCourseProgress(), writable: false,
      warning: "Saved learning progress could not be read. It has been left untouched; new changes stay in memory in this tab.",
    };
  }
}
export type CourseAction =
  | { type: "open"; lessonId: string }
  | { type: "study"; lessonId: string; studied: boolean }
  | { type: "bookmark"; lessonId: string }
  | { type: "check"; lessonId: string; checkpointId: string; selectedIds: string[] };

export function currentLessonProgress(progress: CourseProgress, lesson: CourseLesson): LessonProgress {
  const previous = progress.lessons[lesson.id];
  if (previous?.revision === lesson.revision) return previous;
  return { revision: lesson.revision, studiedAt: null, bookmarked: previous?.bookmarked ?? false, answers: {} };
}
export function reduceCourseProgress(progress: CourseProgress, course: Course, action: CourseAction, now = Date.now()): CourseProgress {
  CourseProgressSchema.parse(progress);
  const lesson = course.modules.flatMap((module) => module.lessons).find((lesson) => lesson.id === action.lessonId);
  if (!lesson) throw new Error("This lesson is not in the current course.");
  if (action.type === "open") return { ...progress, lastLessonId: lesson.id };
  let next = currentLessonProgress(progress, lesson);
  if (action.type === "study") next = { ...next, studiedAt: action.studied ? now : null };
  else if (action.type === "bookmark") next = { ...next, bookmarked: !next.bookmarked };
  else {
    const checkpoint = lesson.checkpoints.find((item) => item.id === action.checkpointId);
    if (!checkpoint || !action.selectedIds.length ||
        new Set(action.selectedIds).size !== action.selectedIds.length ||
        (checkpoint.kind === "single" && action.selectedIds.length !== 1) ||
        action.selectedIds.some((id) => !checkpoint.choices.some((choice) => choice.id === id))) {
      throw new Error("Select valid choices for this checkpoint.");
    }
    next = { ...next, answers: { ...next.answers, [checkpoint.id]: {
      selectedIds: [...action.selectedIds], checkedAt: now,
      attempts: Math.min(100000, (next.answers[checkpoint.id]?.attempts ?? 0) + 1),
    } } };
  }
  return CourseProgressSchema.parse({ ...progress, lastLessonId: lesson.id, lessons: { ...progress.lessons, [lesson.id]: next } });
}
