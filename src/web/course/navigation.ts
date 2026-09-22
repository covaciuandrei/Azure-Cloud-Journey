import type { ExamId } from "../../domain/exams.js";

export interface LearningRoute {
  examId?: ExamId;
  section: "exams" | "welcome" | "learn" | "practice";
  lessonId: string | null;
  error: string | null;
}
export function parseLearningRoute(hash: string): LearningRoute {
  if (hash === "#/sc900" || hash.startsWith("#/sc900/")) {
    const local = hash === "#/sc900" ? "#home" : `#${hash.slice("#/sc900/".length)}`;
    const route = parseLearningRoute(local);
    if (route.section === "exams" || local.startsWith("#/")) {
      return { examId: "sc900", section: "welcome", lessonId: null, error: "That SC-900 page link is not recognized." };
    }
    return { ...route, examId: "sc900" };
  }
  if (!hash || hash === "#" || hash === "#exams") return { section: "exams", lessonId: null, error: null };
  if (hash === "#home") return { section: "welcome", lessonId: null, error: null };
  if (hash === "#practice") return { section: "practice", lessonId: null, error: null };
  if (hash === "#learn") return { section: "learn", lessonId: null, error: null };
  const lesson = /^#learn\/([a-z][a-z0-9-]{2,79})$/.exec(hash);
  if (lesson) return { section: "learn", lessonId: lesson[1]!, error: null };
  return { section: "welcome", lessonId: null, error: "That page link is not recognized. Choose Learn or Practice to continue." };
}
