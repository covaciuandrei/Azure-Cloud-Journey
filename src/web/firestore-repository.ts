import {
  CleanCatalogSchema, CleanDocumentSchema, CleanDiscussionSchema,
  CleanQuestionSchema, CleanReleaseIdSchema, assertDiscussionThreads, mediaExtension,
} from "../domain/cleanBank.js";
import { STUDY_CURRENT_BANK_PATH } from "../domain/cloud.js";
import { StudyReleasePointerSchema } from "../domain/learning.js";
import type { StudyCatalog, StudyDocument, StudyRepository } from "./types.js";

export interface StudyCloudReader {
  document(path: string): Promise<unknown>;
  comments(questionId: string, expectedCount: number): Promise<unknown[]>;
}

export function createFirestoreStudyRepository(
  reader: StudyCloudReader, archive: StudyRepository, mediaBaseUrl: string,
): StudyRepository {
  const base = new URL(mediaBaseUrl);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error("Invalid study media origin.");
  }
  let catalogPromise: Promise<StudyCatalog> | undefined;
  let currentCatalog: StudyCatalog | undefined;
  const questions = new Map<string, Promise<StudyDocument>>();
  const discussions = new Map<string, ReturnType<StudyRepository["loadDiscussion"]>>();

  const loadCurrentCatalog = () => {
    if (!catalogPromise) {
      const pending = reader.document(STUDY_CURRENT_BANK_PATH).then(async (raw) => {
        const pointer = StudyReleasePointerSchema.parse(raw);
        const value = CleanCatalogSchema.parse(await reader.document(`studyReleases/${pointer.releaseId}/catalogs/az104`));
        if (value.releaseId !== pointer.releaseId || value.sourceRevision !== pointer.sourceRevision) {
          throw new Error("Firestore catalog does not match the current study release.");
        }
        if (value.questions.length !== value.counts.questions ||
            new Set(value.questions.map((question) => question.id)).size !== value.questions.length ||
            value.questions.reduce((sum, question) => sum + question.commentCount, 0) !== value.counts.comments) {
          throw new Error("Firestore catalog counts are inconsistent.");
        }
        currentCatalog = value;
        return value;
      });
      catalogPromise = pending;
      void pending.catch(() => { if (catalogPromise === pending) catalogPromise = undefined; });
    }
    return catalogPromise;
  };
  const loadCatalog = async (releaseId?: string) => {
    if (releaseId !== undefined) CleanReleaseIdSchema.parse(releaseId);
    const current = await loadCurrentCatalog();
    return releaseId && releaseId !== current.releaseId ? archive.loadCatalog(releaseId) : current;
  };
  const loadQuestion = async (id: string, releaseId?: string): Promise<StudyDocument> => {
    const catalog = await loadCatalog(releaseId);
    if (catalog.releaseId !== currentCatalog?.releaseId) return archive.loadQuestion(id, catalog.releaseId);
    const summary = catalog.questions.find((question) => question.id === id);
    if (!summary) throw new Error(`Unknown question ID: ${id}`);
    const existing = questions.get(id);
    if (existing) return existing;
    const pending = (async () => {
      const document = CleanDocumentSchema.parse(await reader.document(`studyReleases/${catalog.releaseId}/questions/${id}`));
      const { question, answers } = document;
      if (document.releaseId !== catalog.releaseId ||
          question.id !== id || question.commentCount !== summary.commentCount ||
          question.readiness.grading !== summary.grading || answers.provisional !== summary.provisional) {
        throw new Error(`Firestore question ${id} does not match the active catalog.`);
      }
      return document;
    })();
    questions.set(id, pending);
    void pending.catch(() => { if (questions.get(id) === pending) questions.delete(id); });
    return pending;
  };
  return {
    loadCatalog, loadQuestion,
    async loadQuestions(ids, releaseId) {
      if (new Set(ids).size !== ids.length) throw new Error("Duplicate question IDs are not allowed.");
      const catalog = await loadCatalog(releaseId);
      if (ids.some((id) => !catalog.questions.some((item) => item.id === id))) throw new Error("Unknown question ID.");
      const documents = new Array<StudyDocument>(ids.length);
      let next = 0;
      const worker = async () => {
        while (next < ids.length) {
          const index = next++;
          documents[index] = await loadQuestion(ids[index]!, releaseId);
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, ids.length) }, worker));
      return documents;
    },
    async loadDiscussion(id, releaseId) {
      const catalog = await loadCatalog(releaseId);
      if (catalog.releaseId !== currentCatalog?.releaseId) return archive.loadDiscussion(id, catalog.releaseId);
      const summary = catalog.questions.find((question) => question.id === id);
      if (!summary) throw new Error(`Unknown question ID: ${id}`);
      if (!summary.discussionEnabled) return { schemaVersion: 1, releaseId: catalog.releaseId, questionId: id, comments: [] };
      const cached = discussions.get(id);
      if (cached) return cached;
      const pending = (async () => {
        const comments = await reader.comments(id, summary.commentCount);
        const result = CleanDiscussionSchema.parse({ schemaVersion: 1, releaseId: catalog.releaseId, questionId: id, comments });
        if (result.comments.length !== summary.commentCount) throw new Error("Firestore discussion is incomplete.");
        assertDiscussionThreads(result);
        return result;
      })();
      discussions.set(id, pending);
      void pending.catch(() => { if (discussions.get(id) === pending) discussions.delete(id); });
      return pending;
    },
    mediaUrl(question, assetId, releaseId) {
      const version = releaseId ?? currentCatalog?.releaseId;
      if (version && version !== currentCatalog?.releaseId) return archive.mediaUrl(question, assetId, version);
      if (!currentCatalog?.questions.some((item) => item.id === question.id)) throw new Error("Load the catalog before resolving images.");
      const asset = CleanQuestionSchema.parse(question).media.find((item) => item.id === assetId);
      if (!asset || asset.objectPath !== `published/az104/${version}/assets/${asset.id}.${mediaExtension(asset.contentType)}`) {
        throw new Error("Invalid question image reference.");
      }
      return new URL(`content/${version}/media/${asset.id}.${mediaExtension(asset.contentType)}`, base).href;
    },
  };
}
