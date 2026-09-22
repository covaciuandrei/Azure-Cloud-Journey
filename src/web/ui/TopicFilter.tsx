import { useEffect, useMemo, useRef, useState } from "react";
import { topicGroupsForExam, topicIdsForExam, matchesStudyTopics as matchesTopics, type StudyTopicId as TopicId } from "../../domain/examTopics.js";
import type { ExamId } from "../../domain/exams.js";
import type { QuestionSummary } from "../types.js";

function GroupCheckbox({ label, checked, partial, onChange }: {
  label: string; checked: boolean; partial: boolean; onChange: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (input.current) input.current.indeterminate = partial; }, [partial]);
  return <input ref={input} type="checkbox" aria-label={label} checked={checked}
    aria-checked={partial ? "mixed" : checked} onChange={onChange} />;
}

export function TopicFilter({ questions, selected, onChange, examId = "az104" }: {
  questions: readonly QuestionSummary[]; selected: readonly TopicId[]; onChange: (topics: TopicId[]) => void;
  examId?: ExamId;
}) {
  const TOPIC_IDS = topicIdsForExam(examId);
  const TOPIC_GROUPS = topicGroupsForExam(examId);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const counts = useMemo(() => Object.fromEntries(TOPIC_IDS.map((id) => [
    id, questions.filter((question) => matchesTopics(question.topicIds, [id])).length,
  ])), [questions, TOPIC_IDS]);
  const toggle = (ids: readonly TopicId[], include: boolean) => {
    const next = new Set(selected);
    ids.forEach((id) => include ? next.add(id) : next.delete(id));
    onChange(TOPIC_IDS.filter((id) => next.has(id)));
  };
  return <fieldset className="topic-filter">
    <legend>Topics</legend>
    <div className="topic-filter-summary">
      <span>{selected.length === TOPIC_IDS.length ? "All topics selected" : `${selected.length} of ${TOPIC_IDS.length} subtopics selected`}</span>
      <div><button className="text-button" type="button" onClick={() => onChange([...TOPIC_IDS])}>Select all topics</button>
        <button className="text-button" type="button" onClick={() => onChange([])}>Clear topics</button></div>
    </div>
    <div className="topic-groups">{TOPIC_GROUPS.map((group) => {
      const ids = group.topics.map((topic) => topic.id);
      const active = ids.filter((id) => selected.includes(id)).length;
      const count = questions.filter((question) => matchesTopics(question.topicIds, ids)).length;
      const open = expanded.has(group.id);
      return <div className={`topic-group ${active === ids.length ? "topic-group-selected" : active > 0 ? "topic-group-partial" : ""}`} key={group.id}>
        <div className="topic-group-heading">
          <label><GroupCheckbox label={group.label} checked={active === ids.length} partial={active > 0 && active < ids.length}
            onChange={() => toggle(ids, active !== ids.length)} /><span>{group.label}</span><small>{count}</small></label>
          <button type="button" className="text-button topic-expand" aria-label={`${open ? "Hide" : "Show"} ${group.label} subtopics`}
            aria-expanded={open} onClick={() => setExpanded((current) => {
              const next = new Set(current);
              if (open) next.delete(group.id); else next.add(group.id);
              return next;
            })}>{open ? "Hide" : "Details"}</button>
        </div>
        {open && <div className="topic-subtopics">{group.topics.map((topic) =>
          <label key={topic.id}><input type="checkbox" checked={selected.includes(topic.id)}
            onChange={() => toggle([topic.id], !selected.includes(topic.id))} />
            <span>{topic.label}</span><small>{counts[topic.id]}</small></label>)}</div>}
      </div>;
    })}</div>
    <p className="topic-filter-help">Questions matching any selected topic are included. Some questions cover more than one topic.</p>
  </fieldset>;
}
