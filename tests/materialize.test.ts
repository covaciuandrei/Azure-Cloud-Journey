import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReviewOverlay, type ReviewedOccurrence } from "../tools/review/apply.js";
import { materializeQuestion } from "../tools/review/materialize.js";
import { sourceReviewSchema } from "../tools/review/source-review.js";
import { normalizeCaptures } from "../tools/ingest/normalize-core.js";
import { sha256 } from "../tools/ingest/normalize-shared.js";

function fixture() {
  const html = `<div class="chakra-accordion__item">
    <button class="chakra-accordion__button">Question 1</button>
    <div class="chakra-accordion__panel">
      <div><div class="css-naa3lg"><p>Choose a color.</p></div><div>
        <div class="chakra-stack"><div>A.</div><div><p>Red</p></div></div>
        <div class="chakra-stack"><div>B.</div><div><p>Blue</p></div></div>
      </div></div>
      <div><button>Hide Answer</button></div>
      <div><div><a>[-]</a><div><ul class="chakra-wrap__list">
        <div><b>Example reader</b><b>1 point</b><span>1 day ago</span></div>
        <div><p>Blue is the source choice.</p></div><div></div>
      </ul></div></div></div>
    </div></div>`;
  const content = JSON.stringify({
    captureVersion: 1,
    method: "rendered-browser-ui",
    url: "https://www.examprepper.co/exam/45/1",
    title: "Synthetic study fixture",
    capturedAt: "2026-09-09T21:00:00Z",
    questions: [{
      heading: "Question 1", html, renderedText: "Synthetic color question and discussion.",
      answerRevealed: true, loadingIndicators: 0,
      choiceStyles: [
        { label: "A", text: "Red", borderColor: "rgb(255, 255, 255)", borderWidth: "2px" },
        { label: "B", text: "Blue", borderColor: "rgb(104, 211, 145)", borderWidth: "2px" },
      ],
      commentCount: 1, remainingControls: [], images: [],
      discussionLoad: { status: "loaded", httpStatus: 200 },
    }],
    assets: [],
  });
  const dataset = normalizeCaptures([{ path: ".data/raw/pages/page-001.json", content }], {
    expected: { pages: 1, occurrences: 1, pageSize: 5 },
  });
  const question = dataset.questions[0];
  const answers = dataset.answers[0];
  const occurrence = dataset.occurrences[0];
  assert.ok(question && answers && occurrence);
  const source: ReviewedOccurrence = {
    occurrence,
    review: sourceReviewSchema.parse({
      schemaVersion: 1, sourceQuestionNumber: 1, sourcePage: 1,
      rawPageSha256: sha256(content), reviewedCommentCount: 1,
      commentVerdict: "supports-source", answerStatus: "source-default",
      effectiveSourceLabels: ["B"], sourceImageAnswerSummary: null,
      rationale: "The synthetic comment supports the source key, without independent confirmation.",
      supportingComments: [{ author: "Example reader", excerpt: "Blue is the source choice." }],
      citations: [], warnings: [], reviewedAt: "2026-09-09T22:00:00Z",
    }),
  };
  return { question, answers, source };
}

test("publication preparation retains originals and makes source-label mappings available", () => {
  const { question, answers, source } = fixture();
  const review = buildReviewOverlay(question, answers, [source]);
  const prepared = materializeQuestion(
    { question, answers, sources: [source], review }, new Map(), `r_${"a".repeat(64)}`,
  );
  assert.equal(prepared.question.published, true);
  assert.equal(prepared.question.review.status, "completed");
  assert.equal(question.published, false);
  assert.deepEqual(prepared.question.sourcePresentation.prompt, question.prompt);
  assert.deepEqual(prepared.answers.originalAnswers, answers.originalAnswers);
  assert.deepEqual(prepared.question.sources[0]?.sourceLabelToOptionId, source.occurrence.sourceLabelToOptionId);
  assert.equal(prepared.answers.assessment.status, "source-default");
  assert.equal(prepared.answers.effectiveAnswer.verification, "community-reviewed");
  assert.equal(prepared.answers.assessment.provisional, false);
});

