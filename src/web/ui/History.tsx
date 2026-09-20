import type { PracticeAttempt } from "../engine.js";

export function History({ attempts, onOpen, onClear, signedIn = false }: {
  attempts: PracticeAttempt[]; onOpen: (attempt: PracticeAttempt) => void; onClear?: () => void; signedIn?: boolean;
}) {
  return <section className="history-page">
    <div className="page-heading"><div><h1>History</h1><p className="muted">The last 20 completed sessions {signedIn ? "in your account" : "saved in this browser"}.</p></div>
      {attempts.length > 0 && onClear && <button className="button button-secondary" onClick={onClear}>Clear history</button>}
    </div>
    {!attempts.length ? <p className="empty-state">No completed sessions yet.</p> :
      <div className="table-scroll history-scroll" role="region" aria-label="Completed sessions" tabIndex={0}><table className="history-table">
        <thead><tr><th scope="col">Session</th><th scope="col">Questions</th><th scope="col">Automatic marking</th><th scope="col">Completed</th><th scope="col"><span className="sr-only">Open review</span></th></tr></thead>
        <tbody>{attempts.map((attempt) => <tr key={attempt.id}>
          <td><span className="history-mode">{attempt.mode === "exam" ? "Exam" : "Practice"}</span></td><td>{attempt.size}</td>
          <td className="history-score">{attempt.score?.automatic.total ? `${attempt.score.automatic.correct} / ${attempt.score.automatic.total} correct` : "Self-check only"}</td>
          <td>{new Date(attempt.finishedAt ?? attempt.startedAt).toLocaleString(undefined, {
            month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
          })}</td><td><button className="button button-secondary button-small" onClick={() => onOpen(attempt)}>Review</button></td>
        </tr>)}</tbody>
      </table></div>}
  </section>;
}
