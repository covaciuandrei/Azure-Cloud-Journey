import { TopicMapSchema, type TopicMap } from "../domain/topics.js";
import type { StudyRepository } from "./types.js";

export function createTopicLoader(read: () => Promise<unknown>): () => Promise<TopicMap> {
  let promise: Promise<TopicMap> | undefined;
  return () => {
    if (!promise) {
      const pending = read().then((value) => TopicMapSchema.parse(value));
      promise = pending;
      void pending.catch(() => { if (promise === pending) promise = undefined; });
    }
    return promise;
  };
}

export function createHttpTopicLoader(base: string, fetcher: typeof fetch = fetch): () => Promise<TopicMap> {
  const origin = new URL(base);
  if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password) {
    throw new Error("Invalid topic data origin.");
  }
  const url = new URL("data/topics.json", origin);
  return createTopicLoader(async () => {
    const response = await fetcher(url.href, { cache: "no-store", redirect: "error", credentials: "same-origin" });
    if (!response.ok) throw new Error("Topic classification is unavailable. Retry online or update the offline download.");
    try { return await response.json(); }
    catch { throw new Error("Topic data could not be read. Retry online or update the offline download."); }
  });
}

export function withQuestionTopics(repository: StudyRepository, loadTopics: () => Promise<TopicMap>): StudyRepository {
  const assignment = async (id: string, releaseId?: string) => {
    const topics = await loadTopics();
    const catalog = await repository.loadCatalog(releaseId);
    if (topics.sourceRevision !== catalog.sourceRevision || !topics.assignments[id]?.length) {
      throw new Error("Question topics do not match this question bank.");
    }
    return [...topics.assignments[id]!];
  };
  return {
    ...(repository.loadExplanation ? { loadExplanation: repository.loadExplanation.bind(repository) } : {}),
    async loadCatalog(releaseId) {
      const catalog = await repository.loadCatalog(releaseId);
      const topics = await loadTopics();
      if (topics.sourceRevision !== catalog.sourceRevision ||
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
