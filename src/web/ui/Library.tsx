import { useEffect, useMemo, useState } from "react";
import { optionOrder, type PracticeResponse } from "../engine.js";
import type { StudyCatalog, StudyDocument, StudyRepository } from "../types.js";
import { QuestionCard } from "./QuestionCard.js";
import { messageOf } from "./useStudy.js";
import { TOPIC_IDS, matchesTopics, type TopicId } from "../../domain/topics.js";
import { TopicFilter } from "./TopicFilter.js";

type Filter = "all" | "automatic" | "manual" | "review";

function Question({ document, repository, seed }: {
  document: StudyDocument; repository: StudyRepository; seed: string;
}) {
  const [response, setResponse] = useState<PracticeResponse>({
    selectedIds: [], note: "", submitted: false, flagged: false, selfAssessment: null,
  });
  const order = useMemo(() => optionOrder(document, seed), [document, seed]);
  return <QuestionCard document={document} order={order} repository={repository}
    response={response} revealed={response.submitted} locked={response.submitted}
    onSelect={(id) => setResponse((current) => ({
      ...current, selectedIds: document.question.kind === "multi-select"
        ? current.selectedIds.includes(id) ? current.selectedIds.filter((item) => item !== id) : [...current.selectedIds, id]
        : [id],
    }))}
    onReveal={() => setResponse((current) => ({ ...current, submitted: true }))}
    onSelfAssess={(value) => setResponse((current) => ({ ...current, selfAssessment: value }))} />;
}

export function Library({ catalog, repository }: { catalog: StudyCatalog; repository: StudyRepository }) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [page, setPage] = useState(1);
  const [seed, setSeed] = useState(() => crypto.randomUUID());
  const [documents, setDocuments] = useState<StudyDocument[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [topics, setTopics] = useState<TopicId[]>([...TOPIC_IDS]);
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    const number = /^(?:q(?:uestion)?\s*|#)?\d+$/i.test(query)
      ? Number(query.replace(/^(?:q(?:uestion)?\s*|#)/i, "")) : null;
    return catalog.questions.filter((question) =>
      matchesTopics(question.topicIds, topics) &&
      (filter === "all" || (filter === "automatic" && question.grading === "automatic") ||
        (filter === "manual" && question.grading === "manual") || (filter === "review" && question.provisional)) &&
      (!query || (number !== null ? question.number === number || question.sourceNumbers?.includes(number)
        : question.searchText.toLowerCase().includes(query))));
  }, [catalog, search, filter, topics]);
  const pages = Math.max(1, Math.ceil(filtered.length / 5));
  const currentPage = Math.min(page, pages);
  const ids = useMemo(() => filtered.slice((currentPage - 1) * 5, currentPage * 5).map((question) => question.id),
    [filtered, currentPage]);
  useEffect(() => {
    let current = true;
    setDocuments(null);
    setError(null);
    repository.loadQuestions(ids, catalog.releaseId).then((items) => {
      if (current) setDocuments(items);
    }).catch((reason: unknown) => { if (current) setError(messageOf(reason)); });
    return () => { current = false; };
  }, [repository, catalog.releaseId, ids, retry]);

  const changePage = (value: number) => {
    setPage(value);
    document.getElementById("library-top")?.scrollIntoView({ block: "start" });
  };
  const pagination = <div className="pagination">
    <span>{filtered.length ? `${(currentPage - 1) * 5 + 1}-${Math.min(currentPage * 5, filtered.length)} of ${filtered.length}` : "No matches"}</span>
    <div><button className="button button-secondary button-small" disabled={currentPage === 1}
      onClick={() => changePage(currentPage - 1)}>Previous</button>
      <span>Page {currentPage} / {pages}</span>
      <button className="button button-secondary button-small" disabled={currentPage === pages}
        onClick={() => changePage(currentPage + 1)}>Next</button></div>
  </div>;

  return <section id="library-top" className="library-page">
    <div className="page-heading"><div><h1>Question library</h1>
      <p className="muted">{catalog.counts.questions} questions
        {catalog.counts.duplicatesGrouped ? ` from ${catalog.counts.sourceQuestions} source entries; ${catalog.counts.duplicatesGrouped} duplicates grouped.` : "."}</p></div>
      <button className="button button-secondary" onClick={() => setSeed(crypto.randomUUID())}>Reshuffle choices</button>
    </div>
    <div className="library-filters">
    <div className="library-toolbar">
      <label className="search-field"><span>Search questions</span>
        <input type="search" value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }}
          placeholder="Search text or question number" /></label>
      <label className="filter-field"><span>Question type</span>
        <select value={filter} onChange={(event) => {
          const value = event.target.value;
          if (value === "all" || value === "automatic" || value === "manual" || value === "review") {
            setFilter(value); setPage(1);
          }
        }}>
          <option value="all">All questions</option>
          <option value="automatic">Automatic marking</option>
          <option value="manual">Image / self-check</option>
          <option value="review">Provisional answers</option>
        </select></label>
    </div>
    <TopicFilter questions={catalog.questions} selected={topics} onChange={(selection) => { setTopics(selection); setPage(1); }} />
    </div>
    {pagination}
    {error ? <div className="notice notice-error" role="alert"><p>{error}</p>
      <button className="button button-secondary" onClick={() => setRetry(retry + 1)}>Retry</button></div> :
      !documents ? <p className="loading-panel" role="status">Loading questions...</p> :
        documents.length ? <div className="question-list">{documents.map((item) =>
          <Question key={`${item.question.id}-${seed}`} document={item} repository={repository} seed={seed} />)}</div> :
          <div className="empty-state"><p>No questions match this search.</p>
            <button className="button button-secondary" onClick={() => { setSearch(""); setFilter("all"); setTopics([...TOPIC_IDS]); }}>Clear filters</button></div>}
    {filtered.length > 5 && pagination}
  </section>;
}
