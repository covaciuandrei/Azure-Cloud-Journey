import type { PracticeAttempt } from "../engine.js";
import { recentStatistics } from "../statistics.js";

export function Statistics({ attempts, signedIn }: { attempts: PracticeAttempt[]; signedIn: boolean }) {
  const stats = recentStatistics(attempts);
  return <section className="statistics-page">
    <div className="page-heading"><div><h1>Your statistics</h1>
      <p className="muted">Based on the last 20 completed sessions {signedIn ? "in your account" : "in this browser"}.</p>
    </div></div>
    {!stats.sessions ? <p className="empty-state">Complete a practice session or exam to see your results here.</p> : <>
      <dl className="personal-statistics">
        <div><dt>Completed sessions</dt><dd>{stats.sessions}</dd></div>
        <div><dt>Practice / exams</dt><dd>{stats.practice} / {stats.exams}</dd></div>
        <div className="stat-accuracy"><dt>Accuracy on answered automatic questions</dt><dd>{stats.accuracy === null ? "Not available" : `${stats.accuracy}%`}</dd></div>
        <div><dt>Correct / answered</dt><dd>{stats.correct} / {stats.answered}</dd></div>
      </dl>
      <p className="statistics-note muted">{stats.unanswered} automatic questions were left unanswered.
        {" "}{stats.provisional} provisional questions and {stats.manual} manual self-checks are excluded from accuracy.</p>
    </>}
    {!signedIn && <p className="muted">Google sign-in gives you a separate account history and cross-device progress.</p>}
  </section>;
}
