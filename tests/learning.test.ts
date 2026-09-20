import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LearningExplanationSchema, type LearningDataset, type LearningExplanation } from "../src/domain/learning.js";
import { loadCleanBank, type CleanRelease } from "../tools/web/bank.js";
import { digest } from "../tools/ingest/normalize-shared.js";
import { validateExplanation } from "../tools/learning/validate.js";
import { materializeLearningRelease } from "../tools/learning/publication.js";
import { createAttempt, validateAttemptDocuments } from "../src/web/engine.js";
import { AnswerDetails } from "../src/web/ui/AnswerDetails.js";
import type { StudyDocument, StudyRepository } from "../src/web/types.js";
import { withLearningExplanations } from "../src/web/learning-repository.js";

const fixtureParagraph = "This is synthetic test prose, not published teaching content. It makes the validation fixture substantial enough to exercise the same data contract as a real explanation, without copying an author's answer or claiming to teach an Azure feature. The individual choice identifier below is only a stable marker used to check shuffle-safe rendering and coverage.";
const fixture = (async () => {
  const bank = await loadCleanBank();
  const current = bank.releases.find((release) => release.catalog.releaseId === bank.manifest.releaseId)!;
  const documents = current.documents.filter((document) => document.question.kind === "single-select").slice(0, 10);
  return { current, documents };
})();

function explanationFor(document: StudyDocument): LearningExplanation {
  const value = document.answers.effectiveAnswer.value;
  assert.equal(value.kind, "option-selection");
  if (value.kind !== "option-selection") throw new Error("Invalid fixture.");
  return LearningExplanationSchema.parse({
    schemaVersion: 1, questionId: document.question.id, questionSourceRevision: document.question.sourceRevision,
    originalKeyDigest: digest(value), status: "supported", concept: "Synthetic teaching fixture",
    summary: fixtureParagraph, reasoning: [fixtureParagraph, fixtureParagraph],
    correctOptionIds: value.optionIds,
    options: document.question.options.map((option) => ({
      optionId: option.id, verdict: value.optionIds.includes(option.id) ? "correct" : "incorrect",
      explanation: `${option.id}: ${fixtureParagraph}`,
    })),
    answerParts: [], takeaway: fixtureParagraph, caveat: null,
    sources: [{ url: "https://learn.microsoft.com/en-us/azure/role-based-access-control/overview",
      title: "Synthetic citation fixture", supports: "This URL is a schema fixture; the surrounding test prose is not an Azure answer." }],
  });
}

test("explanations bind to source/key revisions and cover every option exactly once", async () => {
  const document = (await fixture).documents[0]!;
  const explanation = explanationFor(document);
  assert.doesNotThrow(() => validateExplanation(explanation, document));
  assert.throws(() => validateExplanation({ ...explanation, originalKeyDigest: "0".repeat(64) }, document), /stale/);
  assert.throws(() => validateExplanation({ ...explanation, options: explanation.options.slice(1) }, document), /every displayed option/);
  assert.throws(() => validateExplanation({ ...explanation, reasoning: ["Option A is correct because the fixture says so.", fixtureParagraph] }, document), /original letters/);
});

