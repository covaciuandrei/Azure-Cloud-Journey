import { useCallback, useEffect, useRef, useState } from "react";
import { createStudyRepository } from "../data.js";
import { createDemoRepository } from "../demo-repository.js";
import { createFirestoreStudyRepository } from "../firestore-repository.js";
import { createStudyCloudReader } from "../firestore-source.js";
import { STUDY_HOSTING_ORIGIN } from "../../domain/cloud.js";
import { assertExam, examConfig, type ExamId } from "../../domain/exams.js";
import { Sc900LearningManifestSchema } from "../../domain/sc900Learning.js";
import type { DataSource } from "../profile-storage.js";
import { useAccountPractice } from "./useAccountPractice.js";
import { createOfflineAwareRepository } from "../offline-repository.js";
import { createHttpTopicLoader, createTopicLoader, withQuestionTopics } from "../topic-repository.js";
import {
  topicIdsForExam, parseTopicSelection, matchesStudyTopics as matchesTopics, type StudyTopicId as TopicId,
} from "../../domain/examTopics.js";
import { httpLearningReader, withLearningExplanations } from "../learning-repository.js";
import { httpEligibilityLoader, withCurrentQuestions } from "../eligibility-repository.js";
import {
  createAttempt, reduceAttempt, remainingSeconds, sampleQuestionIds, validateAttemptDocuments,
  type PracticeAction, type PracticeAttempt, type PracticeMode, type PracticeResponse,
} from "../engine.js";
import type { StudyCatalog, StudyDocument } from "../types.js";

export type StudyView = "home" | "library" | "practice" | "exam" | "history" | "statistics" | "session";
export type Confirmation = "replace" | "finish" | "history" | "use-cloud" | "save-device" | null;
export const messageOf = (error: unknown) => error instanceof Error ? error.message : "The study data could not be loaded.";

export function answered(response: PracticeResponse | undefined, grading?: "automatic" | "manual"): boolean {
  if (!response) return false;
  return grading === "manual"
    ? Boolean(response.note.trim() || (response.submitted && response.selfAssessment !== "skip") ||
      (response.selfAssessment && response.selfAssessment !== "skip"))
    : response.selectedIds.length > 0;
}

