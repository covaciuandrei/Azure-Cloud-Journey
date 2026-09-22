import assert from "node:assert/strict";
import { test } from "node:test";
import { sc900BankFixture, sc900FixtureText, SC900_FIXTURE_TIMESTAMP } from "./sc900-bank-fixture.js";
import { sc900ScopedFixture } from "./sc900-scoped-fixture.js";
import { Sc900DocumentSchema } from "../src/domain/sc900Bank.js";
import { byteSha256, sc900QuestionId } from "../tools/sc900/canonical.js";
import { sc900OriginalKeyDigest } from "../tools/sc900/publication.js";
import { materializeSc900ReviewedBank, removeSc900DraftBoilerplate, Sc900ReviewedQuestionSchema, type Sc900MaterializationInput } from "../tools/sc900/materialize.js";

function fixture(bothManual = false): Sc900MaterializationInput {
  const scope = Buffer.from(JSON.stringify({
    checkedAt: SC900_FIXTURE_TIMESTAMP, examId: 128,
    url: "https://www.examprepper.co/exam/128/1", title: "Microsoft - SC-900 - Page 1 | Examprepper",
    headings: [" Question 1", " Question 2"], nextVisible: 0, lastVisible: 0,
    sourceMethod: "Last paginator button inspected solely to establish source scope; no answers or discussions requested.",
    observedSourceQuestionCount: 2, observedPageCount: 1, discussionRequests: 0,
  }));
  const original = sc900BankFixture();
  original.expectedCapture.receiptSha256 = byteSha256(scope);
  const source = sc900ScopedFixture(original);
  const documents = structuredClone(source.documents);
  if (bothManual) {
    const document = documents[0]!;
    document.question.kind = "manual";
    document.question.options = [];
    document.question.fixedOptionOrder = [];
    document.question.readiness.grading = "manual";
    document.question.id = sc900QuestionId(document.question);
    document.answers.id = document.question.id;
    document.answers.questionId = document.question.id;
    const value = { kind: "manual" as const, reason: "image-only" as const, sourceAnswerAssetIds: [...document.question.assetIds] };
    document.answers.effectiveAnswer.value = value;
    document.answers.originalAnswers[0]!.value = structuredClone(value);
    document.answers.originalAnswers[0]!.answerAssetIds = [...document.question.assetIds];
  }
  documents.forEach((document) => { document.answers.provisional = true; Sc900DocumentSchema.parse(document); });
  const reviewedDocuments = structuredClone(documents);
  for (const document of reviewedDocuments) {
    document.question.sourceRevision = "1".repeat(64);
    document.answers.sourceRevision = "1".repeat(64);
  }
  const paragraph = "Original synthetic factual reasoning with clear assumptions and no imported source material.";
  const reviews = reviewedDocuments.map((document) => ({
    number: document.question.sources[0]!.questionNumber,
    questionId: document.question.id,
    topicIds: ["sc-security-concepts"],
    eligibilityRecommendation: "keep",
    eligibilityReason: "The synthetic question has a clear documented solution and is suitable for this isolated test.",
    relatedSourceNumbers: [],
    visualReview: "complete",
    explanation: {
      schemaVersion: 1, examId: "sc900", questionId: document.question.id,
      questionSourceRevision: document.question.sourceRevision,
      originalKeyDigest: sc900OriginalKeyDigest(document),
      status: "supported", concept: "Original synthetic concept",
      summary: paragraph, reasoning: [paragraph, paragraph],
      correctOptionIds: document.question.readiness.grading === "automatic" ? [document.question.options[0]!.id] : null,
      options: document.question.options.map((option, index) => ({
        optionId: option.id, verdict: index === 0 ? "correct" : "incorrect", explanation: paragraph,
      })),
      answerParts: document.question.readiness.grading === "manual"
        ? [{ label: "Synthetic diagram", answer: "A reviewed synthetic answer", explanation: paragraph, alternatives: [] }] : [],
      takeaway: paragraph,
      caveat: "Private draft only. Source discussion retrieval remains pending after HTTP 429 responses; neither this explanation nor a keep recommendation approves publication.",
      sources: [{ url: "https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/sc-900",
        title: "Synthetic source attribution", supports: paragraph }],
    },
  }));
  return { ledger: source.ledger, ownerAuthorization: source.ownerAuthorization,
    sourceScopeReceipt: scope, documents, reviewedDocuments, reviews,
    reviewedAt: "2026-09-22", duplicates: [], assets: source.assets };
}

test("materialization binds only unchanged reviewed content and conserves originals without approving publication", () => {
  const input = fixture();
  const before = input.documents.map((value) => Sc900DocumentSchema.parse(value));
  const result = materializeSc900ReviewedBank(input);
  assert.equal(result.prepared.eligibility.activeCounts.questions, 2);
  assert.equal(result.prepared.manifest.discussionScope?.sourceCommentCount, null);
  assert(result.prepared.documents.every((document) => !document.answers.provisional));
  assert(result.prepared.learning.explanations.every((explanation) => explanation.caveat === null));
  assert(result.prepared.learning.explanations.every((explanation) =>
    explanation.questionSourceRevision === result.prepared.manifest.sourceRevision));
  assert.equal(result.report.publicationApproved, false);
  assert.equal(result.report.boilerplateChanges.length, 2);
  assert.deepEqual(input.documents, before);
  for (const document of result.prepared.documents) {
    const previous = before.find((item) => item.question.id === document.question.id);
    assert(previous);
    assert.deepEqual(document.answers.originalAnswers, Sc900DocumentSchema.parse(previous).answers.originalAnswers);
  }
});