test("corrected teaching keys create a new immutable release without changing saved-session keys", async () => {
  const { current, documents } = await fixture;
  const base: CleanRelease = { ...current, documents };
  const explanations = documents.map(explanationFor);
  const first = explanations[0]!;
  const replacement = documents[0]!.question.options.find((option) => !first.correctOptionIds!.includes(option.id))!.id;
  explanations[0] = LearningExplanationSchema.parse({
    ...first, status: "corrected", correctOptionIds: [replacement], caveat: fixtureParagraph,
    options: first.options.map((option) => ({ ...option, verdict: option.optionId === replacement ? "correct" : "incorrect" })),
  });
  explanations[1] = { ...explanations[1]!, status: "conditional", caveat: fixtureParagraph };
  const dataset: LearningDataset = {
    schemaVersion: 1, releaseId: `r_${"f".repeat(64)}`, baseReleaseId: current.catalog.releaseId,
    sourceRevision: current.catalog.sourceRevision, explanations,
  };
  const subsetIds = new Set(documents.map((document) => document.question.id));
  base.catalog = { ...current.catalog, questions: current.catalog.questions.filter((question) => subsetIds.has(question.id)) };
  base.discussions = current.discussions.filter((discussion) => subsetIds.has(discussion.questionId));
  const before = digest(base);
  const old = createAttempt({ mode: "free", documents, id: "old-saved-attempt", now: 1000 });
  const derived = materializeLearningRelease(base, dataset);
  assert.equal(digest(base), before);
  assert.deepEqual(derived.documents[0]!.answers.effectiveAnswer.value, { kind: "option-selection", optionIds: [replacement] });
  assert.equal(derived.documents[1]!.answers.provisional, true);
  assert.doesNotThrow(() => validateAttemptDocuments(old, documents));
  assert.throws(() => validateAttemptDocuments(old, derived.documents), /release/);
});

test("choice explanations follow the displayed permutation instead of source letters", async () => {
  const document = (await fixture).documents[0]!;
  const explanation = explanationFor(document);
  const order = document.question.options.map((option) => option.id).reverse();
  const repository: StudyRepository = {
    async loadCatalog() { throw new Error("Unused"); }, async loadQuestion() { throw new Error("Unused"); },
    async loadQuestions() { throw new Error("Unused"); }, async loadDiscussion() { throw new Error("Unused"); },
    mediaUrl() { throw new Error("Unused"); },
  };
  const html = renderToStaticMarkup(createElement(AnswerDetails, {
    document, repository, comparedImages: new Set<string>(), order,
    learning: { value: { explanation, currentReleaseId: document.releaseId }, error: null, retry() {} },
  }));
  assert.match(html, /Each answer choice/);
  assert.ok(html.indexOf(order[0]!) < html.indexOf(order[1]!));
  assert.doesNotMatch(html, /author explanation is not available/);
});

test("teaching reads are lazy, cached, retryable, and bound to recognized source revisions", async () => {
  const document = (await fixture).documents[0]!;
  const explanation = explanationFor(document);
  const records = Object.fromEntries(Array.from({ length: 605 }, (_, index) => [
    `q_${index.toString(16).padStart(64, "0")}`,
    { sha256: "0".repeat(64), sourceRevisions: [document.question.sourceRevision] },
  ]));
  records[document.question.id] = { sha256: "0".repeat(64), sourceRevisions: [document.question.sourceRevision] };
  const manifest = {
    schemaVersion: 1, releaseId: document.releaseId, baseReleaseId: document.releaseId,
    sourceRevision: "0".repeat(64), records,
  };
  let reads = 0;
  let fail = true;
  const base: StudyRepository = {
    async loadCatalog() { throw new Error("Unused"); }, async loadQuestion() { return document; },
    async loadQuestions() { return [document]; }, async loadDiscussion() { throw new Error("Unused"); },
    mediaUrl() { throw new Error("Unused"); },
  };
  const repository = withLearningExplanations(base, {
    async manifest() { reads++; return manifest; },
    async explanation() { reads++; if (fail) { fail = false; throw new Error("temporary"); } return explanation; },
  });
  await repository.loadQuestion(document.question.id);
  assert.equal(reads, 0);
  await assert.rejects(repository.loadExplanation!(document), /temporary/);
  assert.deepEqual((await repository.loadExplanation!(document)).explanation, explanation);
  await repository.loadExplanation!(document);
  assert.equal(reads, 3);
  const stale = withLearningExplanations(base, {
    async manifest() { return manifest; },
    async explanation() { return { ...explanation, questionSourceRevision: "f".repeat(64) }; },
  });
  await assert.rejects(stale.loadExplanation!(document), /unrecognized source revision/);
  await assert.rejects(repository.loadExplanation!({
    ...document, question: { ...document.question, sourceRevision: "e".repeat(64) },
  }), /saved question revision/);
});
