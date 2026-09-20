import { useEffect, useRef } from "react";
import { remainingSeconds, type PracticeScore } from "../engine.js";
import { QuestionCard } from "./QuestionCard.js";
import { answered, type StudyController } from "./useStudy.js";

const time = (seconds: number) =>
  `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;

function Results({ score }: { score: PracticeScore }) {
  return <section className="results-summary" aria-label="Session results">
    <h2>Results</h2>
    <div className="results-table-scroll" role="region" aria-label="Results by marking type" tabIndex={0}>
    <table className="results-table"><thead><tr><th scope="col">Marking</th><th scope="col">Correct</th><th scope="col">Incorrect</th><th scope="col">Unmarked</th><th scope="col">Total</th></tr></thead>
      <tbody>
        <tr><th scope="row">Automatic study keys</th><td>{score.automatic.correct}</td><td>{score.automatic.incorrect}</td><td>{score.automatic.unanswered}</td><td>{score.automatic.total}</td></tr>
        <tr><th scope="row">Provisional keys</th><td>{score.provisional.correct}</td><td>{score.provisional.incorrect}</td><td>{score.provisional.unanswered}</td><td>{score.provisional.total}</td></tr>
        <tr><th scope="row">Self-checks</th><td>{score.manual.correct}</td><td>{score.manual.incorrect}</td><td>{score.manual.unanswered}</td><td>{score.manual.total}</td></tr>
      </tbody>
    </table>
    </div>
    <p className="score-note">Provisional answers and self-checks are reported separately. Source-default keys are not independently verified.</p>
  </section>;
}

export function Session({ study }: { study: StudyController }) {
  const { attempt, documents, repository, now, act, requestFinish, openView } = study;
  const navigation = useRef<HTMLDivElement>(null);
  useEffect(() => {
    navigation.current?.querySelector<HTMLButtonElement>('[aria-current="step"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [attempt?.currentIndex, attempt?.id]);
  if (!attempt) return <p className="loading-panel" role="status">Opening session...</p>;
  const document = documents.find((item) => item.question.id === attempt.questionIds[attempt.currentIndex]);
  const response = document ? attempt.responses[document.question.id] : undefined;
  if (!document || !response) return <p className="loading-panel" role="status">Loading the saved questions...</p>;
  const finished = attempt.status === "completed";
  const manual = document.question.readiness.grading === "manual";
  const revealed = finished || (attempt.mode === "free" && response.submitted);
  const answeredCount = attempt.questionIds.filter((id) =>
    answered(attempt.responses[id], documents.find((item) => item.question.id === id)?.question.readiness.grading)).length;
  const next = () => {
    if (attempt.currentIndex === attempt.size - 1) {
      if (attempt.mode === "exam") requestFinish();
      else act({ type: "finish" });
    } else act({ type: "navigate", index: attempt.currentIndex + 1 });
    window.document.getElementById("study-question")?.scrollIntoView({ block: "start" });
  };
  const controls = <div className="session-controls">
    <div className="session-topline">
      <h1>{finished ? "Review" : attempt.mode === "exam" ? "Exam" : "Practice"}</h1>
      <div className="session-topline-actions">
        {!finished && attempt.mode === "exam" && <span className="timer"
          role="timer" aria-label="Time remaining">{time(remainingSeconds(attempt, now) ?? 0)}</span>}
        {finished ? <button className="button button-secondary button-small" onClick={() =>
          openView(attempt.mode === "exam" ? "exam" : "practice")}>New session</button> :
          <button className="button button-secondary button-small" onClick={requestFinish}>Finish session</button>}
      </div>
    </div>
    <p className="session-count">Question {attempt.currentIndex + 1} of {attempt.size}
      <span>{answeredCount} answered</span></p>
    <progress className="session-progress" value={answeredCount} max={attempt.size} aria-label="Answered questions" />
    <p className="small muted">Session data: {study.offlineMode ? "downloaded copy" : attempt.dataSource === "firebase" ? "Firestore" : "bundled snapshot"}.
      {" "}The data source stays fixed for this session.</p>
    <nav className="question-navigation" aria-label="Session questions">
      <div ref={navigation} className="question-grid">{attempt.questionIds.map((id, index) => {
        const item = attempt.responses[id];
        const grading = documents.find((entry) => entry.question.id === id)?.question.readiness.grading;
        const done = answered(item, grading);
        return <button key={id} onClick={() => act({ type: "navigate", index })}
          className={`${done ? "answered" : ""} ${item?.flagged ? "flagged" : ""}`}
          aria-current={index === attempt.currentIndex ? "step" : undefined}
          aria-label={`Question ${index + 1}${done ? ", answered" : ", unanswered"}${item?.flagged ? ", flagged" : ""}`}>
          {index + 1}{item?.flagged ? <span aria-hidden="true">*</span> : null}
        </button>;
      })}</div>
      <span className="navigator-legend">Filled: answered &nbsp; *: flagged</span>
    </nav>
    {finished && attempt.score && <Results score={attempt.score} />}
  </div>;
  return <section className="study-session">
    <div id="study-question" className="session-question">
      <QuestionCard key={document.question.id} document={document}
        order={attempt.optionOrders[document.question.id] ?? []} response={response}
        repository={repository} revealed={revealed} locked={revealed}
        onSelect={(optionId) => act({ type: "select", questionId: document.question.id, optionId })}
        onFlag={() => act({ type: "flag", questionId: document.question.id })}
        onSelfAssess={(value) => act({ type: "self-assess", questionId: document.question.id, value })}
        sessionControls={controls}
        {...(!finished && attempt.mode === "free"
          ? { onCheck: () => act({ type: "submit", questionId: document.question.id }) } : {})}
        {...(!finished && attempt.mode === "free" && manual && !response.submitted
          ? { onReveal: () => act({ type: "submit", questionId: document.question.id }) } : {})}
        deferAnswerReveal={!finished && attempt.mode === "exam"} />
    </div>
    <div className="session-actions">
      <button className="button button-secondary" disabled={attempt.currentIndex === 0}
        onClick={() => act({ type: "navigate", index: attempt.currentIndex - 1 })}>Previous</button>
      <div>
        {!finished && attempt.mode === "free" && !response.submitted &&
          <button className="button button-secondary" onClick={() => act({ type: "skip", questionId: document.question.id })}>Skip</button>}
        {!finished && attempt.mode === "free" && !manual && !response.submitted
          ? <button className="button button-primary" disabled={response.selectedIds.length === 0}
            title="Check the selected answer (Enter)"
            onClick={() => act({ type: "submit", questionId: document.question.id })}>Submit answer</button>
          : <>
            {!finished && attempt.mode === "exam" && manual && !response.submitted &&
              <button className="button button-secondary" onClick={() =>
                act({ type: "submit", questionId: document.question.id })}>Mark answered</button>}
            <button className="button button-primary" onClick={next}
              disabled={(finished && attempt.currentIndex === attempt.size - 1) ||
                (!finished && attempt.mode === "free" && !response.submitted)}>
              {!finished && attempt.currentIndex === attempt.size - 1 ? "Finish" : "Next"}
            </button>
          </>}
      </div>
    </div>
  </section>;
}
