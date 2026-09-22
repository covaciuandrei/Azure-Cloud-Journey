import { LearningExplanationSchema, LearningManifestSchema, type LearningExplanation, type LearningManifest } from "../domain/learning.js";
import type { StudyDocument, StudyRepository } from "./types.js";
import type { z } from "zod";
import { Sc900LearningManifestSchema, Sc900LearningExplanationSchema } from "../domain/sc900Learning.js";
import { assertExam, examBaseUrl, type ExamId } from "../domain/exams.js";
import { CleanReleaseIdSchema } from "../domain/cleanBank.js";
import { QuestionIdSchema } from "../domain/schemas.js";
import { loadSc900Manifest } from "./sc900-http.js";

export interface LearningReader {
  manifest(releaseId?: string): Promise<unknown>;
  explanation(releaseId: string, questionId: string): Promise<unknown>;
}

export function httpLearningReader(baseUrl: string, fetcher: typeof fetch = fetch, examId: ExamId = "az104"): LearningReader {
  const base = new URL(examBaseUrl(baseUrl, examId));
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) throw new Error("Invalid explanation origin.");
  const read = async (path: string) => {
    const response = await fetcher(new URL(path, base).href, {
      cache: "no-store", credentials: "same-origin", redirect: "error",
    });
    if (!response.ok) throw new Error(`The teaching explanation could not be loaded (HTTP ${response.status}).`);
    try { return await response.json(); }
    catch { throw new Error("The teaching explanation response was invalid. Retry online or update the offline download."); }
  };
  return {
    manifest: async (releaseId) => {
      const version = examId === "sc900" ? releaseId === undefined
        ? (await loadSc900Manifest(baseUrl, fetcher)).releaseId : CleanReleaseIdSchema.parse(releaseId) : undefined;
      return read(version ? `content/${version}/learning/manifest.json` : "data/learning.json");
    },
    explanation: (releaseId, questionId) =>
      read(examId === "sc900"
        ? `content/${CleanReleaseIdSchema.parse(releaseId)}/learning/questions/${QuestionIdSchema.parse(questionId)}.json`
        : `teaching/${CleanReleaseIdSchema.parse(releaseId)}/questions/${QuestionIdSchema.parse(questionId)}.json`),
  };
}

export function withLearningExplanations(
  repository: StudyRepository, reader: LearningReader,
  manifestSchema?: z.ZodType<LearningManifest>,
): StudyRepository {
  const examId = repository.examId ?? "az104";
  const schema = manifestSchema ?? (examId === "sc900" ? Sc900LearningManifestSchema : LearningManifestSchema);
  const manifestPromises = new Map<string, Promise<LearningManifest>>();
  const records = new Map<string, Promise<LearningExplanation>>();
  const manifest = (releaseId?: string) => {
    const key = examId === "sc900" ? releaseId ?? "current" : "current";
    let promise = manifestPromises.get(key);
    if (!promise) {
      const pending = reader.manifest(examId === "sc900" ? releaseId : undefined).then((value) => {
        const parsed = schema.parse(value);
        assertExam(parsed, examId);
        if (examId === "sc900" && releaseId && parsed.releaseId !== releaseId) {
          throw new Error("SC-900 teaching manifest belongs to a different release.");
        }
        return parsed;
      });
      promise = pending;
      manifestPromises.set(key, pending);
      void pending.catch(() => { if (manifestPromises.get(key) === pending) manifestPromises.delete(key); });
    }
    return promise;
  };
  return {
    ...repository,
    async loadExplanation(document: StudyDocument) {
      assertExam(document, examId);
      const index = await manifest(document.releaseId);
      const binding = index.records[document.question.id];
      if (!binding?.sourceRevisions.includes(document.question.sourceRevision)) {
        throw new Error("The explanation does not match this saved question revision.");
      }
      const recordKey = `${index.releaseId}/${document.question.id}`;
      let pending = records.get(recordKey);
      if (!pending) {
        pending = reader.explanation(index.releaseId, document.question.id).then((value) => {
          const parsed = (examId === "sc900" ? Sc900LearningExplanationSchema : LearningExplanationSchema).parse(value);
          assertExam(parsed, examId);
          return parsed;
        });
        records.set(recordKey, pending);
        const current = pending;
        void pending.catch(() => { if (records.get(recordKey) === current) records.delete(recordKey); });
      }
      const explanation = await pending;
      const optionIds = new Set(document.question.options.map((option) => option.id));
      if (!binding.sourceRevisions.includes(explanation.questionSourceRevision)) {
        throw new Error("The teaching content references an unrecognized source revision.");
      }
      if (explanation.questionId !== document.question.id ||
          explanation.options.length !== optionIds.size ||
          explanation.options.some((option) => !optionIds.has(option.optionId)) ||
          explanation.correctOptionIds?.some((id) => !optionIds.has(id))) {
        throw new Error("The explanation references different answer choices.");
      }
      return { explanation, currentReleaseId: index.releaseId };
    },
  };
}
