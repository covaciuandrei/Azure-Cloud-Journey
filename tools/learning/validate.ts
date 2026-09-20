import { z } from "zod";
import type { CleanDocument } from "../../src/domain/cleanBank.js";
import { LearningExplanationSchema, type LearningExplanation } from "../../src/domain/learning.js";
import { TOPIC_IDS } from "../../src/domain/topics.js";
import { digest } from "../ingest/normalize-shared.js";
import { loadCleanBank } from "../web/bank.js";
import { readTopicMap } from "../topics/data.js";
import { isMain, readData, writeData } from "../review/data.js";

export function validateExplanation(explanation: LearningExplanation, document: CleanDocument): void {
  LearningExplanationSchema.parse(explanation);
  const question = document.question;
  const key = document.answers.effectiveAnswer.value;
  if (explanation.questionId !== question.id || explanation.questionSourceRevision !== question.sourceRevision ||
      explanation.originalKeyDigest !== digest(key)) throw new Error(`${question.id}: stale explanation source/key binding.`);
  const ids = new Set(question.options.map((option) => option.id));
  if (explanation.options.length !== ids.size || explanation.options.some((option) => !ids.has(option.optionId)) ||
      explanation.correctOptionIds?.some((id) => !ids.has(id))) {
    throw new Error(`${question.id}: every displayed option must have its own explanation, with no foreign IDs.`);
  }
  const equal = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((id) => b.includes(id));
  if (key.kind === "option-selection") {
    if (explanation.status === "supported" && !equal(explanation.correctOptionIds ?? [], key.optionIds)) {
      throw new Error(`${question.id}: supported status cannot silently change the stored key.`);
    }
    if (explanation.status === "corrected" && equal(explanation.correctOptionIds ?? [], key.optionIds)) {
      throw new Error(`${question.id}: corrected status must identify an actual key change.`);
    }
    if (question.kind === "single-select" && ["supported", "corrected"].includes(explanation.status) &&
        explanation.correctOptionIds?.length !== 1) {
      throw new Error(`${question.id}: multiple valid choices in a single-select item require a conditional/incomplete status.`);
    }
  } else if (explanation.correctOptionIds !== null || !explanation.answerParts.length) {
    throw new Error(`${question.id}: manual questions require explained answer parts, not invented option IDs.`);
  }
  const prose = [
    explanation.summary, ...explanation.reasoning, explanation.takeaway, explanation.caveat ?? "",
    ...explanation.options.map((option) => option.explanation),
    ...explanation.answerParts.flatMap((part) => [part.answer, part.explanation, ...part.alternatives.map((item) => item.explanation)]),
  ].join("\n");
  if (/\b(?:option|choice|answer)\s+[A-F]\s+(?:is|are|would|does|doesn't|cannot|can)\b/i.test(prose)) {
    throw new Error(`${question.id}: explanations must identify shuffled choices by content, not original letters.`);
  }
  if (prose.split(/\s+/).length < 120) throw new Error(`${question.id}: teaching explanation is too thin.`);
  if (explanation.answerParts.some((part) => /^(?:see|refer to|as shown in)\s+(?:the\s+)?(?:source\s+)?(?:image|picture|exhibit)/i.test(part.answer))) {
    throw new Error(`${question.id}: answer parts cannot delegate the reasoning to the source image.`);
  }
}

export async function loadAuthoredExplanations(workspace = process.cwd()) {
  const bank = await loadCleanBank(workspace);
  const topics = await readTopicMap(workspace);
  const current = bank.releases.find((release) => release.catalog.releaseId === bank.manifest.releaseId)!;
  const records = new Map<string, LearningExplanation>();
  for (const topic of TOPIC_IDS) {
    const batch = await readData(`.data/learning/authored/${topic}.json`, z.object({
      topic: z.literal(topic), explanations: z.array(LearningExplanationSchema),
    }).strict(), workspace);
    const expected = current.documents.filter((document) => topics.assignments[document.question.id]?.[0] === topic);
    if (batch.explanations.length !== expected.length) throw new Error(`${topic}: explanation count is incomplete.`);
    for (const explanation of batch.explanations) {
      const document = expected.find((item) => item.question.id === explanation.questionId);
      if (!document || records.has(explanation.questionId)) throw new Error(`${topic}: unexpected/duplicate explanation.`);
      validateExplanation(explanation, document);
      records.set(explanation.questionId, explanation);
    }
  }
  if (records.size !== 604) throw new Error("All 604 current questions must have complete teaching explanations.");
  return { bank, current, records };
}

if (isMain(import.meta.url)) {
  const { current, records } = await loadAuthoredExplanations();
  const report = {
    questions: records.size,
    statuses: Object.fromEntries(["supported", "corrected", "conditional", "outdated", "incomplete"].map((status) =>
      [status, [...records.values()].filter((item) => item.status === status).length])),
    review: current.documents.filter((document) => records.get(document.question.id)!.status !== "supported").map((document) => ({
      number: document.question.sources[0]!.questionNumber,
      questionId: document.question.id,
      status: records.get(document.question.id)!.status,
      caveat: records.get(document.question.id)!.caveat,
    })),
  };
  await writeData(".data/learning/validation-report.json", report);
  console.log(JSON.stringify(report, null, 2));
}
