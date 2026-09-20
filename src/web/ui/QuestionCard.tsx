import { useId, type KeyboardEvent, type ReactNode } from "react";
import { RichContent } from "../components/RichContent.js";
import { gradeResponse, type PracticeResponse, type SelfAssessment } from "../engine.js";
import { answerImageContent, splitStandaloneImages } from "../image-presentation.js";
import type { StudyDocument, StudyRepository } from "../types.js";
import { AnswerDetails, DiscussionBelow } from "./AnswerDetails.js";
import { topicLabel } from "../../domain/topics.js";
import { useExplanation } from "./useExplanation.js";

export function AnswerStatus({ provisional }: { provisional: boolean }) {
  return <span className={`answer-status status-${provisional ? "unresolved" : "source-default"}`}>
    {provisional ? "Provisional" : "Answer key"}</span>;
}

export interface QuestionCardProps {
  document: StudyDocument;
  order: string[];
  response: PracticeResponse;
  repository: StudyRepository;
  revealed: boolean;
  locked?: boolean;
  onSelect?: (id: string) => void;
  onNote?: (note: string) => void;
  onReveal?: () => void;
  onCheck?: () => void;
  onSelfAssess?: (value: SelfAssessment) => void;
  onFlag?: () => void;
  compact?: boolean;
  deferAnswerReveal?: boolean;
  sessionControls?: ReactNode;
}

