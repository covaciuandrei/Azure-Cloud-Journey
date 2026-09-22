import { Icon } from "../components/Icon.js";
import type { Course } from "../../domain/course.js";
import type { ExamId } from "../../domain/exams.js";
import type { ExamAvailability } from "../exam-availability.js";
import { SC900_UNAVAILABLE_NOTICE } from "../../domain/examAvailability.js";

export function ExamSelection({ onSelect, course = null, sc900Availability }: {
  onSelect: (examId: ExamId) => void; course?: Course | null;
  sc900Availability?: ExamAvailability;
}) {
  const full = course?.id === "az104";
  return <section className="exam-selection" aria-labelledby="exam-selection-title">
    <header className="exam-selection-heading">
      <span className="workspace-eyebrow">AZURE CLOUD JOURNEY</span>
      <h1 id="exam-selection-title">Your next step in Azure starts here.</h1>
      <p>Choose your exam and make room for understanding. Learn the reasoning, put it into practice, and build on what you know.</p>
    </header>
    <div className="exam-selection-layout">
      <article className="exam-card" aria-labelledby="az104-title">
        <div className="exam-card-top">
          <span className="exam-card-symbol"><Icon name="book" size={28} /></span>
          <span className="exam-available"><span />Available to study</span>
        </div>
        <span className="exam-code">AZ-104</span>
        <h2 id="az104-title">Azure Administrator</h2>
        <p>A dedicated workspace for your Azure administration study, from {full ? "all five official domains" : "guided concepts"} to exam-style practice.</p>
        <ul className="exam-capabilities">
          <li><Icon name="book" size={18} /><span><strong>Learn with context</strong>{full ? "Guided lessons across five domains and worked examples" : "Guided networking lessons and worked examples"}</span></li>
          <li><Icon name="grid" size={18} /><span><strong>Put your knowledge to work</strong>Topic-based questions and timed mock exams</span></li>
          <li><Icon name="history" size={18} /><span><strong>Keep moving forward</strong>Saved sessions, results and learning progress</span></li>
        </ul>
        <div className="exam-card-action">
          <button className="button button-primary" onClick={() => onSelect("az104")}>Select AZ-104<Icon name="arrow" size={18} /></button>
          <span>Opens your Learn and Practice workspace</span>
        </div>
      </article>
      <article className="exam-card" aria-labelledby="sc900-title">
        <div className="exam-card-top">
          <span className="exam-card-symbol"><Icon name="book" size={28} /></span>
          <span className={sc900Availability?.status === "available" ? "exam-available" : "muted"}>
            {sc900Availability?.status === "available" ? "Available to study" : "Not yet available"}
          </span>
        </div>
        <span className="exam-code">SC-900</span>
        <h2 id="sc900-title">Security, Compliance, and Identity Fundamentals</h2>
        <p>{sc900Availability?.notice ?? SC900_UNAVAILABLE_NOTICE}</p>
        <p>The planned original course covers four domains. Its announced outline is effective October 21, 2026, reviewed September 22, 2026.</p>
        <p>Once approved: separate learning progress, question history and offline materials. The 40-question, 45-minute mock is an app practice format, not the real exam's exact question count.</p>
        <div className="exam-card-action">
          <button className="button button-primary" disabled={sc900Availability?.status !== "available"}
            onClick={() => onSelect("sc900")}>Select SC-900<Icon name="arrow" size={18} /></button>
          <span>Activation requires the approved course and complete reviewed bank</span>
        </div>
      </article>
      <aside className="exam-study-path" aria-labelledby="exam-study-path-title">
        <span className="workspace-eyebrow">ONE CLEAR STEP AT A TIME</span>
        <h2 id="exam-study-path-title">Understanding first.<br />Confidence through practice.</h2>
        <ol>
          <li><span className="exam-step-number" aria-hidden="true">01</span><div><h3>Make the concepts click</h3><p>Start with a guided lesson. Work through examples and check your understanding as you go.</p></div></li>
          <li><span className="exam-step-number" aria-hidden="true">02</span><div><h3>Find your focus</h3><p>Practise by topic or try a timed mock exam. Review the reasoning behind each answer.</p></div></li>
          <li><span className="exam-step-number" aria-hidden="true">03</span><div><h3>Pick up where you left off</h3><p>Return to your lessons and saved sessions. Your progress stays with your workspace.</p></div></li>
        </ol>
      </aside>
    </div>
    <div className="exam-selection-notes">
      <p><Icon name="book" size={18} /><span>{full
        ? <><strong>Five domains, one course.</strong> {course.modules.length} modules and {course.modules.reduce((sum, module) => sum + module.lessons.length, 0)} lessons with mapped objectives. No guarantee of exam coverage or readiness.</>
        : course ? <><strong>A focused learning pilot.</strong> Guided lessons currently cover networking, not every AZ-104 domain.</>
          : <><strong>Know your learning scope.</strong> Open the course to see its published domains and lessons.</>}</span></p>
      <p><Icon name="download" size={18} /><span><strong>Your pace, your place.</strong> Start as a guest and use Offline &amp; data to download your study materials.</span></p>
    </div>
  </section>;
}
