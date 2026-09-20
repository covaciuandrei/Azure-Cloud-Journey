import { useId, useState } from "react";
import { Discussion } from "../components/Discussion.js";
import { RichContent } from "../components/RichContent.js";
import { hasNonImageContent } from "../image-presentation.js";
import type { StudyDocument, StudyRepository } from "../types.js";
import { compactJsonParagraphs } from "./codePresentation.js";
import type { useExplanation } from "./useExplanation.js";

function TeachingText({ text }: { text: string }) {
  return <div className="teaching-text">{text.split(/(```[\s\S]*?```)/g).filter(Boolean).map((block, index) => {
    if (block.startsWith("```")) {
      return <pre key={index}><code>{block.replace(/^```[^\n]*\n?/, "").replace(/```$/, "").trim()}</code></pre>;
    }
    return <p key={index}>{block.split(/(`[^`\n]+`)/g).map((part, partIndex) =>
      part.startsWith("`") && part.endsWith("`") ? <code key={partIndex}>{part.slice(1, -1)}</code> : part)}</p>;
  })}</div>;
}

const verdicts = {
  correct: "Correct", incorrect: "Not correct here", conditional: "Depends on the assumptions", unresolved: "Cannot establish from this question",
};

export function AnswerDetails({ document, repository, comparedImages, order, learning }: {
  document: StudyDocument; repository: StudyRepository; comparedImages: ReadonlySet<string>;
  order: string[]; learning: ReturnType<typeof useExplanation>;
}) {
  const { question, answers } = document;
  const explanation = learning.value?.explanation;
  const authors = answers.originalAnswers.filter((answer) =>
    comparedImages.size === 0 ? answer.explanation.length > 0 : hasNonImageContent(answer.explanation));
  return <section className="explanation-panel" aria-label="Explanation">
    <h2>Explanation</h2>
    {learning.error ? <div className="notice notice-error" role="alert"><p>{learning.error}</p>
      <button className="button button-secondary button-small" onClick={learning.retry}>Retry explanation</button></div> :
      !explanation ? <p className="muted" role="status">Loading teaching explanation...</p> : <>
        <h3 className="teaching-concept">{explanation.concept}</h3>
        {explanation.caveat && <div className="teaching-caveat">
          <strong>{explanation.status === "corrected" ? "Correction to the source answer" :
            explanation.status === "outdated" ? "Historical question" :
              explanation.status === "incomplete" ? "Missing or inconsistent information" : "Important qualification"}</strong>
          <TeachingText text={explanation.caveat} />
        </div>}
        <TeachingText text={explanation.summary} />
        <h4>Reasoning</h4>
        <ol className="teaching-steps">{explanation.reasoning.map((step, index) =>
          <li key={index}><TeachingText text={step} /></li>)}</ol>
        {explanation.options.length > 0 && <>
          <h4>Each answer choice</h4>
          <div className="choice-explanations">{order.map((id, index) => {
            const choice = explanation.options.find((item) => item.optionId === id);
            const option = question.options.find((item) => item.id === id);
            if (!choice || !option) throw new Error("The teaching explanation is missing an answer choice.");
            return <section className={`choice-explanation verdict-${choice.verdict}`} key={id}>
              <h5>Option {String.fromCharCode(65 + index)}: {
                choice.verdict === "correct" && explanation.status === "outdated" ? "Historical expected answer" :
                  choice.verdict === "correct" && explanation.status === "conditional" ? "Correct under the stated assumptions" :
                    verdicts[choice.verdict]}</h5>
              <RichContent blocks={option.content} question={question} repository={repository} releaseId={document.releaseId} />
              <TeachingText text={choice.explanation} />
            </section>;
          })}</div>
        </>}
        {explanation.answerParts.map((part, index) => <section className="answer-part" key={index}>
          <h4>{part.label}</h4>
          <p><strong>{part.answer}</strong></p>
          <TeachingText text={part.explanation} />
          {part.alternatives.length > 0 && <details>
            <summary>Other choices and their limitations</summary>
            {part.alternatives.map((alternative, alternativeIndex) => <div key={alternativeIndex}>
              <p><strong>{alternative.text}</strong></p><TeachingText text={alternative.explanation} />
            </div>)}
          </details>}
        </section>)}
        <div className="teaching-takeaway"><h4>Remember</h4><TeachingText text={explanation.takeaway} /></div>
        <details className="teaching-sources"><summary>Microsoft documentation</summary>
          {explanation.sources.map((source) => <div key={source.url}>
            <a href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a>
            <p>{source.supports}</p>
          </div>)}
        </details>
      </>}
    {authors.length > 0 && <details className="author-note"><summary>Original author note</summary>
      {authors.map((answer) => <RichContent key={answer.sourceOccurrenceId}
        blocks={compactJsonParagraphs(answer.explanation)} question={question} repository={repository}
        releaseId={document.releaseId} omitImageAssetIds={comparedImages} />)}
    </details>}
  </section>;
}

export function DiscussionBelow({ document, repository }: { document: StudyDocument; repository: StudyRepository }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (document.discussionEnabled === false || document.question.commentCount === 0) return null;
  return <section className="discussion-below" aria-label="Question discussion">
    <button className="discussion-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
      <span aria-hidden="true">{open ? "\u25be" : "\u25b8"}</span> Discussion ({document.question.commentCount})
    </button>
    <div id={id}>{open && <Discussion question={document.question} repository={repository} releaseId={document.releaseId} />}</div>
  </section>;
}
