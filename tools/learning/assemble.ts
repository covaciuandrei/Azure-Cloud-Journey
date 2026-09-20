import { z } from "zod";
import { LearningDatasetSchema, LearningExplanationSchema } from "../../src/domain/learning.js";
import { digest } from "../ingest/normalize-shared.js";
import { readData, writeData } from "../review/data.js";
import { loadAuthoredExplanations, validateExplanation } from "./validate.js";

const { bank, current, records } = await loadAuthoredExplanations();
const approvals = await readData(".data/learning/approved-corrections.json", z.array(z.object({
  questionId: z.string(), explanationDigest: z.string().regex(/^[a-f0-9]{64}$/), note: z.string().min(20),
}).strict()));
const approved = new Map(approvals.map((item) => [item.questionId, item]));
if (approved.size !== approvals.length) throw new Error("A correction approval was duplicated.");
for (const record of records.values()) {
  if (record.status === "corrected" && approved.get(record.questionId)?.explanationDigest !== digest(record)) {
    throw new Error(`The proposed correction for ${record.questionId} needs a separate parent review of this exact explanation.`);
  }
}
for (const [id, record] of records) {
  const normalized = {
    ...record,
    answerParts: record.answerParts.map((part) => ({
      ...part,
      alternatives: part.alternatives.filter((alternative) =>
        alternative.text.trim().toLowerCase() !== part.answer.trim().toLowerCase()),
    })),
  };
  validateExplanation(normalized, current.documents.find((document) => document.question.id === id)!);
  records.set(id, normalized);
}
const byNumber = new Map(current.documents.flatMap((document) =>
  document.question.sources.map((source) => [source.questionNumber, records.get(document.question.id)!] as const)));
for (const release of bank.releases) {
  for (const document of release.documents) {
    if (records.has(document.question.id)) continue;
    const primary = byNumber.get(document.question.sources[0]!.questionNumber);
    if (!primary) throw new Error("A historical duplicate has no matching explanation.");
    const candidate = LearningExplanationSchema.parse({
      ...primary, questionId: document.question.id, questionSourceRevision: document.question.sourceRevision,
      originalKeyDigest: digest(document.answers.effectiveAnswer.value),
    });
    validateExplanation(candidate, document);
    records.set(document.question.id, candidate);
  }
}
const explanations = [...records.values()].sort((a, b) => a.questionId.localeCompare(b.questionId));
const releaseId = `r_${digest({ base: bank.manifest.releaseId, explanations })}`;
const dataset = LearningDatasetSchema.parse({
  schemaVersion: 1, releaseId, baseReleaseId: bank.manifest.releaseId,
  sourceRevision: bank.manifest.sourceRevision, explanations,
});
await writeData(`.data/learning/releases/${releaseId}/dataset.json`, dataset);
await writeData(".data/learning/current.json", { releaseId });
console.log(JSON.stringify({ releaseId, explanations: explanations.length }, null, 2));
