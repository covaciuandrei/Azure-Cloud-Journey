import { useState } from "react";
import type { PracticeMode } from "../engine.js";
import type { StudyCatalog } from "../types.js";
import { TOPIC_IDS, matchesTopics, type TopicId } from "../../domain/topics.js";
import { TopicFilter } from "./TopicFilter.js";

export function Setup({ mode, catalog, onStart, initialTopics }: {
  mode: PracticeMode; catalog: StudyCatalog;
  initialTopics?: TopicId[];
  onStart: (mode: PracticeMode, count: number, automaticOnly: boolean, topics: TopicId[]) => void;
}) {
  const [count, setCount] = useState(10);
  const [automaticOnly, setAutomaticOnly] = useState(false);
  const [topics, setTopics] = useState<TopicId[]>(() => initialTopics ? [...initialTopics] : [...TOPIC_IDS]);
  const pool = catalog.questions.filter((question) => !automaticOnly || question.grading === "automatic");
  const available = pool.filter((question) => matchesTopics(question.topicIds, topics)).length;
  const requested = mode === "exam" ? 40 : count;
  const problem = !topics.length ? "Select at least one topic." : available < requested
    ? `Only ${available} questions match. ${mode === "exam" ? "Select more topics for a 40-question exam." : "Choose a smaller session or select more topics."}` : null;
  return <section className="setup-page">
    <div className="page-heading"><div><h1>{mode === "exam" ? "Practice exam" : "Practice"}</h1>
      <p>{mode === "exam" ? "40 questions in 60 minutes. Answers appear after you finish." :
        "Answer at your own pace and get feedback after each question."}</p></div></div>
    <form className="setup-form" onSubmit={(event) => {
      event.preventDefault();
      if (!problem) onStart(mode, count, automaticOnly, topics);
    }}>
      <div className="setup-session-options">
      {mode === "free" ? <fieldset className="setup-options"><legend>Number of questions</legend>
        <div className="size-options">{[10, 20, 30, 40].map((size) =>
          <label key={size}><input type="radio" name="session-size" value={size} checked={count === size} disabled={size > available}
            onChange={() => setCount(size)} /><span>{size}</span></label>)}</div>
      </fieldset> : <dl className="setup-facts"><div><dt>Questions</dt><dd>40</dd></div>
        <div><dt>Time limit</dt><dd>60 minutes</dd></div><div><dt>Feedback</dt><dd>After completion</dd></div></dl>}
      <label className="toggle-field"><input type="checkbox" checked={automaticOnly}
        onChange={(event) => setAutomaticOnly(event.target.checked)} />
        <span>Automatically marked questions only<small>Leave unchecked to include images you can answer mentally and self-check.</small></span>
      </label>
      </div>
      <div className="setup-topics">
      <TopicFilter questions={pool} selected={topics} onChange={setTopics} />
      {initialTopics && <p className="small">These topics were selected from your lesson. You can change them before starting.</p>}
      </div>
      <div className="setup-start">
      <p className="setup-pool muted" role="status">{available} questions in this pool.
        Choices are shuffled where the question permits it.</p>
      {problem && <p className="notice" role="status">{problem}</p>}
      {mode === "exam" && <p className="muted">The timer continues if you leave or reload. Unanswered questions remain unmarked.
        This practice format is not the official exam scoring system.</p>}
      <button className="button button-primary" type="submit" disabled={Boolean(problem)}>{mode === "exam" ? "Start exam" : `Start ${count} questions`}</button>
      </div>
    </form>
  </section>;
}