test("a documented correction changes the effective ID, never the original key", () => {
  const { question, answers, source } = fixture();
  source.review = sourceReviewSchema.parse({
    ...source.review, answerStatus: "corrected", commentVerdict: "mixed", effectiveSourceLabels: ["A"],
    rationale: "Synthetic correction fixture; this is not an actual Azure knowledge claim.",
    citations: [{
      url: "https://learn.microsoft.com/en-us/azure/",
      title: "Synthetic citation fixture", detail: "For schema testing only.",
    }],
  });
  const review = buildReviewOverlay(question, answers, [source]);
  const prepared = materializeQuestion(
    { question, answers, sources: [source], review }, new Map(), `r_${"b".repeat(64)}`,
  );
  assert.deepEqual(prepared.answers.effectiveAnswer.value, {
    kind: "option-selection", optionIds: [source.occurrence.sourceLabelToOptionId.A],
  });
  assert.deepEqual(prepared.answers.originalAnswers[0]?.sourceLabels, ["B"]);
  assert.equal(prepared.answers.assessment.status, "corrected");
  assert.equal(prepared.answers.effectiveAnswer.basis, "review-override");
});

test("unresolved answers remain available with their source key and provisional scoring", () => {
  const { question, answers, source } = fixture();
  source.review = sourceReviewSchema.parse({
    ...source.review, answerStatus: "unresolved", commentVerdict: "mixed",
    warnings: ["The synthetic disagreement is not resolved."],
  });
  const review = buildReviewOverlay(question, answers, [source]);
  const prepared = materializeQuestion(
    { question, answers, sources: [source], review }, new Map(), `r_${"c".repeat(64)}`,
  );
  assert.equal(prepared.question.published, true);
  assert.equal(prepared.answers.assessment.provisional, true);
  assert.equal(prepared.answers.effectiveAnswer.basis, "review-unresolved");
  assert.deepEqual(prepared.answers.effectiveAnswer.value, answers.effectiveAnswer.value);
  assert.ok(prepared.answers.assessment.warnings.length);
});

test("missing discussion coverage, unknown labels, stale revisions and missing media block preparation", () => {
  const { question, answers, source } = fixture();
  assert.throws(() => buildReviewOverlay(question, answers, []), /every source occurrence/);
  assert.throws(() => buildReviewOverlay(question, answers, [{
    ...source, review: { ...source.review, reviewedCommentCount: 0 },
  }]), /every source occurrence/);
  assert.throws(() => buildReviewOverlay(question, answers, [{
    ...source, review: { ...source.review, answerStatus: "corrected", effectiveSourceLabels: ["Z"] },
  }]), /no stable option ID/);
  const review = buildReviewOverlay(question, answers, [source]);
  assert.throws(() => materializeQuestion({
    question, answers, sources: [source], review: { ...review, basedOnSourceRevision: "d".repeat(64) },
  }, new Map(), `r_${"a".repeat(64)}`), /different question\/source revision/);
  assert.throws(() => materializeQuestion({
    question: { ...question, assetIds: ["e".repeat(64)] },
    answers, sources: [source], review,
  }, new Map(), `r_${"a".repeat(64)}`), /missing media/);
});

test("a pending conversion retains the source answer but prevents automatic grading", () => {
  const { question, answers, source } = fixture();
  const review = buildReviewOverlay(question, answers, [source]);
  const prepared = materializeQuestion({
    question, answers, sources: [source], review,
    conversion: {
      schemaVersion: 1, questionId: question.id, basedOnSourceRevision: question.sourceRevision,
      status: "pending", notes: "The interaction has not been faithfully converted.",
    },
  }, new Map(), `r_${"a".repeat(64)}`);
  assert.equal(prepared.question.readiness.grading, "manual");
  assert.equal(prepared.question.conversion.status, "pending");
  assert.match(prepared.question.conversion.reason ?? "", /not been faithfully converted/);
  assert.deepEqual(prepared.answers.effectiveAnswer.value, answers.effectiveAnswer.value);
});

test("converted option hashes must describe their actual displayed content", () => {
  const { question, answers, source } = fixture();
  const imageId = "e".repeat(64);
  const withImage = { ...question, assetIds: [imageId] };
  const review = buildReviewOverlay(question, answers, [source]);
  const option = question.options[0];
  assert.ok(option);
  const value = answers.effectiveAnswer.value;
  assert.equal(value.kind, "option-selection");
  if (value.kind !== "option-selection") throw new Error("Invalid fixture.");
  assert.throws(() => materializeQuestion({
    question: withImage, answers, sources: [source], review,
    conversion: {
      schemaVersion: 1, questionId: question.id, basedOnSourceRevision: question.sourceRevision,
      status: "completed", converter: "Synthetic fixture", convertedAt: "2026-09-09T22:00:00Z",
      kind: "single-select", prompt: question.prompt,
      options: question.options.map((item, index) => index === 0 ? {
        ...item, content: [{ type: "text", spans: [{ type: "text", text: "Changed without rehashing", marks: [] }] }],
      } : item),
      answer: value, sourceAssetIds: [imageId],
      notes: "Synthetic hash-integrity fixture.",
    },
  }, new Map(), `r_${"a".repeat(64)}`), /content hash/);
});