export function useStudy(uid: string | null = null, useDownload = false, autoResume = true, examId: ExamId = "az104") {
  const profile = useAccountPractice(uid, !useDownload, examId);
  const TOPIC_IDS = topicIdsForExam(examId);
  const { saved } = profile;
  const offlineRef = useRef(useDownload);
  offlineRef.current = useDownload;
  const [repositories] = useState(() => {
    const base = new URL(import.meta.env.BASE_URL, window.location.origin).href;
    if (import.meta.env.VITE_STUDY_DEMO === "true") {
      return { snapshot: createDemoRepository(base, fetch, examId), firebase: null };
    }
    const snapshotCore = createStudyRepository(base, fetch, examId);
    const snapshot = withCurrentQuestions(withLearningExplanations(
      withQuestionTopics(snapshotCore, createHttpTopicLoader(base, fetch, examId)), httpLearningReader(base, fetch, examId)), httpEligibilityLoader(base, fetch, examId));
    const offlineFetch: typeof fetch = (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("X-AZ104-Offline", "1");
      return fetch(input, { ...init, headers });
    };
    const downloaded = withCurrentQuestions(withLearningExplanations(
      withQuestionTopics(createStudyRepository(base, offlineFetch, examId), createHttpTopicLoader(base, offlineFetch, examId)),
      httpLearningReader(base, offlineFetch, examId)), httpEligibilityLoader(base, offlineFetch, examId));
    const wrap = (primary: typeof snapshot) =>
      createOfflineAwareRepository(primary, downloaded, () => offlineRef.current, base, examId);
    const cloud = uid ? createStudyCloudReader(uid, examId) : null;
    const httpTopics = createHttpTopicLoader(base, fetch, examId);
    return {
      snapshot: wrap(snapshot),
      firebase: cloud ? wrap(withCurrentQuestions(withLearningExplanations(withQuestionTopics(
        createFirestoreStudyRepository(cloud, snapshotCore, STUDY_HOSTING_ORIGIN, examId),
        createTopicLoader((releaseId) => examId === "sc900" && releaseId
          ? httpTopics(releaseId) : cloud.document(examConfig(examId).topicsMetadataPath), examId),
      ), {
        manifest: async (releaseId) => {
          const value = await cloud.document(examConfig(examId).learningMetadataPath);
          return examId === "sc900" && releaseId && Sc900LearningManifestSchema.parse(value).releaseId !== releaseId
            ? httpLearningReader(base, fetch, examId).manifest(releaseId) : value;
        },
        explanation: (releaseId, questionId) => cloud.document(examId === "sc900"
          ? `studyBanks/sc900/releases/${releaseId}/explanations/${questionId}`
          : `studyExplanations/${releaseId}/questions/${questionId}`),
      }), httpEligibilityLoader(base, fetch, examId))) : null,
    };
  });
  const repository = repositories[profile.dataSource] ?? repositories.snapshot;
  const repositoryFor = useCallback((source: DataSource) => {
    const value = repositories[source];
    if (!value) throw new Error("Sign in to resume a session that uses Firestore.");
    return value;
  }, [repositories]);
  const [view, setView] = useState<StudyView>(saved.activeAttempt ? "session" : "home");
  const [catalog, setCatalog] = useState<StudyCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<PracticeAttempt | null>(null);
  const attemptRef = useRef<PracticeAttempt | null>(null);
  const [documents, setDocuments] = useState<StudyDocument[]>([]);
  const documentsRef = useRef<StudyDocument[]>([]);
  const [now, setNow] = useState(Date.now);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const pendingStart = useRef<{ mode: PracticeMode; count: number; automaticOnly: boolean; topics: TopicId[] }>({
    mode: "free", count: 10, automaticOnly: false, topics: [...TOPIC_IDS],
  });
  const restoredOnce = useRef(false);
  const lastRepository = useRef<typeof repository | null>(null);

  useEffect(() => {
    let mounted = true;
    if (lastRepository.current !== repository) setCatalog(null);
    lastRepository.current = repository;
    setCatalogError(null);
    repository.loadCatalog().then((value) => {
      assertExam(value, examId);
      if (mounted) setCatalog(value);
    }).catch((error: unknown) => { if (mounted) setCatalogError(messageOf(error)); });
    return () => { mounted = false; };
  }, [repository, retry, useDownload]);

  const commit = useCallback((record: PracticeAttempt, saveImmediately = false) => {
    attemptRef.current = record;
    setAttempt(record);
    profile.commitRecord(record, saveImmediately);
  }, [profile.commitRecord]);

  const act = useCallback((action: PracticeAction) => {
    const current = attemptRef.current;
    if (!current) { setNotice("No session is open."); return; }
    try {
      assertExam(current, examId);
      const next = reduceAttempt(current, action, documentsRef.current, Date.now());
      if (next !== current) commit(next, next.status === "completed" && current.status !== "completed");
    }
    catch (error) { setNotice(messageOf(error)); }
  }, [commit, examId]);

  useEffect(() => {
    if (attempt?.status !== "active" || attempt.mode !== "exam") return;
    const tick = () => {
      const time = Date.now();
      setNow(time);
      const current = attemptRef.current;
      if (current?.status === "active" && remainingSeconds(current, time) === 0) {
        act({ type: "finish" });
        setView("session");
        setNotice("Time is up. The exam has been submitted.");
      }
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [attempt?.id, attempt?.mode, attempt?.status, act]);

  const restore = useCallback(async (record: PracticeAttempt) => {
    restoredOnce.current = true;
    setBusy("Opening saved session...");
    try {
      assertExam(record, examId);
      const data = await repositoryFor(record.dataSource ?? "snapshot").loadQuestions(record.questionIds, record.releaseId);
      validateAttemptDocuments(record, data);
      documentsRef.current = data;
      setDocuments(data);
      const value = record.status === "active" && remainingSeconds(record, Date.now()) === 0
        ? reduceAttempt(record, { type: "finish" }, data, Date.now()) : record;
      attemptRef.current = value;
      setAttempt(value);
      if (value !== record) profile.commitRecord(value, true);
      setView("session");
      if (value.status === "completed" && record.status === "active") {
        setNotice("The timer expired while you were away. Your saved answers were submitted.");
      }
    } catch (error) {
      setNotice(`This session could not be opened: ${messageOf(error)}`);
      setView("library");
    } finally { setBusy(null); }
  }, [repositoryFor, profile.commitRecord, examId]);

  useEffect(() => {
    if (!autoResume || !catalog || !profile.ready || restoredOnce.current) return;
    restoredOnce.current = true;
    const current = saved.activeAttempt;
    if (current) void restore(current);
  }, [autoResume, catalog, profile.ready, saved.activeAttempt, restore]);

  const openView = (next: StudyView) => {
    setView(next);
    window.scrollTo({ top: 0 });
  };

  const begin = async (mode: PracticeMode, size: number, automaticOnly: boolean, topics: readonly TopicId[]) => {
    if (!catalog) { setNotice("The question bank is not loaded yet."); return; }
    if (!profile.ready) { setNotice("Wait for your account progress to load."); return; }
    if (profile.pendingCount >= 100) { setNotice("Save pending account sessions before starting another one."); return; }
    setConfirmation(null);
    setBusy(`Loading ${mode === "exam" ? 40 : size} questions...`);
    try {
      const selection = parseTopicSelection(topics, examId);
      if (!selection.length) throw new Error("Select at least one topic.");
      const id = crypto.randomUUID();
      const pool = catalog.questions.filter((question) =>
        (!automaticOnly || question.grading === "automatic") && matchesTopics(question.topicIds, selection));
      const requested = mode === "exam" ? 40 : size;
      if (pool.length < requested) throw new Error(`Only ${pool.length} questions match the selected topics; ${requested} are required.`);
      const ids = sampleQuestionIds(pool, mode === "exam" ? 40 : size, id);
      const data = await repository.loadQuestions(ids, catalog.releaseId);
      const value = createAttempt({ examId, mode, documents: data, id, seed: id, now: Date.now(), dataSource: profile.dataSource });
      documentsRef.current = data;
      setDocuments(data);
      commit(value, true);
      openView("session");
    } catch (error) { setNotice(messageOf(error)); }
    finally { setBusy(null); }
  };

  const start = (mode: PracticeMode, size: number, automaticOnly: boolean, topics: TopicId[] = [...TOPIC_IDS]) => {
    pendingStart.current = { mode, count: size, automaticOnly, topics: [...topics] };
    if (saved.activeAttempt) setConfirmation("replace");
    else void begin(mode, size, automaticOnly, topics);
  };

  const confirm = () => {
    if (confirmation === "replace") {
      const pending = pendingStart.current;
      void begin(pending.mode, pending.count, pending.automaticOnly, pending.topics);
    } else if (confirmation === "history") {
      profile.clearLocalHistory();
      setConfirmation(null);
    } else if (confirmation === "finish") {
      act({ type: "finish" });
      setView("session");
      setConfirmation(null);
      window.scrollTo({ top: 0 });
    } else if (confirmation === "use-cloud") {
      setConfirmation(null);
      void profile.loadCloudVersion().then(() => {
        attemptRef.current = null;
        setAttempt(null);
        documentsRef.current = [];
        setDocuments([]);
        setView("home");
      });
    } else if (confirmation === "save-device") {
      setConfirmation(null);
      void profile.useDeviceVersion();
    }
  };

  return {
    repository: view === "session" && attempt ? repositoryFor(attempt.dataSource ?? "snapshot") : repository,
    catalog, catalogError, retryCatalog: () => setRetry((value) => value + 1),
    saved, view, openView, attempt, documents, now, busy, notice,
    clearNotice: () => setNotice(null), act, restore, start, confirmation, confirm,
    cancelConfirmation: () => setConfirmation(null),
    requestFinish: () => setConfirmation("finish"),
    requestClearHistory: () => setConfirmation("history"),
    profile,
    setDataSource(source: DataSource) {
      profile.setDataSource(source);
      setView("home");
    },
    requestCloudVersion: () => setConfirmation("use-cloud"),
    requestSaveDevice: () => setConfirmation("save-device"),
    offlineMode: useDownload,
  };
}

export type StudyController = ReturnType<typeof useStudy>;
