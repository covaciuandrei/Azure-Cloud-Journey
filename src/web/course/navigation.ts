export interface LearningRoute {
  section: "exams" | "welcome" | "learn" | "practice";
  lessonId: string | null;
  error: string | null;
}
export function parseLearningRoute(hash: string): LearningRoute {
  if (!hash || hash === "#" || hash === "#exams") return { section: "exams", lessonId: null, error: null };
  if (hash === "#home") return { section: "welcome", lessonId: null, error: null };
  if (hash === "#practice") return { section: "practice", lessonId: null, error: null };
  if (hash === "#learn") return { section: "learn", lessonId: null, error: null };
  const lesson = /^#learn\/([a-z][a-z0-9-]{2,79})$/.exec(hash);
  if (lesson) return { section: "learn", lessonId: lesson[1]!, error: null };
  return { section: "welcome", lessonId: null, error: "That page link is not recognized. Choose Learn or Practice to continue." };
}