test("a condition-dependent recommended choice is preserved but excluded from automatic practice", () => {
  const input = fixture();
  const review = Sc900ReviewedQuestionSchema.parse(input.reviews[0]);
  review.explanation.status = "conditional";
  review.explanation.caveat = "The exact choice depends on an assumption that the synthetic prompt does not provide.";
  review.explanation.options[0]!.verdict = "conditional";
  input.reviews[0] = review;
  const result = materializeSc900ReviewedBank(input);
  assert.equal(result.prepared.eligibility.activeCounts.questions, 1);
  assert.equal(result.prepared.eligibility.retired[0]!.category, "defective-question");
  assert.equal(result.prepared.documents.find((document) => document.question.sources[0]!.questionNumber === 1)!.answers.provisional, true);
});

test("duplicate exclusions preserve both original records and bytes and point only to an active reviewed item", () => {
  const input = fixture(true);
  const documents = input.documents.map((value) => Sc900DocumentSchema.parse(value));
  input.duplicates = [{
    questionId: documents[1]!.question.id, duplicateOfQuestionId: documents[0]!.question.id,
    reportSha256: "a".repeat(64),
    reason: "Excluded as a separately reviewed duplicate of the retained synthetic reference question.",
    evidence: "Independent comparison of both synthetic tasks, original image identities and answer structures establishes equivalence for this mechanical test.",
  }];
  const result = materializeSc900ReviewedBank(input);
  assert.equal(result.prepared.documents.length, 2);
  assert.equal(result.prepared.assets.size, 1);
  assert.equal(result.prepared.eligibility.activeCounts.questions, 1);
  const exclusion = result.prepared.eligibility.retired[0]!;
  assert.equal(exclusion.category, "duplicate");
  assert.deepEqual(exclusion.sources, []);
  assert.equal(exclusion.category === "duplicate" && exclusion.duplicateOfQuestionId, documents[0]!.question.id);
});

test("changed source content, stale key bindings, unknown options, missing reviews and invalid consent all fail closed", () => {
  for (const variation of ["content", "key", "option", "missing", "consent", "scope"] as const) {
    const input = fixture();
    const documents = input.documents.map((value) => Sc900DocumentSchema.parse(value));
    input.documents = documents;
    if (variation === "content") documents[0]!.question.prompt = sc900FixtureText("Changed synthetic task after review.");
    if (variation === "key") {
      const record = Sc900ReviewedQuestionSchema.parse(input.reviews[0]);
      record.explanation.originalKeyDigest = "f".repeat(64);
      input.reviews[0] = record;
    }
    if (variation === "option") {
      const record = Sc900ReviewedQuestionSchema.parse(input.reviews[0]);
      record.explanation.options.pop();
      input.reviews[0] = record;
    }
    if (variation === "missing") input.reviews.pop();
    if (variation === "consent") input.ownerAuthorization = null;
    if (variation === "scope") input.sourceScopeReceipt = Buffer.from("changed receipt");
    assert.throws(() => materializeSc900ReviewedBank(input), variation);
  }
});

test("boilerplate cleanup preserves substantive caveats and rejects unknown operational claims", () => {
  assert.equal(removeSc900DraftBoilerplate("Licensing remains required. Private draft only. Source discussion retrieval remains pending after HTTP 429 responses; neither this explanation nor a keep recommendation approves publication."),
    "Licensing remains required.");
  assert.throws(() => removeSc900DraftBoilerplate("Unknown private draft instructions still pending."));
  assert.equal(removeSc900DraftBoilerplate("This is an independent draft correction from the visually inspected marked answer. The original source key digest is preserved; no bank key or publication approval is changed."), "");
  assert.match(removeSc900DraftBoilerplate("Keep is only an item-level draft recommendation as of September 22, 2026, not product adoption advice. The next phase remains in the future."),
    /not product adoption advice.*next phase/);
});

test("a correction with only operational caveat text derives its notice from its own reviewed summary", () => {
  const input = fixture();
  const record = Sc900ReviewedQuestionSchema.parse(input.reviews[1]);
  record.explanation.status = "corrected";
  record.explanation.caveat = "This is an independent draft correction from the visually inspected marked answer. The original source key digest is preserved; no bank key or publication approval is changed.";
  input.reviews[1] = record;
  const result = materializeSc900ReviewedBank(input);
  const explanation = result.prepared.learning.explanations.find((item) => item.questionId === record.questionId)!;
  assert.equal(explanation.caveat, `Correction to the original source: ${record.explanation.summary}`);
});