export function QuestionCard({
  document, order, response, repository, revealed, locked = false,
  onSelect, onReveal, onCheck, onSelfAssess, onFlag, deferAnswerReveal = false, sessionControls,
}: QuestionCardProps) {
  const { question, answers } = document;
  const learning = useExplanation(document, repository, revealed);
  const groupId = useId();
  const manual = question.readiness.grading === "manual";
  const prompt = manual ? splitStandaloneImages(question.prompt) : { body: question.prompt, images: [] };
  const answerImages = manual ? answerImageContent(answers) : [];
  const compare = manual && (prompt.images.length > 0 || answerImages.length > 0);
  const comparedImages = new Set(compare ? answerImages.flatMap((block) => block.type === "image" ? [block.assetId] : []) : []);
  const correct = new Set(answers.effectiveAnswer.value.kind === "option-selection" ? answers.effectiveAnswer.value.optionIds : []);
  const teachingKey = learning.value?.explanation.correctOptionIds;
  const recordedKeyChanged = Boolean(teachingKey && (teachingKey.length !== correct.size || teachingKey.some((id) => !correct.has(id))));
  const teachingUncertain = learning.value && ["conditional", "outdated", "incomplete"].includes(learning.value.explanation.status);
  const provisional = answers.provisional || Boolean(teachingUncertain);
  const visibleKey = recordedKeyChanged ? new Set(teachingKey!) : correct;
  const result = revealed ? gradeResponse(document, response) : null;
  const number = question.sources[0]?.questionNumber;
  const content = (blocks: typeof question.prompt) =>
    <RichContent blocks={blocks} question={question} repository={repository} releaseId={document.releaseId} />;
  const checkOnEnter = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Enter" || event.repeat || event.altKey || event.ctrlKey || event.metaKey ||
        event.shiftKey || event.defaultPrevented || revealed || locked || deferAnswerReveal ||
        response.selectedIds.length === 0 || !(onCheck ?? onReveal)) return;
    if (!(event.target instanceof HTMLInputElement) ||
        (event.target.type !== "radio" && event.target.type !== "checkbox")) return;
    event.preventDefault();
    (onCheck ?? onReveal)?.();
  };
  return <article className="question-card" aria-label={`Question ${number}`} onKeyDown={checkOnEnter}>
    <header className="question-header">
      <div className="question-meta"><strong>Question {number}</strong>
        <span>{manual ? "Image / self-check" : question.kind === "multi-select" ? "Select all that apply" : "Select one answer"}</span>
        {question.sources.length > 1 && <span>Also listed as {question.sources.slice(1).map((source) => `#${source.questionNumber}`).join(", ")}</span>}
        {provisional && <AnswerStatus provisional />}
        {document.topicIds?.map((topic) => <span className="question-topic" key={topic}>{topicLabel(topic)}</span>)}
      </div>
      {onFlag && <button className={`button button-secondary button-small ${response.flagged ? "flag-selected" : ""}`}
        onClick={onFlag} aria-pressed={response.flagged}>{response.flagged ? "Flagged" : "Flag for review"}</button>}
    </header>
    {document.retirement && <div className="notice" role="note">
      <strong>Retired from the current question bank</strong>
      <p>{document.retirement.reason}</p>
      <p>This question is retained only for this saved session. Your recorded score is unchanged.
        Start a new session to practice the current question bank.</p>
    </div>}
    <div className="question-body">
      <div className={`study-content-grid ${compare ? "image-study-layout" : "text-study-layout"} ${revealed ? "is-revealed" : ""} ${sessionControls ? "has-controls" : ""}`}>
      {sessionControls && <div className="session-controls-slot">{sessionControls}</div>}
      <div className="question-column">
      <div className="question-prompt">{content(prompt.body)}</div>
      {compare && <section className="image-comparison" aria-label="Question and source answer image comparison">
        <div className="image-comparison-panel"><h3>Question</h3>
          {prompt.images.length ? content(prompt.images) : <p>The question material is shown above.</p>}
        </div>
        <div className="image-comparison-panel answer-image-panel"><h3>Source answer</h3>
          {revealed ? <>
            {learning.value?.explanation.status === "corrected" && <p className="teaching-caveat">
              This is the original marked image. Follow the corrected reasoning in the explanation.
            </p>}
            {answerImages.length ? content(answerImages) : <p>No separate answer image was supplied. See the explanation below.</p>}
            {answers.provisional && <AnswerStatus provisional />}
          </> : <div className="answer-concealed">
            {deferAnswerReveal ? <p>Available after you finish the exam.</p> :
              onReveal ? <><button className="button button-primary" onClick={onReveal}>Reveal answer</button>
                <p>Compare after deciding on your answer. No typing needed.</p></> :
                <p>Reveal the answer when you are ready to compare.</p>}
          </div>}
        </div>
      </section>}
      {order.length > 0 && <fieldset className="choices"><legend className="sr-only">
        {question.kind === "multi-select" ? "Select all that apply" : "Select one answer"}</legend>
        {order.map((id, index) => {
          const option = question.options.find((item) => item.id === id);
          if (!option) throw new Error(`Question ${number} has an invalid option order.`);
          const selected = response.selectedIds.includes(id);
          const isCorrect = revealed && visibleKey.has(id);
          const isWrong = revealed && selected && !visibleKey.has(id);
          return <label className={`choice ${selected ? "choice-selected" : ""} ${isCorrect ? "choice-correct" : ""} ${isWrong ? "choice-wrong" : ""}`} key={id}>
            <input type={question.kind === "multi-select" ? "checkbox" : "radio"} name={`answer-${question.id}`}
              checked={selected} disabled={locked || !onSelect} onChange={() => onSelect?.(id)}
              aria-label={`Option ${String.fromCharCode(65 + index)}`} aria-describedby={`${groupId}-${index}`} />
            <span className="choice-letter">{String.fromCharCode(65 + index)}.</span>
            <div className="choice-content" id={`${groupId}-${index}`}>{content(option.content)}</div>
            {isCorrect && <span className="choice-result">{recordedKeyChanged ? "Current answer" : provisional ? "Provisional key" : "Correct"}</span>}
            {isWrong && <span className="choice-result">Your answer</span>}
          </label>;
        })}
      </fieldset>}
      {!question.shuffle.allowed && order.length > 0 &&
        <p className="small muted">Source order is kept because the wording depends on it.</p>}
      {onReveal && !revealed && !compare && !deferAnswerReveal &&
        <button className="button button-secondary reveal-text" onClick={onReveal}>{manual ? "Reveal answer" : "Show answer"}</button>}
      {manual && response.note && <details className="details-box"><summary>Previously saved response</summary>
        <p className="preserve-lines">{response.note}</p></details>}
      {revealed && recordedKeyChanged && <p className="teaching-caveat">This saved question used an older key.
        Its recorded score is preserved; the highlighted current answer and explanation show the corrected guidance.</p>}
      {revealed && result && !manual && <div className={`feedback feedback-${provisional || recordedKeyChanged ? "provisional" : result.outcome}`} role="status">
        <strong>{recordedKeyChanged ? "Recorded result preserved; the answer key has changed" : result.outcome === "unanswered" ? "Answer shown" :
          provisional ? result.outcome === "correct" ? "Matches the provisional key" : "Does not match the provisional key" :
            result.outcome === "correct" ? "Correct" : "Incorrect"}</strong>
        <AnswerStatus provisional={provisional} />
      </div>}
      {revealed && manual && onSelfAssess && <div className="self-assessment">
        <span>Self-check</span>
        <button className="button button-secondary button-small self-assess-correct" aria-pressed={response.selfAssessment === "correct"}
          onClick={() => onSelfAssess("correct")}>Correct</button>
        <button className="button button-secondary button-small self-assess-incorrect" aria-pressed={response.selfAssessment === "incorrect"}
          onClick={() => onSelfAssess("incorrect")}>Incorrect</button>
        <button className="text-button" onClick={() => onSelfAssess("skip")}>Leave unmarked</button>
        <small>Not part of the automatic score.</small>
      </div>}
      </div>
      {revealed && <aside className="explanation-column">
        <AnswerDetails document={document} repository={repository} comparedImages={comparedImages} order={order} learning={learning} />
      </aside>}
      </div>
    </div>
    {revealed && <DiscussionBelow document={document} repository={repository} />}
  </article>;
}
