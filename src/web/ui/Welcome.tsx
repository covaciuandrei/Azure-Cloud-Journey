import type { Course } from "../../domain/course.js";
import { Icon } from "../components/Icon.js";
import { currentLessonProgress, type CourseProgress } from "../course/progress.js";
import { examConfig, type ExamId } from "../../domain/exams.js";

export function Welcome({ course, progress, questionCount, onLearn, onPractice, examId = "az104" }: {
  course: Course | null;
  progress: CourseProgress;
  questionCount: number | undefined;
  onLearn: (lessonId?: string) => void;
  onPractice: () => void;
  examId?: ExamId;
}) {
  const exam = examConfig(examId);
  const lessons = course?.modules.flatMap((module) => module.lessons) ?? [];
  const last = lessons.find((lesson) => lesson.id === progress.lastLessonId);
  const studied = lessons.filter((lesson) => currentLessonProgress(progress, lesson).studiedAt !== null).length;
  const full = course?.id === "az104";
  return <section className="study-welcome">
    <header className="welcome-heading">
      <span className="workspace-eyebrow">{exam.code} / {exam.title.toUpperCase()}</span>
      <h1>Understand Azure. Then put it into practice.</h1>
      <p>Build the mental model, work through an example, and put your knowledge to the test. One clear step at a time.</p>
    </header>
    {last && <div className="welcome-continue">
      <span className="welcome-continue-icon"><Icon name="book" size={22} /></span>
      <div><span className="workspace-eyebrow">PICK UP WHERE YOU LEFT OFF</span><strong>{last.title}</strong>
        <p>{studied} of {lessons.length} lessons marked studied on this device.</p></div>
      <button className="button button-secondary" onClick={() => onLearn(last.id)}>Continue learning<Icon name="arrow" size={16} /></button>
    </div>}
    <div className="study-entry-options">
      <article className="welcome-learn">
        <div className="welcome-card-top"><span className="welcome-card-icon"><Icon name="book" size={24} /></span><span className="workspace-eyebrow">LEARN THE REASONING</span></div>
        <h2>Learn {exam.code}</h2>
        <p>{examId === "sc900" ? "Build foundations in security, identity, Microsoft security services, and compliance through school and document scenarios."
          : full ? "Learn identity and governance, storage, compute, networking, and monitoring and recovery through the same school-application story."
          : "Start with packets and IP addresses. Build up to DNS, routing, security and troubleshooting through the same school-network story."}</p>
        <ul className="welcome-features"><li><Icon name="check" size={16} />Worked examples from first principles</li><li><Icon name="check" size={16} />Interactive tools and explained checkpoints</li><li><Icon name="check" size={16} />An outline that keeps your place clear</li></ul>
        <div className="welcome-card-footer"><span>{course ? `${course.modules.length} modules / ${lessons.length} lessons` : "Learning materials loading"}</span>
          <button className="button button-primary" onClick={() => onLearn()}>{examId === "sc900" ? "Open SC-900 course" : full ? "Open AZ-104 course" : course ? "Open networking course" : "Open learning materials"}<Icon name="arrow" size={17} /></button></div>
      </article>
      <article className="welcome-practice">
        <div className="welcome-card-top"><span className="welcome-card-icon"><Icon name="grid" size={24} /></span><span className="workspace-eyebrow">PUT IT INTO PRACTICE</span></div>
        <h2>Practice &amp; exams</h2>
        <p>Browse the question library, focus on selected topics, or simulate an exam. Understand the reasoning behind each answer.</p>
        <ul className="welcome-features"><li><Icon name="check" size={16} />Free practice in sets of 10, 20, 30 or 40</li><li><Icon name="check" size={16} />40-question practice exams with a {exam.mockDurationMinutes}-minute timer</li><li><Icon name="check" size={16} />Your saved sessions, results and history</li></ul>
        <div className="welcome-card-footer"><span>{questionCount === undefined ? "Topic-based practice" : `${questionCount} active questions`}</span>
          <button className="button button-secondary" onClick={onPractice}>Open practice workspace<Icon name="arrow" size={17} /></button></div>
      </article>
    </div>
    <div className="welcome-notes">
      <div><Icon name="book" size={20} /><p><strong>Start with understanding.</strong> {examId === "sc900"
        ? "This course follows the announced outline effective October 21, 2026, reviewed September 22, 2026. It is not a verified prior-outline snapshot. Forty questions is this app's practice format, not the real exam's exact question count."
        : full
        ? "The course maps all five official domains to lessons and worked applications. It does not guarantee exam coverage or readiness."
        : course ? "This learning pilot covers networking, not every AZ-104 domain. Official references are linked throughout."
          : "Open the course to see its published scope and official references."}</p></div>
      <div><Icon name="download" size={20} /><p><strong>Study at your own pace.</strong> Use Offline &amp; data to save the app for later. Learning checkpoints stay separate from exam statistics.</p></div>
    </div>
  </section>;
}
