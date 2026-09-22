import { TopicMapSchema, type TopicMap } from "../domain/topics.js";
import { Sc900TopicMapSchema, type Sc900TopicMap } from "../domain/sc900Topics.js";
import { assertExam, examBaseUrl, type ExamId } from "../domain/exams.js";
import { CleanReleaseIdSchema } from "../domain/cleanBank.js";
import { loadSc900Manifest } from "./sc900-http.js";
import type { StudyRepository } from "./types.js";

type RuntimeTopicMap = TopicMap | Sc900TopicMap;
export function createTopicLoader(read: (releaseId?: string) => Promise<unknown>, examId: ExamId = "az104") {
  const promises = new Map<string, Promise<RuntimeTopicMap>>();
  return (releaseId?: string): Promise<RuntimeTopicMap> => {
    if (releaseId !== undefined) CleanReleaseIdSchema.parse(releaseId);
    const key = releaseId ?? "current";
    let promise = promises.get(key);
    if (!promise) {
      const pending = read(releaseId).then((value) => {
        const topics = (examId === "sc900" ? Sc900TopicMapSchema : TopicMapSchema).parse(value);
        assertExam(topics, examId);
        return topics;
      });
      promise = pending;
      promises.set(key, pending);
      void pending.catch(() => { if (promises.get(key) === pending) promises.delete(key); });
    }
    return promise;
  };
}

export function createHttpTopicLoader(base: string, fetcher: typeof fetch = fetch, examId: ExamId = "az104") {
  const origin = new URL(examBaseUrl(base, examId));
  if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password) {
    throw new Error("Invalid topic data origin.");
  }
  return createTopicLoader(async (releaseId) => {
    const version = examId === "sc900" ? releaseId ?? (await loadSc900Manifest(base, fetcher)).releaseId : undefined;
    const url = new URL(version ? `content/${version}/topics.json` : "data/topics.json", origin);
    const response = await fetcher(url.href, { cache: "no-store", redirect: "error", credentials: "same-origin" });
    if (!response.ok) throw new Error("Topic classification is unavailable. Retry online or update the offline download.");
    try { return await response.json(); }
    catch { throw new Error("Topic data could not be read. Retry online or update the offline download."); }
  }, examId);
}

export function withQuestionTopics(repository: StudyRepository, loadTopics: (releaseId?: string) => Promise<RuntimeTopicMap>): StudyRepository {
  const examId = repository.examId ?? "az104";
  const assignment = async (id: string, releaseId?: string) => {
    const topics = await loadTopics(releaseId);
    const catalog = await repository.loadCatalog(releaseId);
    assertExam(topics, examId);
    assertExam(catalog, examId);
    if (topics.sourceRevision !== catalog.sourceRevision || !topics.assignments[id]?.length) {
      throw new Error("Question topics do not match this question bank.");
    }
    return [...topics.assignments[id]!];
  };
  return {
    examId,
    ...(repository.loadExplanation ? { loadExplanation: repository.loadExplanation.bind(repository) } : {}),
    async loadCatalog(releaseId) {
      const catalog = await repository.loadCatalog(releaseId);
      const topics = await loadTopics(releaseId);
      assertExam(topics, examId);
      assertExam(catalog, examId);
      if (topics.sourceRevision !== catalog.sourceRevision ||
          (examId === "sc900" && ("releaseId" in topics && topics.releaseId !== catalog.releaseId ||
            Object.keys(topics.assignments).length !== catalog.questions.length)) ||
          catalog.questions.some((question) => !topics.assignments[question.id]?.length)) {
        throw new Error("Topic classification is incomplete for this question bank.");
      }
      return {
        ...catalog,
        questions: catalog.questions.map((question) => ({ ...question, topicIds: [...topics.assignments[question.id]!] })),
      };
    },
    async loadQuestion(id, releaseId) {
      const document = await repository.loadQuestion(id, releaseId);
      return { ...document, topicIds: await assignment(id, document.releaseId) };
    },
    async loadQuestions(ids, releaseId) {
      const documents = await repository.loadQuestions(ids, releaseId);
      return Promise.all(documents.map(async (document) => ({
        ...document, topicIds: await assignment(document.question.id, document.releaseId),
      })));
    },
    loadDiscussion: (id, releaseId) => repository.loadDiscussion(id, releaseId),
    mediaUrl: (question, assetId, releaseId) => repository.mediaUrl(question, assetId, releaseId),
  };
}
