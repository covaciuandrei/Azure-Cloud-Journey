import type { PracticeAttempt } from "../engine.js";
import type { StudyCatalog } from "../types.js";
import { Icon } from "../components/Icon.js";
import { examConfig, examIdOf } from "../../domain/exams.js";
import { SC900_UNAVAILABLE_DISCUSSIONS_NOTICE } from "../../domain/sc900Scope.js";

export function Home({ catalog, activeAttempt, onPractice, onExam, onLibrary, onResume, signedIn = false }: {
  catalog: StudyCatalog; activeAttempt: PracticeAttempt | null;
  onPractice: () => void; onExam: () => void; onLibrary: () => void;
  onResume: (attempt: PracticeAttempt) => void;
  signedIn?: boolean;
}) {
  const exam = examConfig(examIdOf(catalog));
  return <section className="landing-page">
    <div className="landing-heading"><h1>{exam.code} practice</h1>
      <p>{catalog.discussionScope ? SC900_UNAVAILABLE_DISCUSSIONS_NOTICE : "Practice questions, explanations, and source discussions. Choose a mode to begin."}</p></div>
    {activeAttempt && <div className="landing-resume">
      <div><strong>Continue your session</strong><p>{activeAttempt.mode === "exam" ? "Exam" : "Practice"}:
        {" "}question {activeAttempt.currentIndex + 1} of {activeAttempt.size}.</p></div>
      <button className="button button-primary" onClick={() => onResume(activeAttempt)}>Resume session</button>
    </div>}
    <div className="landing-options">
      <article><span className="practice-mode-icon"><Icon name="bolt" size={22} /></span>
        <h2>Practice</h2><p>10, 20, 30, or 40 questions. Reveal feedback after each answer, with no time limit.</p>
        <button className="button button-primary" onClick={onPractice}>Set up practice</button></article>
      <article><span className="practice-mode-icon"><Icon name="clock" size={22} /></span>
        <h2>Exam</h2><p>{exam.mockQuestionCount} questions in {exam.mockDurationMinutes} minutes. Review your answers and explanations when the session ends.</p>
        <button className="button button-secondary" onClick={onExam}>Set up exam</button></article>
      <article><span className="practice-mode-icon"><Icon name="book" size={22} /></span>
        <h2>Question library</h2><p>Search all {catalog.counts.questions} questions and open {catalog.discussionScope ? "their reviewed explanations" : "any question or discussion"} directly.</p>
        <button className="button button-secondary" onClick={onLibrary}>Browse questions</button></article>
    </div>
    <dl className="landing-facts">
      <div><dt>Question bank</dt><dd>{catalog.counts.questions} questions</dd></div>
      <div><dt>Automatic marking</dt><dd>{catalog.counts.automatic} questions</dd></div>
      <div><dt>Image / self-check</dt><dd>{catalog.counts.manual} questions</dd></div>
      <div><dt>Progress</dt><dd>{signedIn ? "Account sync + device cache" : "Saved in this browser"}</dd></div>
    </dl>
    <p className="landing-note">Answer choices are shuffled where appropriate. Provisional answers and manual self-checks are kept separate from automatic scores.</p>
  </section>;
}
