import assert from "node:assert/strict";
import { test } from "node:test";
import { sourceReviewSchema, validateReviewProvenance } from "../tools/review/source-review.js";

const hash = "a".repeat(64);
const review = {
  schemaVersion: 1,
  sourceQuestionNumber: 1,
  sourcePage: 1,
  rawPageSha256: hash,
  reviewedCommentCount: 2,
  commentVerdict: "supports-source",
  answerStatus: "source-default",
  effectiveSourceLabels: ["C"],
  sourceImageAnswerSummary: null,
  rationale: "The discussion supports the source answer; no independent confirmation is claimed.",
  supportingComments: [],
  citations: [],
  warnings: [],
  reviewedAt: "2026-09-09T21:00:00Z",
};
const input = {
  url: "https://www.examprepper.co/exam/45/1",
  questions: [{
    heading: "Question 1",
    commentCount: 2,
    choiceStyles: [
      { label: "A", text: "First option", borderColor: "rgb(255, 255, 255)" },
      { label: "C", text: "Source choice", borderColor: "rgb(104, 211, 145)" },
    ],
  }],
};

test("source-default remains explicitly distinct from documented confirmation", () => {
  const parsed = sourceReviewSchema.parse(review);
  assert.equal(parsed.answerStatus, "source-default");
  assert.doesNotThrow(() => validateReviewProvenance(parsed, input, hash));
  assert.equal(sourceReviewSchema.safeParse({ ...review, answerStatus: "confirmed" }).success, false);
});

test("reviews cannot silently change a provisional key or omit captured comments", () => {
  assert.throws(() => validateReviewProvenance(
    sourceReviewSchema.parse({ ...review, effectiveSourceLabels: ["A"] }), input, hash,
  ), /preserve the site's answer/);
  assert.throws(() => validateReviewProvenance(
    sourceReviewSchema.parse({ ...review, reviewedCommentCount: 1 }), input, hash,
  ), /captured discussion/);
  assert.throws(() => validateReviewProvenance(
    sourceReviewSchema.parse(review), input, "b".repeat(64),
  ), /different capture revision/);
});

test("uncertain answers require warnings and preserve the source key", () => {
  assert.equal(sourceReviewSchema.safeParse({ ...review, answerStatus: "unresolved" }).success, false);
  const parsed = sourceReviewSchema.parse({
    ...review, answerStatus: "unresolved", commentVerdict: "mixed",
    warnings: ["The disagreement is unresolved; this result is provisional."],
  });
  assert.doesNotThrow(() => validateReviewProvenance(parsed, input, hash));
});

test("corrected keys require official citations and existing option identities", () => {
  const corrected = {
    ...review,
    answerStatus: "corrected",
    effectiveSourceLabels: ["A"],
    citations: [{
      url: "https://learn.microsoft.com/en-us/azure/",
      title: "Azure documentation",
      detail: "Synthetic fixture for citation validation, not a real question assessment.",
    }],
  };
  assert.doesNotThrow(() => validateReviewProvenance(sourceReviewSchema.parse(corrected), input, hash));
  assert.throws(() => validateReviewProvenance(
    sourceReviewSchema.parse({ ...corrected, effectiveSourceLabels: ["C"] }), input, hash,
  ), /not a correction/);
  assert.throws(() => validateReviewProvenance(
    sourceReviewSchema.parse({ ...corrected, effectiveSourceLabels: ["Z"] }), input, hash,
  ), /unknown answer label/);
  for (const url of ["https://learn.microsoft.com.evil.example/test", "https://learn.microsoft.com@evil.example/test", "javascript:alert(1)"]) {
    assert.equal(sourceReviewSchema.safeParse({
      ...corrected, citations: [{ ...corrected.citations[0], url }],
    }).success, false);
  }
});

test("corrected image answers keep the source and effective summaries separate", () => {
  const imageReview = {
    ...review, answerStatus: "corrected", effectiveSourceLabels: null,
    sourceImageAnswerSummary: "The original image marks the first two items.",
    citations: [{
      url: "https://learn.microsoft.com/en-us/azure/",
      title: "Azure documentation",
      detail: "Synthetic citation fixture.",
    }],
  };
  assert.equal(sourceReviewSchema.safeParse(imageReview).success, false);
  assert.equal(sourceReviewSchema.safeParse({
    ...imageReview, effectiveImageAnswerSummary: "The reviewed key selects the first and third items.",
  }).success, true);
});
