import { CleanReleaseIdSchema, mediaExtension } from "../domain/cleanBank.js";
import { StudyReleasePointerSchema } from "../domain/learning.js";
import { Sc900StudyReleasePointerSchema } from "../domain/sc900Learning.js";
import { assertExam, examBaseUrl, examConfig, type ExamId } from "../domain/exams.js";
import { bankContract, validateDiscussionThreads } from "./bank-contract.js";
import type { StudyCatalog, StudyDocument, StudyRepository } from "./types.js";

export interface StudyCloudReader {
  document(path: string): Promise<unknown>;
  comments(questionId: string, expectedCount: number, releaseId?: string): Promise<unknown[]>;
}

export function createFirestoreStudyRepository(
  reader: StudyCloudReader, archive: StudyRepository, mediaBaseUrl: string,
  examId: ExamId = "az104",
): StudyRepository {
  const base = new URL(examBaseUrl(mediaBaseUrl, examId));
  const contract = bankContract(examId);
  const releaseRoot = (releaseId: string) => examId === "sc900"
    ? `studyBanks/sc900/releases/${releaseId}` : `studyReleases/${releaseId}`;
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error("Invalid study media origin.");
  }
  let catalogPromise: Promise<StudyCatalog> | undefined;
  let currentCatalog: StudyCatalog | undefined;
  const questions = new Map<string, Promise<StudyDocument>>();
  const discussions = new Map<string, ReturnType<StudyRepository["loadDiscussion"]>>();

  const loadCurrentCatalog = () => {
    if (!catalogPromise) {
      const pending = reader.document(examConfig(examId).bankMetadataPath).then(async (raw) => {
        const pointer = (examId === "sc900" ? Sc900StudyReleasePointerSchema : StudyReleasePointerSchema).parse(raw);
        if (examId === "sc900") Sc900StudyReleasePointerSchema.parse(pointer);
        const value: StudyCatalog = contract.catalog.parse(await reader.document(`${releaseRoot(pointer.releaseId)}/catalogs/${examId}`));
        assertExam(value, examId);
        if (value.releaseId !== pointer.releaseId || value.sourceRevision !== pointer.sourceRevision ||
            JSON.stringify(value.discussionScope) !== JSON.stringify("discussionScope" in pointer ? pointer.discussionScope : undefined)) {
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
      const document: StudyDocument = contract.document.parse(await reader.document(`${releaseRoot(catalog.releaseId)}/questions/${id}`));
      assertExam(document, examId);
      const { question, answers } = document;
      if (document.releaseId !== catalog.releaseId ||
          question.id !== id || question.commentCount !== summary.commentCount ||
          JSON.stringify(question.discussionScope) !== JSON.stringify(catalog.discussionScope) ||
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
    examId,
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
      if (!summary.discussionEnabled) return {
        schemaVersion: 1, ...(examId === "sc900" ? { examId } : {}),
        ...(catalog.discussionScope ? { discussionScope: catalog.discussionScope } : {}),
        releaseId: catalog.releaseId, questionId: id, comments: [],
      };
      const cached = discussions.get(id);
      if (cached) return cached;
      const pending = (async () => {
        const comments = await reader.comments(id, summary.commentCount, catalog.releaseId);
        const result: Awaited<ReturnType<StudyRepository["loadDiscussion"]>> = contract.discussion.parse({
          schemaVersion: 1, ...(examId === "sc900" ? { examId } : {}),
          releaseId: catalog.releaseId, questionId: id, comments,
        });
        assertExam(result, examId);
        if (result.comments.length !== summary.commentCount) throw new Error("Firestore discussion is incomplete.");
        validateDiscussionThreads(result);
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
      const asset = contract.question.parse(question).media.find((item) => item.id === assetId);
      if (!asset || asset.objectPath !== `published/${examId}/${version}/assets/${asset.id}.${mediaExtension(asset.contentType)}`) {
        throw new Error("Invalid question image reference.");
      }
      return new URL(`content/${version}/media/${asset.id}.${mediaExtension(asset.contentType)}`, base).href;
    },
  };
}
