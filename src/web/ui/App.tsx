import { useEffect, useRef, useState } from "react";
import { useAccount } from "../account.js";
import { Modal } from "../components/Modal.js";
import { History } from "./History.js";
import { Home } from "./Home.js";
import { Library } from "./Library.js";
import { Session } from "./Session.js";
import { Setup } from "./Setup.js";
import { Statistics } from "./Statistics.js";
import { answered, useStudy, type StudyView } from "./useStudy.js";
import { useOfflineDownload, type OfflineDownload } from "./useOfflineDownload.js";
import { OfflineControls } from "./OfflineControls.js";
import { offlineSessionReferences } from "../offline-references.js";
import { readPractice } from "../storage.js";
import type { Course } from "../../domain/course.js";
import type { TopicId } from "../../domain/topics.js";
import { CoursePage } from "../course/CoursePage.js";
import { loadCourse } from "../course/repository.js";
import { courseLabel } from "../course/catalog.js";
import { useCourseProgress } from "../course/useCourseProgress.js";
import { parseLearningRoute } from "../course/navigation.js";
import { Icon } from "../components/Icon.js";
import { Welcome } from "./Welcome.js";
import { ExamSelection } from "./ExamSelection.js";

export default function App() {
  const account = useAccount();
  const offline = useOfflineDownload();
  if (!account.ready) return <main className="app-main"><p role="status">Opening your study workspace...</p></main>;
  if (!offline.online && !offline.initialized) return <main className="app-main"><p role="status">Opening the offline download...</p></main>;
  return <AccountWorkspace key={account.user ? `account:${account.user.uid}` : "guest"} account={account} offline={offline} />;
}

