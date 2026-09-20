import type { PracticeAttempt } from "./engine.js";

export function recentStatistics(history: readonly PracticeAttempt[]) {
  const completed = history.filter((attempt) => attempt.status === "completed" && attempt.score).slice(0, 20);
  const totals = completed.reduce((total, attempt) => {
    const score = attempt.score!;
    total.correct += score.automatic.correct;
    total.incorrect += score.automatic.incorrect;
    total.unanswered += score.automatic.unanswered;
    total.provisional += score.provisional.total;
    total.manual += score.manual.total;
    return total;
  }, { correct: 0, incorrect: 0, unanswered: 0, provisional: 0, manual: 0 });
  const answered = totals.correct + totals.incorrect;
  return {
    sessions: completed.length,
    exams: completed.filter((item) => item.mode === "exam").length,
    practice: completed.filter((item) => item.mode === "free").length,
    ...totals, answered,
    accuracy: answered ? Math.round(totals.correct / answered * 100) : null,
  };
}
