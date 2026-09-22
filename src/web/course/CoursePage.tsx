import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { checkpointCorrect, type CourseCheckpoint, type CourseLesson, type CourseModule } from "../../domain/course.js";
import { shuffled } from "../engine.js";
import { Icon } from "../components/Icon.js";
import { CourseContent, CourseInline, lessonSearchText, lessonSectionId } from "./CourseContent.js";
import { currentLessonProgress, type CourseProgress, type LessonProgress } from "./progress.js";
import type { CoursePageProps } from "./types.js";
import { courseDomains, courseLabel, modulePracticeTopics } from "./catalog.js";

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return <a href={href} target="_blank" rel="noopener noreferrer">{children}<span className="sr-only"> (opens in a new tab)</span></a>;
}

function SectionLink({ targetId, children, active = false }: { targetId: string; children: ReactNode; active?: boolean }) {
  return <a href={`#${targetId}`} aria-current={active ? "location" : undefined} onClick={(event) => {
    event.preventDefault();
    const target = document.getElementById(targetId);
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: "start", behavior: "auto" });
  }}>{children}</a>;
}

interface LessonIndexEntry { id: string; title: string }

function OnPageIndex({ sections }: { sections: LessonIndexEntry[] }) {
  const [activeSection, setActiveSection] = useState(sections[0]?.id);

  useEffect(() => {
    const headings = sections.map((section) => document.getElementById(section.id)).filter((element) => element !== null);
    let frame = 0;
    const update = () => {
      frame = 0;
      const offset = headings[0] ? Number.parseFloat(getComputedStyle(headings[0]).scrollMarginTop) || 88 : 88;
      let current = headings[0]?.id;
      for (const heading of headings) {
        if (heading.getBoundingClientRect().top > offset + 16) break;
        current = heading.id;
      }
      setActiveSection(current);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const reader = headings[0]?.closest(".course-reader");
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    if (reader) observer?.observe(reader);
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      observer?.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [sections]);

  return <aside className="course-page-index" aria-label="On this page">
    <p className="course-eyebrow">On this page</p>
    <nav aria-label="On-page sections"><ol>{sections.map((section) => <li key={section.id}>
      <SectionLink targetId={section.id} active={activeSection === section.id}><CourseInline text={section.title} /></SectionLink>
    </li>)}</ol></nav>
    <p className="course-index-note"><Icon name="book" size={15} /><span>Read, explore, then check your understanding.</span></p>
  </aside>;
}

function resultsFor(lessons: CourseLesson[], progress: CourseProgress) {
  return lessons.reduce((result, lesson) => {
    const current = currentLessonProgress(progress, lesson);
    result.studied += Number(current.studiedAt !== null);
    result.minutes += lesson.minutes;
    result.total += lesson.checkpoints.length;
    for (const checkpoint of lesson.checkpoints) {
      const answer = current.answers[checkpoint.id];
      if (answer) {
        result.checked++;
        result.correct += Number(checkpointCorrect(checkpoint, answer.selectedIds));
      }
    }
    return result;
  }, { studied: 0, checked: 0, correct: 0, total: 0, minutes: 0 });
}

function needsReview(progress: CourseProgress, lesson: CourseLesson) {
  const previous = progress.lessons[lesson.id];
  return previous !== undefined && previous.revision !== lesson.revision;
}

function BookmarkButton({ lesson, bookmarked, onBookmark }: {
  lesson: CourseLesson; bookmarked: boolean; onBookmark: CoursePageProps["onBookmark"];
}) {
  return <button type="button" className="button button-small course-bookmark" aria-pressed={bookmarked}
    aria-label={`${bookmarked ? "Remove bookmark for" : "Bookmark"} ${lesson.title}`}
    onClick={() => onBookmark(lesson.id)}><Icon name={bookmarked ? "check" : "flag"} size={15} />{bookmarked ? "Bookmarked" : "Bookmark"}</button>;
}

function Checkpoint({ checkpoint, number, saved, onCheck }: {
  checkpoint: CourseCheckpoint; number: number; saved: LessonProgress["answers"][string] | undefined;
  onCheck: (selectedIds: string[]) => void;
}) {
  const id = useId();
  const [shuffleSeed, setShuffleSeed] = useState(() => crypto.randomUUID());
  const choices = useMemo(() => shuffled(checkpoint.choices, shuffleSeed), [checkpoint.choices, shuffleSeed]);
  const [selected, setSelected] = useState<string[]>(() => saved ? [...saved.selectedIds] : []);
  const [checked, setChecked] = useState<string[] | null>(() => saved ? [...saved.selectedIds] : null);
  const result = checked === null ? null : checkpointCorrect(checkpoint, checked);
  const [retrying, setRetrying] = useState(false);
  const lastChecked = useRef<string[] | null>(checked);
  const firstChoice = useRef<HTMLInputElement>(null);
  const savedKey = saved ? `${saved.checkedAt}-${saved.attempts}-${saved.selectedIds.join(",")}` : "";
  const previousSavedKey = useRef(savedKey);

  useEffect(() => {
    // Other progress actions can clone this record without changing the checkpoint result.
    if (previousSavedKey.current === savedKey) return;
    previousSavedKey.current = savedKey;
    setSelected(saved ? [...saved.selectedIds] : []);
    setChecked(saved ? [...saved.selectedIds] : null);
    lastChecked.current = saved ? [...saved.selectedIds] : null;
    setRetrying(false);
  }, [saved, savedKey]);

  return <form className="course-checkpoint" data-checkpoint-id={checkpoint.id} onSubmit={(event) => {
    event.preventDefault();
    if (!selected.length || checked !== null) return;
    onCheck([...selected]);
    lastChecked.current = [...selected];
    setChecked([...selected]);
    setRetrying(false);
  }}>
    <p className="course-meta">Checkpoint {number} / {checkpoint.kind === "single" ? "Select one choice" : "Select all correct choices"}</p>
    <fieldset aria-describedby={`${id}-instructions`}>
      <legend><CourseInline text={checkpoint.prompt} /></legend>
      <p id={`${id}-instructions`} className="course-meta">Choose before checking. Checking records this attempt; it does not mark the lesson studied.</p>
      <div className="course-checkpoint-choices">{choices.map((choice, index) => {
        const correctChoice = checkpoint.correctIds.includes(choice.id);
        return <div key={choice.id} className={`course-checkpoint-choice${checked !== null
          ? correctChoice ? " is-correct" : selected.includes(choice.id) ? " is-incorrect" : "" : ""}`}>
          <label htmlFor={`${id}-${choice.id}`}>
            <input ref={index === 0 ? firstChoice : undefined} id={`${id}-${choice.id}`} name={`${id}-choices`}
              type={checkpoint.kind === "single" ? "radio" : "checkbox"} value={choice.id} data-choice-id={choice.id}
              checked={selected.includes(choice.id)} disabled={checked !== null}
              aria-describedby={checked !== null ? `${id}-${choice.id}-explanation` : undefined}
              onChange={(event) => {
                const include = event.target.checked;
                setSelected((previous) => checkpoint.kind === "single" ? [choice.id]
                  : include ? [...previous, choice.id] : previous.filter((value) => value !== choice.id));
              }} />
            <span><CourseInline text={choice.text} /></span>
          </label>
          {checked !== null && <div id={`${id}-${choice.id}-explanation`} className="course-choice-explanation">
            <p><strong>{selected.includes(choice.id) ? "Selected. " : "Not selected. "}
              {correctChoice ? "Correct choice." : "Not a correct choice."}</strong></p>
            <p><CourseInline text={choice.explanation} /></p>
          </div>}
        </div>;
      })}</div>
    </fieldset>
    <div className={`course-checkpoint-feedback${result === null ? "" : result ? " is-correct" : " is-incorrect"}`}
      role="status" aria-atomic="true">
      {result !== null && <><p><strong>{result ? "Correct." : "Not yet correct."}</strong>
        {" "}{checkpoint.kind === "multiple" ? "The result checks the complete set of choices." : "Review the reasoning for each choice."}</p>
        <p><CourseInline text={checkpoint.explanation} /></p></>}
      {retrying && <p>Choose again. The previous recorded result
        {lastChecked.current ? ` (${checkpointCorrect(checkpoint, lastChecked.current) ? "correct" : "not yet correct"})` : ""}
        {" "}stays in your learning progress until you check a new answer.</p>}
    </div>
    <div className="course-actions">
      <button type="submit" className="button button-primary" disabled={!selected.length || checked !== null}>Check</button>
      {checked !== null && <button type="button" className="button" onClick={() => {
        setShuffleSeed(crypto.randomUUID());
        setSelected([]);
        setChecked(null);
        setRetrying(true);
        requestAnimationFrame(() => firstChoice.current?.focus());
      }}>Try again</button>}
      {saved && <span className="course-meta">Recorded attempts: {saved.attempts}</span>}
    </div>
  </form>;
}

function ModuleResources({ module }: { module: CourseModule }) {
  return <>
    {module.lab && <section className="course-module-lab" aria-labelledby={`course-lab-${module.id}`}>
      <h2 id={`course-lab-${module.id}`} tabIndex={-1}>Optional module lab</h2>
      <p className="course-notice"><strong>Cost warning: </strong><CourseInline text={module.lab.costWarning} /></p>
      <details className="course-details"><summary><CourseInline text={module.lab.title} /> (manual steps)</summary>
        <div className="course-details-body">
          <p><CourseInline text={module.lab.purpose} /></p>
          <p className="course-meta">This is optional work in your own environment. This reader does not create or delete Azure resources.</p>
          <h3>Prerequisites</h3><ul>{module.lab.prerequisites.map((item, index) => <li key={index}><CourseInline text={item} /></li>)}</ul>
          <h3>Steps</h3><ol>{module.lab.steps.map((item, index) => <li key={index}><CourseInline text={item} /></li>)}</ol>
          <h3>Expected results</h3><ul>{module.lab.expectedResults.map((item, index) => <li key={index}><CourseInline text={item} /></li>)}</ul>
          <h3>Cleanup</h3><ol>{module.lab.cleanup.map((item, index) => <li key={index}><CourseInline text={item} /></li>)}</ol>
        </div>
      </details>
    </section>}
    <section className="course-module-glossary" aria-labelledby={`course-glossary-${module.id}`}>
      <h2 id={`course-glossary-${module.id}`} tabIndex={-1}>Module glossary</h2>
      <details className="course-details"><summary>{module.glossary.length} terms and definitions</summary>
        <dl className="course-glossary">{module.glossary.map((entry, index) => <div key={`${entry.term}-${index}`}>
          <dt><CourseInline text={entry.term} /></dt><dd><CourseInline text={entry.definition} /></dd>
        </div>)}</dl>
      </details>
    </section>
  </>;
}

export function CoursePage(props: CoursePageProps) {
  const { course, progress, activeLessonId, warning, onOverview, onStudy, onBookmark, onPractice } = props;
  const [query, setQuery] = useState("");
  const [bookmarksOnly, setBookmarksOnly] = useState(false);
  const [contentsOpen, setContentsOpen] = useState(false);
  const [domainFilter, setDomainFilter] = useState("");
  const domains = courseDomains(course);
  const heading = useRef<HTMLHeadingElement>(null);
  const outline = useRef<HTMLElement>(null);
  const id = useId();
  const entries = useMemo(() => course.modules.flatMap((module, moduleIndex) =>
    module.lessons.map((lesson, lessonIndex) => ({ module, moduleIndex, lesson, lessonIndex, search: lessonSearchText(lesson) }))), [course]);
  const activeIndex = entries.findIndex((entry) => entry.lesson.id === activeLessonId);
  const active = entries[activeIndex];
  const indexSections = useMemo<LessonIndexEntry[]>(() => active ? [
    ...active.lesson.sections.map((section) => ({ id: lessonSectionId(active.lesson.id, section.id), title: section.title })),
    { id: `course-takeaways-${active.lesson.id}`, title: "Key takeaways" },
    { id: `course-checkpoints-${active.lesson.id}`, title: "Checkpoints" },
    ...(active.module.lab ? [{ id: `course-lab-${active.module.id}`, title: "Optional module lab" }] : []),
    { id: `course-glossary-${active.module.id}`, title: "Module glossary" },
    { id: `course-sources-${active.lesson.id}`, title: "Sources and further reading" },
  ] : [], [active]);
  const totals = resultsFor(entries.map((entry) => entry.lesson), progress);
  const last = entries.find((entry) => entry.lesson.id === progress.lastLessonId);
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matching = entries.filter((entry) => terms.every((term) => entry.search.includes(term)) &&
    (!domainFilter || domains.find((domain) => domain.id === domainFilter)?.moduleIds.includes(entry.module.id)) &&
    (!bookmarksOnly || currentLessonProgress(progress, entry.lesson).bookmarked));
  const filtered = terms.length > 0 || bookmarksOnly || domainFilter !== "";
  const clearFilters = () => { setQuery(""); setBookmarksOnly(false); setDomainFilter(""); };
  const onOpenLesson = (lessonId: string) => { setContentsOpen(false); props.onOpenLesson(lessonId); };
  const objectiveNotice = course.schemaVersion === 3 ? <p className="course-notice">
    <strong>Announced outline, effective October 21, 2026. </strong>
    <CourseInline text={course.objectiveDateNotice} />
    {" "}No previous English objective snapshot has been verified.
  </p> : null;

  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    heading.current?.closest(".course-page")?.scrollIntoView({ block: "start", behavior: "auto" });
  }, [activeLessonId]);

  useEffect(() => {
    const contents = outline.current;
    const selected = contents?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!contents || !selected || !contents.clientHeight) return;
    contents.scrollTop = 0;
    const bounds = contents.getBoundingClientRect();
    const item = selected.getBoundingClientRect();
    if (item.top < bounds.top || item.bottom > bounds.bottom) {
      contents.scrollTop += item.top - bounds.top - (contents.clientHeight - item.height) / 2;
    }
  }, [activeLessonId, contentsOpen]);

  const storageNote = <div className="course-storage">
    <details><summary>Learning progress: this browser only</summary>
      <p>Learning progress is {warning ? "normally " : ""}saved only in this browser, isolated by account with a separate guest record.
        It does not sync between devices and is separate from practice exam results.</p>
    </details>
    {warning && <p className="course-notice" role="alert">{warning}</p>}
  </div>;

  const progressLine = <section className="course-progress" aria-label="Course learning progress">
    <div><strong>{totals.studied} of {entries.length} lessons marked Studied</strong>
      <span>{totals.checked} of {totals.total} checkpoints checked; {totals.correct} correct</span></div>
    <progress max={entries.length} value={totals.studied} aria-label="Lessons marked Studied">{totals.studied} of {entries.length}</progress>
    <p>Studied is your reading marker, not a mastery rating. Checkpoint results are recorded separately.</p>
  </section>;

  if (activeLessonId !== null && !active) return <div className="course-page course-overview">
    <h1 ref={heading} tabIndex={-1}>Lesson not found</h1>
    <p>The lesson ID <code>{activeLessonId}</code> is not part of this course release. No other lesson has been opened in its place.</p>
    <button type="button" className="button" onClick={onOverview}>Back to course overview</button>
    {storageNote}
  </div>;

  if (!active) return <div className="course-page course-overview">
    <header className="course-overview-heading">
      <p className="course-eyebrow"><Icon name="book" size={16} /> {courseLabel(course)}</p>
      <h1 ref={heading} tabIndex={-1}><CourseInline text={course.title} /></h1>
      <p><CourseInline text={course.introduction} /></p>
      {objectiveNotice}
      <p className="course-meta">{course.modules.length} modules / {entries.length} lessons / {totals.minutes} minutes estimated reading
        {" / Reviewed "}<time dateTime={course.reviewedAt}>{course.reviewedAt}</time></p>
      <div className="course-actions">
        {last ? <button type="button" className="button button-primary" onClick={() => onOpenLesson(last.lesson.id)}>
          Continue: {last.lesson.title}</button>
          : entries[0] && <button type="button" className="button button-primary" onClick={() => onOpenLesson(entries[0]!.lesson.id)}>Start first lesson</button>}
      </div>
      <div className="course-reference-links">
        <ExternalLink href={course.pathUrl}>{course.id === "sc900" ? "Security, Compliance, and Identity Fundamentals certification"
          : course.id === "az104" ? "Azure Administrator certification" : "Microsoft Learn path"}</ExternalLink>
        <ExternalLink href={course.examGuideUrl}>Official exam objectives</ExternalLink>
      </div>
      {progress.lastLessonId && !last && <p className="course-notice">Your last lesson is not in this release. Choose a lesson from the overview.</p>}
    </header>
    {progressLine}
    {storageNote}
    {course.schemaVersion !== 1 && <section className="course-domain-overview" aria-labelledby={`${id}-domains`}>
      <h2 id={`${id}-domains`}>{course.id === "sc900" ? "Four domains of security, compliance and identity" : "Five domains of Azure administration"}</h2>
      <p className="course-meta">{course.domains.reduce((sum, domain) => sum + domain.objectives.length, 0)} mapped official objectives.
        {course.id === "sc900" && " These are the announced October 21, 2026 objectives, not a verified earlier outline."}
        Mapping is not a guarantee of exam coverage or readiness.</p>
      <div className="course-domain-grid">{domains.map((domain) => {
        const domainLessons = entries.filter((entry) => domain.moduleIds.includes(entry.module.id)).map((entry) => entry.lesson);
        const result = resultsFor(domainLessons, progress);
        return <article key={domain.id} className="course-domain-card">
          <h3>{domain.title}</h3>
          <p>{domain.moduleIds.length} modules / {domainLessons.length} lessons / {result.total} checkpoints</p>
          <p className="course-meta">{domain.objectives.length} objectives / Official exam weight: {domain.weight.min}-{domain.weight.max}%</p>
          <div className="course-actions">
            <button type="button" className="button button-small" aria-pressed={domainFilter === domain.id}
              onClick={() => setDomainFilter(domainFilter === domain.id ? "" : domain.id)}>Explore {domain.title}</button>
            <button type="button" className="button button-small" onClick={() => onPractice([...domain.practiceTopics])}>Practice this domain</button>
          </div>
        </article>;
      })}</div>
    </section>}
    <div className="course-overview-section-heading"><h2>Explore the modules</h2><p>Follow the course in order, or return to a lesson.</p></div>
    <div className="course-filters">
      <label className="course-search" htmlFor={`${id}-search`}>Search lessons
        <input id={`${id}-search`} type="search" value={query} onChange={(event) => setQuery(event.target.value)}
          placeholder="Search titles, objectives and lesson text" aria-describedby={`${id}-search-help`} />
      </label>
      <label className="course-filter-toggle"><input type="checkbox" checked={bookmarksOnly}
        onChange={(event) => setBookmarksOnly(event.target.checked)} /> Bookmarks only</label>
      {filtered && <button type="button" className="text-button" onClick={clearFilters}>Clear filters</button>}
    </div>
    <p id={`${id}-search-help`} className="course-meta">Search includes lesson text, examples and checkpoint explanations. Filters do not change progress.</p>
    <p className="course-meta" role="status">{matching.length} of {entries.length} lessons shown in {new Set(matching.map((entry) => entry.module.id)).size} of {course.modules.length} modules.</p>
    <p className="course-meta">Core and supporting priorities explain the suggested study order, not how often a topic appears on an exam.</p>
    {!matching.length && <div className="course-empty"><h2>No matching lessons</h2>
      <p>{bookmarksOnly ? "Bookmark a lesson to collect it here, or turn off the bookmark filter." : "Try a different title, objective or phrase."}</p>
      <button type="button" className="button" onClick={clearFilters}>Show all lessons</button>
    </div>}
    <div className="course-modules">{course.modules.map((module, moduleIndex) => {
      const lessons = matching.filter((entry) => entry.module.id === module.id);
      if (!lessons.length) return null;
      const moduleResults = resultsFor(module.lessons, progress);
      return <section className="course-module" key={module.id} aria-labelledby={`${id}-${module.id}`}>
        <header><div className="course-module-kicker"><p className="course-eyebrow">Module {String(moduleIndex + 1).padStart(2, "0")} of {course.modules.length}</p>
          <span className={`course-badge course-badge-${module.priority}`}>{module.priority === "core" ? "Core" : "Supporting"}</span></div>
          <h2 id={`${id}-${module.id}`}><CourseInline text={module.title} /></h2>
          {course.schemaVersion !== 1 && <p className="course-meta">{domains.find((domain) => domain.moduleIds.includes(module.id))?.title}</p>}
          <p><CourseInline text={module.summary} /></p>
        </header>
        <p className="course-meta">{module.lessons.length} lessons / {moduleResults.minutes} minutes
          {" / "}{moduleResults.studied} studied / {moduleResults.correct} of {moduleResults.total} checkpoints correct</p>
        <details className="course-priority"><summary>Why this study priority?</summary>
          <p><CourseInline text={module.priorityReason} /></p>
        </details>
        <details className="course-module-objectives"><summary>Official module objectives</summary>
          <ul>{module.officialObjectives.map((objective, index) => <li key={index}><CourseInline text={objective} /></li>)}</ul>
          <ExternalLink href={module.sourceModuleUrl}>Microsoft documentation</ExternalLink>
        </details>
        <ol className="course-lesson-list">{lessons.map(({ lesson, lessonIndex }) => {
          const current = currentLessonProgress(progress, lesson);
          const result = resultsFor([lesson], progress);
          return <li key={lesson.id} value={lessonIndex + 1}>
            <div className="course-lesson-summary"><button type="button" className="course-lesson-link" onClick={() => onOpenLesson(lesson.id)}>
              <span>{moduleIndex + 1}.{lessonIndex + 1}</span> <CourseInline text={lesson.title} />
            </button>
              <p><CourseInline text={lesson.summary} /></p>
              <p className="course-meta">{lesson.minutes} min / {needsReview(progress, lesson) ? "Review needed"
                : current.studiedAt !== null ? "Studied" : "Not marked studied"}
                {" / "}{result.checked} of {result.total} checkpoints checked; {result.correct} correct</p>
            </div>
            <BookmarkButton lesson={lesson} bookmarked={current.bookmarked} onBookmark={onBookmark} />
          </li>;
        })}</ol>
        <button type="button" className="button button-small" onClick={() => onPractice(modulePracticeTopics(module))}>Practice this topic</button>
      </section>;
    })}</div>
  </div>;

  const { lesson, module, moduleIndex, lessonIndex } = active;
  const current = currentLessonProgress(progress, lesson);
  const lessonResults = resultsFor([lesson], progress);
  const previous = entries[activeIndex - 1];
  const next = entries[activeIndex + 1];
  const moduleResults = resultsFor(module.lessons, progress);

  return <div className="course-page course-lesson-page">
    <nav className="course-breadcrumb" aria-label="Lesson breadcrumb">
      <button type="button" className="text-button" onClick={onOverview}>Course overview</button>
      <Icon name="chevron-right" size={12} /><span>Module {moduleIndex + 1}: <CourseInline text={module.title} /></span>
      <Icon name="chevron-right" size={12} /><span aria-current="page">Lesson {lessonIndex + 1} of {module.lessons.length}</span>
    </nav>
    <div className="course-reader-layout">
      <aside className="course-sidebar">
        <button type="button" className="button course-contents-toggle" aria-expanded={contentsOpen}
          aria-controls={`${id}-contents`} onClick={() => setContentsOpen((value) => !value)}>
          <Icon name={contentsOpen ? "close" : "menu"} size={17} />{contentsOpen ? "Hide course contents" : "Show course contents"}</button>
        <nav ref={outline} id={`${id}-contents`} className={`course-contents${contentsOpen ? " is-open" : ""}`} aria-label="Course modules and lessons">
          <div className="course-outline-heading">
            <p className="course-eyebrow"><Icon name="book" size={16} /> {courseLabel(course)}</p>
            <h2>Course contents</h2>
            <p className="course-meta">{course.modules.length} modules / {entries.length} lessons</p>
          </div>
          <div className="course-outline-progress">
            <span>Module {moduleIndex + 1} reading progress</span>
            <strong>{moduleResults.studied} of {module.lessons.length} studied</strong>
            <progress max={module.lessons.length} value={moduleResults.studied} aria-label="Current module lessons marked Studied" />
          </div>
          {domains.map((domain) => <section key={domain.id} aria-label={domain.title}>
          {course.schemaVersion !== 1 && <h3 className="course-domain-heading">{domain.title}</h3>}
          {course.modules.map((item, index) => !domain.moduleIds.includes(item.id) ? null : <details key={`${item.id}-${module.id}`} open={item.id === module.id}>
            <summary>{index + 1}. <CourseInline text={item.title} /></summary>
            <ol>{item.lessons.map((itemLesson, itemIndex) => <li key={itemLesson.id}>
              <button type="button" aria-current={itemLesson.id === lesson.id ? "page" : undefined}
                onClick={() => onOpenLesson(itemLesson.id)}>
                <span className="course-lesson-number" aria-hidden="true">{currentLessonProgress(progress, itemLesson).studiedAt !== null
                  ? <Icon name="check" size={12} /> : itemIndex + 1}</span>
                <span className="course-outline-lesson"><CourseInline text={itemLesson.title} />
                  <small>{itemLesson.minutes} min{itemLesson.id === lesson.id ? " / You're here" : ""}</small>
                  {needsReview(progress, itemLesson) ? <small>Review needed</small>
                    : currentLessonProgress(progress, itemLesson).studiedAt !== null && <small>Studied</small>}
                  {currentLessonProgress(progress, itemLesson).bookmarked && <small>Bookmarked</small>}
                </span>
              </button>
            </li>)}</ol>
          </details>)}</section>)}
        </nav>
      </aside>
      <article className="course-reader" key={`${lesson.id}-${lesson.revision}`} data-lesson-id={lesson.id} aria-labelledby={`${id}-lesson-title`}>
        <header className="course-lesson-heading">
          <div className="course-lesson-kicker"><p className="course-eyebrow">Module {String(moduleIndex + 1).padStart(2, "0")} / Lesson {String(lessonIndex + 1).padStart(2, "0")}</p>
            <BookmarkButton lesson={lesson} bookmarked={current.bookmarked} onBookmark={onBookmark} /></div>
          <h1 ref={heading} id={`${id}-lesson-title`} tabIndex={-1}><CourseInline text={lesson.title} /></h1>
          <p className="course-lesson-lede"><CourseInline text={lesson.summary} /></p>
          {objectiveNotice}
          <p className="course-meta course-reading-meta"><Icon name="clock" size={15} /> Lesson {activeIndex + 1} of {entries.length} / Estimated reading: {lesson.minutes} minutes
            {" / Reviewed "}<time dateTime={module.reviewedAt}>{module.reviewedAt}</time></p>
          {needsReview(progress, lesson) && <p className="course-notice" role="status">
            <strong>Review needed.</strong> This lesson has changed since your recorded progress.
            Previous studied marks and checkpoint answers are not applied to this revision. Your bookmark is kept.
          </p>}
          <div className="course-actions">
            <button type="button" className="button" aria-pressed={current.studiedAt !== null}
              onClick={() => onStudy(lesson.id, current.studiedAt === null)}>{current.studiedAt !== null ? "Studied (undo)" : "Mark studied"}</button>
            <button type="button" className="button" onClick={() => onPractice(modulePracticeTopics(module))}>Practice this topic</button>
          </div>
          <p className="course-meta">{lessonResults.checked} of {lessonResults.total} checkpoints checked; {lessonResults.correct} correct.
            Studied is a manual reading marker, independent of these results.</p>
          {storageNote}
        </header>
        <section className="course-objectives" aria-labelledby={`${id}-objectives`}>
          <h2 id={`${id}-objectives`}>Learning objectives</h2>
          <ul>{lesson.objectives.map((objective, index) => <li key={index}><CourseInline text={objective} /></li>)}</ul>
          {course.schemaVersion !== 1 && <details className="course-details"><summary>Official objective coverage</summary>
            <ul>{course.coverage.flatMap((coverage) => coverage.objectives.flatMap((objective) => {
              const target = objective.lessons.find((target) => target.moduleId === module.id && target.lessonId === lesson.id);
              if (!target) return [];
              const label = course.domains.flatMap((domain) => domain.objectives).find((item) => item.id === objective.objectiveId)?.label;
              return [<li key={objective.objectiveId}><strong>{objective.objectiveId}: {label}</strong>
                <p>{target.evidence}</p>
                <ul>{target.sectionIds.map((sectionId) => <li key={sectionId}>
                  <SectionLink targetId={lessonSectionId(lesson.id, sectionId)}>
                    {lesson.sections.find((section) => section.id === sectionId)!.title}
                  </SectionLink>
                </li>)}</ul>
                {target.checkpointIds.length > 0 && <SectionLink targetId={`course-checkpoints-${lesson.id}`}>
                  Checkpoints: {target.checkpointIds.map((id) => lesson.checkpoints.findIndex((checkpoint) => checkpoint.id === id) + 1).join(", ")}
                </SectionLink>}
              </li>];
            }))}</ul>
          </details>}
        </section>
        <details className="course-details course-lesson-index"><summary>In this lesson</summary>
          <nav aria-label="Lesson sections"><ol>
            {indexSections.map((section) => <li key={section.id}><SectionLink targetId={section.id}><CourseInline text={section.title} /></SectionLink></li>)}
          </ol></nav>
        </details>
        <CourseContent key={`${lesson.id}-${lesson.revision}`} lesson={lesson} />
        <section className="course-takeaways" aria-labelledby={`course-takeaways-${lesson.id}`}>
          <h2 id={`course-takeaways-${lesson.id}`} tabIndex={-1}>Key takeaways</h2>
          <ul>{lesson.takeaways.map((item, index) => <li key={index}><CourseInline text={item} /></li>)}</ul>
        </section>
        <section className="course-checkpoints" aria-labelledby={`course-checkpoints-${lesson.id}`}>
          <h2 id={`course-checkpoints-${lesson.id}`} tabIndex={-1}>Checkpoints</h2>
          <p>Use these to test your reasoning. A correct checkpoint is not a mastery rating or an exam result.</p>
          {lesson.checkpoints.map((checkpoint, index) => {
            const saved = current.answers[checkpoint.id];
            return <Checkpoint key={`${lesson.id}-${checkpoint.id}`}
              checkpoint={checkpoint} number={index + 1} saved={saved}
              onCheck={(selectedIds) => props.onCheck(lesson.id, checkpoint.id, selectedIds)} />;
          })}
        </section>
        <ModuleResources module={module} />
        <section className="course-sources" aria-labelledby={`course-sources-${lesson.id}`}>
          <h2 id={`course-sources-${lesson.id}`} tabIndex={-1}>Sources and further reading</h2>
          <ul>{lesson.sourceIds.map((sourceId) => {
            const source = module.sources.find((item) => item.id === sourceId);
            return <li key={sourceId}>{source ? <>
              <ExternalLink href={source.url}><CourseInline text={source.title} /></ExternalLink>
              <p><CourseInline text={source.supports} /></p>
            </> : <p className="course-notice">Reference unavailable: {sourceId}. Consult the official module below.</p>}</li>;
          })}</ul>
          <ExternalLink href={module.sourceModuleUrl}>Official Microsoft documentation</ExternalLink>
        </section>
        <footer className="course-lesson-footer">
          <div className="course-actions">
            <button type="button" className="button button-primary" aria-pressed={current.studiedAt !== null}
              onClick={() => onStudy(lesson.id, current.studiedAt === null)}>{current.studiedAt !== null ? "Studied (undo)" : "Mark studied"}</button>
            <button type="button" className="button" onClick={() => onPractice(modulePracticeTopics(module))}>Practice this topic</button>
          </div>
          <nav className="course-lesson-navigation" aria-label="Previous and next lesson">
            {previous ? <button type="button" className="button" onClick={() => onOpenLesson(previous.lesson.id)}>
              <span className="course-meta">Previous lesson</span><span>{previous.lesson.title}</span></button> : <span />}
            {next ? <button type="button" className="button" onClick={() => onOpenLesson(next.lesson.id)}>
              <span className="course-meta">Next lesson</span><span>{next.lesson.title}</span></button>
              : <button type="button" className="button" onClick={onOverview}>Back to course overview</button>}
          </nav>
          {progressLine}
        </footer>
      </article>
      <OnPageIndex key={`index:${lesson.id}-${lesson.revision}`} sections={indexSections} />
    </div>
  </div>;
}
