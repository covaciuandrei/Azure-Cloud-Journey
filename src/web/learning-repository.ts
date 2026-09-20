import { LearningExplanationSchema, LearningManifestSchema, type LearningExplanation, type LearningManifest } from "../domain/learning.js";
import type { StudyDocument, StudyRepository } from "./types.js";
import type { z } from "zod";

export interface LearningReader {
  manifest(): Promise<unknown>;
  explanation(releaseId: string, questionId: string): Promise<unknown>;
}

export function httpLearningReader(baseUrl: string, fetcher: typeof fetch = fetch): LearningReader {
  const base = new URL(baseUrl);
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
    manifest: () => read("data/learning.json"),
    explanation: (releaseId, questionId) => read(`teaching/${releaseId}/questions/${questionId}.json`),
  };
}

export function withLearningExplanations(
  repository: StudyRepository, reader: LearningReader,
  manifestSchema: z.ZodType<LearningManifest> = LearningManifestSchema,
): StudyRepository {
  let manifestPromise: Promise<LearningManifest> | undefined;
  const records = new Map<string, Promise<LearningExplanation>>();
  const manifest = () => {
    if (!manifestPromise) {
      const pending = reader.manifest().then((value) => manifestSchema.parse(value));
      manifestPromise = pending;
      void pending.catch(() => { if (manifestPromise === pending) manifestPromise = undefined; });
    }
    return manifestPromise;
  };
  return {
    ...repository,
    async loadExplanation(document: StudyDocument) {
      const index = await manifest();
      const binding = index.records[document.question.id];
      if (!binding?.sourceRevisions.includes(document.question.sourceRevision)) {
        throw new Error("The explanation does not match this saved question revision.");
      }
      let pending = records.get(document.question.id);
      if (!pending) {
        pending = reader.explanation(index.releaseId, document.question.id).then((value) => LearningExplanationSchema.parse(value));
        records.set(document.question.id, pending);
        const current = pending;
        void pending.catch(() => { if (records.get(document.question.id) === current) records.delete(document.question.id); });
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