function AccountWorkspace({ account, offline }: { account: ReturnType<typeof useAccount>; offline: OfflineDownload }) {
  const user = account.user;
  const demoMode = import.meta.env.VITE_STUDY_DEMO === "true";
  const [route, setRoute] = useState(() => parseLearningRoute(window.location.hash));
  const [resumePracticeOnLoad] = useState(() => parseLearningRoute(window.location.hash).section === "practice");
  const study = useStudy(user?.uid ?? null, offline.useDownload, resumePracticeOnLoad);
  const [course, setCourse] = useState<Course | null>(null);
  const [courseError, setCourseError] = useState<string | null>(null);
  const [courseRetry, setCourseRetry] = useState(0);
  const [practiceTopics, setPracticeTopics] = useState<TopicId[] | undefined>();
  const [toolsOpen, setToolsOpen] = useState(false);
  const toolsToggle = useRef<HTMLButtonElement>(null);
  const learning = useCourseProgress(user?.uid ?? null, course);
  const navigate = (section: typeof route.section, lessonId: string | null = null) => {
    const hash = section === "exams" ? "#exams" : section === "welcome" ? "#home" : section === "practice" ? "#practice" : lessonId ? `#learn/${lessonId}` : "#learn";
    if (window.location.hash !== hash) window.history.pushState(null, "", hash);
    setRoute(parseLearningRoute(hash));
    window.scrollTo({ top: 0 });
  };
  const openPractice = (view: StudyView = "home", topics?: TopicId[]) => {
    setPracticeTopics(topics);
    study.openView(view);
    navigate("practice");
  };
  useEffect(() => {
    const changed = () => setRoute(parseLearningRoute(window.location.hash));
    window.addEventListener("popstate", changed);
    window.addEventListener("hashchange", changed);
    return () => {
      window.removeEventListener("popstate", changed);
      window.removeEventListener("hashchange", changed);
    };
  }, []);
  useEffect(() => {
    let current = true;
    setCourse(null);
    setCourseError(null);
    const base = new URL(import.meta.env.BASE_URL, window.location.origin).href;
    loadCourse(base, offline.useDownload).then((value) => {
      if (current) setCourse(value);
    }).catch((reason: unknown) => {
      if (current) setCourseError(reason instanceof Error ? reason.message : "The course could not be loaded.");
    });
    return () => { current = false; };
  }, [offline.useDownload, courseRetry]);
  useEffect(() => {
    if (route.section === "learn" && route.lessonId &&
        course?.modules.some((module) => module.lessons.some((lesson) => lesson.id === route.lessonId))) {
      learning.dispatch({ type: "open", lessonId: route.lessonId });
    }
  }, [course, route.section, route.lessonId, learning.dispatch]);
  useEffect(() => {
    if (offline.issue) setToolsOpen(true);
  }, [offline.issue]);
  const [signOutConfirmation, setSignOutConfirmation] = useState(false);
  const { catalog, view, attempt, saved, busy, confirmation } = study;
  const displayedSource = view === "session" && attempt ? attempt.dataSource ?? "snapshot" : study.profile.dataSource;
  const activeNav = view === "session" ? attempt?.mode === "exam" ? "exam" : "practice" : view;
  const nav: Array<{ view: StudyView; label: string }> = [
    { view: "home", label: "Home" },
    { view: "library", label: "Library" }, { view: "practice", label: "Practice" },
    { view: "exam", label: "Exam" }, { view: "history", label: "History" },
    { view: "statistics", label: "Statistics" },
  ];
  const unanswered = attempt ? attempt.size - attempt.questionIds.filter((id) =>
    answered(attempt.responses[id], study.documents.find((item) => item.question.id === id)?.question.readiness.grading)).length : 0;
  const accountStatus = user
    ? offline.useDownload ? "Saved on this device; sync paused"
      : study.profile.syncing ? "Syncing..."
        : study.profile.pendingCount ? `${study.profile.pendingCount} session(s) waiting to sync`
          : study.profile.warning ? "Practice sync needs attention" : "Practice progress saved"
    : "Progress stays on this device";
  return <div className={`app-shell app-section-${route.section}`}>
    <a className="skip-link" href="#main-content" onClick={(event) => {
      event.preventDefault();
      const main = document.getElementById("main-content");
      main?.focus();
      main?.scrollIntoView({ block: "start" });
    }}>Skip to content</a>
    <header className="app-header">
      <button className="app-brand" onClick={() => navigate("exams")} aria-label="Azure Cloud Journey exam selection">
        <span className="app-brand-mark"><Icon name="book" size={21} /></span>
        <strong>Azure Cloud Journey</strong>
      </button>
      <nav className="app-nav" aria-label="Study sections">
        {route.section === "exams" ? <button onClick={() => navigate("exams")} aria-current="page">Exams</button> : <>
        <button onClick={() => navigate("welcome")} aria-current={route.section === "welcome" ? "page" : undefined}>Home</button>
        <button onClick={() => navigate("learn")} aria-current={route.section === "learn" ? "page" : undefined}>Learn</button>
        <button onClick={() => openPractice()} aria-current={route.section === "practice" ? "page" : undefined}>Practice &amp; exams</button>
        </>}
      </nav>
      <div className="app-local">
        <button ref={toolsToggle} className={`workspace-tools-toggle${offline.useDownload ? " is-offline" : ""}`}
          aria-label="Offline & data" aria-expanded={toolsOpen} aria-controls="workspace-tools-panel"
          onClick={() => setToolsOpen((open) => !open)}>
          <Icon name="download" size={17} /><span>Offline &amp; data</span>
          {(offline.issue || offline.preparing || offline.state.status === "downloading") && <span className="tools-attention" aria-label={offline.issue ? "Needs attention" : "Download in progress"} />}
        </button>
        {user ? <button className="button button-secondary button-small" disabled={account.pending}
          onClick={() => study.profile.pendingCount ? setSignOutConfirmation(true) : void account.signOut()}>Sign out</button> :
          <button className="button button-secondary button-small" disabled={demoMode || account.pending || offline.useDownload}
            title={demoMode ? "Accounts are unavailable in the source demo" : undefined}
            aria-label={account.pending ? "Signing in..." : "Sign in with Google"}
            onClick={() => void account.signIn()}>{account.pending ? "Signing in..." : <span>Sign in<span className="auth-provider"> with Google</span></span>}</button>}
      </div>
    </header>
    <div className="workspace-statusline">
      <div className="workspace-context">{route.section === "exams" ? <span>Exam selection</span> : <>
        <button className="workspace-exam-switch" onClick={() => navigate("exams")}><Icon name="chevron-left" size={12} />Change exam</button>
        <strong className="workspace-exam-code">AZ-104</strong><Icon name="chevron-right" size={12} />
        <span>{route.section === "learn" ? courseLabel(course) : route.section === "practice" ? "Practice workspace" : "Your study workspace"}</span>
      </>}
        {(offline.useDownload || route.section === "practice") && <span className="workspace-source-badge">{offline.useDownload ? "Downloaded copy" : displayedSource === "firebase" ? "Firestore" : "Bundled snapshot"}</span>}
      </div>
      <div className="workspace-identity"><span>{user?.email ?? user?.displayName ?? "Guest"}</span><span className="workspace-save-status">{accountStatus}</span></div>
    </div>
    {saved.activeAttempt && route.section !== "practice" && <div className="workspace-resume">
      <Icon name="clock" size={16} /><span>You have an unfinished AZ-104 {saved.activeAttempt.mode === "exam" ? "exam" : "practice session"}.</span>
      <button className="text-button" onClick={() => { navigate("practice"); void study.restore(saved.activeAttempt!); }}>Resume practice</button>
    </div>}
    {route.section === "practice" && <div className="practice-subheader">
      <nav className="app-nav" aria-label="Main navigation">{nav.map((item) =>
        <button key={item.view} onClick={() => openPractice(item.view)}
          aria-current={activeNav === item.view ? "page" : undefined}>{item.view === "home" ? "Overview" : item.label}
          {item.view === "library" && catalog ? <small>{catalog.counts.questions}</small> : null}
        </button>)}</nav>
      <div className="app-local">
        {saved.activeAttempt && view !== "home" && (view !== "session" || attempt?.id !== saved.activeAttempt.id) &&
          <button className="button button-secondary button-small" onClick={() => void study.restore(saved.activeAttempt!)}>Resume session</button>}
      </div>
    </div>}
    <section className="workspace-toolbar" id="workspace-tools-panel" aria-labelledby="workspace-tools-title" hidden={!toolsOpen}>
      <div className="workspace-tools-heading"><div><span className="workspace-eyebrow">YOUR WORKSPACE</span><h2 id="workspace-tools-title">Offline &amp; data</h2></div>
        <button className="icon-button" aria-label="Close offline and data controls" onClick={() => {
          setToolsOpen(false); toolsToggle.current?.focus();
        }}><Icon name="close" size={19} /></button></div>
      {route.section === "practice" && <><label className="data-source-control">Question data
        {offline.useDownload ? <strong>Downloaded copy</strong> : <select aria-label="Question data source" value={displayedSource}
          onChange={(event) => {
            if (event.target.value === "firebase" || event.target.value === "snapshot") study.setDataSource(event.target.value);
          }}>
          <option value="firebase" disabled={!user}>Firestore{!user ? " (sign in)" : ""}</option>
          <option value="snapshot">Bundled snapshot</option>
        </select>}
      </label>
      <span className="source-description">{offline.useDownload
        ? offline.state.ready ? "Using downloaded questions and images. Account sync is paused until you go online."
          : "No complete offline copy is available. Reconnect to download the question bank."
        : displayedSource === "firebase"
        ? "Questions and discussions from Firestore; images from Firebase Hosting."
        : "Question files included with the app, served by Firebase Hosting when online."}</span></>}
      {route.section !== "practice" && <span className="source-description">{offline.useDownload
        ? "Using the downloaded copy. New content requires an online update."
        : "Self-contained lessons and practice, with no live Azure resources required."}</span>}
      <div className="account-summary">
        <span>{accountStatus}</span>
        {user && <button className="button button-secondary button-small" disabled={study.profile.syncing || study.profile.conflict || offline.useDownload}
          onClick={() => void study.profile.sync()}>Save progress</button>}
      </div>
      <OfflineControls offline={offline} getReferences={() => {
        try {
          const guest = readPractice(window.localStorage);
          return { references: offlineSessionReferences(saved, guest.state),
            warning: guest.warning ? "Some older guest sessions could not be included. The current bank will still be downloaded." : null };
        } catch {
          return { references: offlineSessionReferences(saved),
            warning: "Guest session storage could not be read. The current bank and open account sessions will still be downloaded." };
        }
      }} />
    </section>
    <main className={`app-main app-main-${route.section}`} id="main-content" tabIndex={-1}>
      <div className="workspace-alerts">
      {route.error && <div className="notice notice-error" role="alert">{route.error}</div>}
      {account.error && <div className="notice notice-error" role="alert"><p>{account.error}</p>
        <button className="text-button" onClick={account.clearError}>Dismiss sign-in message</button></div>}
      {study.profile.warning && <div className="notice" role="alert"><p>{study.profile.warning}</p>
        {(study.profile.conflict || (user && study.profile.storageBlocked)) && <div className="conflict-actions">
          <button className="button button-secondary button-small" disabled={offline.useDownload} onClick={study.requestCloudVersion}>Load account version</button>
          {study.profile.conflict && <button className="button button-secondary button-small" disabled={offline.useDownload || !study.profile.pendingCount}
            onClick={study.requestSaveDevice}>Save this device's changes</button>}
        </div>}</div>}
      {study.notice && <div className="notice" role="alert"><p>{study.notice}</p>
        <button className="text-button" onClick={study.clearNotice} aria-label="Dismiss notice">Dismiss</button></div>}
      </div>
      {route.section === "exams" ? <ExamSelection course={course} onSelect={() => navigate("welcome")} />
        : route.section === "welcome" ? <Welcome course={course} progress={learning.progress}
        questionCount={catalog?.counts.questions} onLearn={(id) => navigate("learn", id ?? null)} onPractice={() => openPractice()} />
        : route.section === "learn" ? courseError
        ? <div className="notice notice-error" role="alert"><h1>Learning materials unavailable</h1><p>{courseError}</p>
          <button className="button button-secondary" onClick={() => setCourseRetry((value) => value + 1)}>Retry course</button></div>
        : course ? <CoursePage course={course} progress={learning.progress} activeLessonId={route.lessonId}
          warning={learning.warning} onOpenLesson={(id) => navigate("learn", id)} onOverview={() => navigate("learn")}
          onCheck={(lessonId, checkpointId, selectedIds) => learning.dispatch({ type: "check", lessonId, checkpointId, selectedIds })}
          onStudy={(lessonId, studied) => learning.dispatch({ type: "study", lessonId, studied })}
          onBookmark={(lessonId) => learning.dispatch({ type: "bookmark", lessonId })}
          onPractice={(topics) => openPractice("practice", topics)} />
          : <p className="loading-panel" role="status">Loading the course...</p>
        : <div className="practice-workspace">{!study.profile.ready ? <p className="loading-panel" role="status">Loading your account progress...</p> :
        view === "history" ? <History attempts={saved.history} signedIn={Boolean(user)}
          onOpen={(record) => void study.restore(record)} {...(!user ? { onClear: study.requestClearHistory } : {})} /> :
        view === "statistics" ? <Statistics attempts={saved.history} signedIn={Boolean(user)} /> :
        view === "session" && attempt && study.documents.length > 0 ? <Session study={study} /> :
        study.catalogError ? <div className="notice notice-error" role="alert">
        <h1>Question bank unavailable</h1><p>{study.catalogError}</p>
        <button className="button button-secondary" onClick={study.retryCatalog}>Retry question data</button></div> :
        !catalog ? <p className="loading-panel" role="status">Loading question bank...</p> : <>
          {view === "home" && <Home catalog={catalog} activeAttempt={saved.activeAttempt}
            signedIn={Boolean(user)}
            onPractice={() => study.openView("practice")} onExam={() => study.openView("exam")}
            onLibrary={() => study.openView("library")} onResume={(record) => void study.restore(record)} />}
          {view === "library" && <Library catalog={catalog} repository={study.repository} />}
          {(view === "practice" || view === "exam") && <Setup key={view}
            mode={view === "exam" ? "exam" : "free"} catalog={catalog} onStart={study.start}
            {...(practiceTopics ? { initialTopics: practiceTopics } : {})} />}
          {view === "session" && <Session study={study} />}
        </>}</div>}
    </main>
    {busy && <div className="busy-overlay"><div role="status"><span className="spinner" /><p>{busy}</p></div></div>}
    {confirmation && <Modal title={confirmation === "use-cloud" ? "Load the account version?" :
      confirmation === "save-device" ? "Save this device's changes?" : confirmation === "replace" ? "Replace unfinished session?" :
      confirmation === "history" ? "Clear history?" : "Finish session?"} onClose={study.cancelConfirmation}>
      <p>{confirmation === "use-cloud" ? "This replaces this device's unsynced account progress with the saved cloud version. Guest progress is not affected." :
        confirmation === "save-device" ? "Save these pending sessions to your account, replacing conflicting versions of the same sessions. Other completed sessions are kept." :
        confirmation === "replace" ? "Starting a new session will replace your unfinished attempt. Completed history is kept." :
        confirmation === "history" ? "Remove completed sessions from this browser? Your active session and question files will be kept." :
          `${unanswered} questions have no recorded answer. Finish now and review the results?`}</p>
      <div className="modal-actions"><button className="button button-secondary" onClick={study.cancelConfirmation}>Cancel</button>
        <button className="button button-primary" onClick={study.confirm}>
          {confirmation === "use-cloud" ? "Load account version" : confirmation === "save-device" ? "Save device changes" :
            confirmation === "replace" ? "Start new session" : confirmation === "history" ? "Clear history" : "Finish and review"}
        </button></div>
    </Modal>}
    {signOutConfirmation && <Modal title="Sign out with unsynced progress?" onClose={() => setSignOutConfirmation(false)}>
      <p>Your pending progress will remain on this device, under your account. Sign in again on this browser to sync it.</p>
      <div className="modal-actions">
        <button className="button button-secondary" onClick={() => setSignOutConfirmation(false)}>Cancel</button>
        <button className="button button-primary" onClick={() => void account.signOut()}>Sign out</button>
      </div>
    </Modal>}
  </div>;
}
