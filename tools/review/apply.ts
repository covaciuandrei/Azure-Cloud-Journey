import {
  AnswerRecordSchema, CatalogSchema, ConversionOverlaySchema, QuestionSchema,
  ReviewOverlaySchema, SourceOccurrenceSchema, validateReviewForQuestion,
  type AnswerRecord, type AnswerValue, type ConversionOverlay, type Question,
  type ReviewOverlay, type SourceOccurrence,
} from "../../src/domain/index.js";
import { canonicalJson, digest, errorMessage } from "../ingest/normalize-shared.js";
import { auditDataset } from "../ingest/audit.js";
import { isMain, readData, readOptionalData, writeData, writeOverlay } from "./data.js";
import { readSourceReviews, type SourceReview } from "./source-review.js";

export interface ReviewedOccurrence {
  occurrence: SourceOccurrence;
  review: SourceReview;
}

export function reviewSummary(sources: ReviewedOccurrence[]): string {
  return sources.map(({ review }) => [
    `Source question ${review.sourceQuestionNumber}: ${review.answerStatus}; ${review.commentVerdict}.`,
    review.rationale,
    ...(review.sourceImageAnswerSummary ? [`Original image answer: ${review.sourceImageAnswerSummary}`] : []),
    ...(review.effectiveImageAnswerSummary ? [`Reviewed image answer: ${review.effectiveImageAnswerSummary}`] : []),
    ...review.warnings.map((warning) => `Warning: ${warning}`),
    ...review.supportingComments.map((comment) => `${comment.author}: "${comment.excerpt}"`),
    ...review.citations.map((citation) => `${citation.title}: ${citation.url}\n${citation.detail}`),
  ].join("\n")).join("\n\n");
}

function sourceDecisionValue(source: ReviewedOccurrence, answers: AnswerRecord): AnswerValue {
  const { occurrence, review } = source;
  if (review.effectiveSourceLabels) {
    return {
      kind: "option-selection",
      optionIds: review.effectiveSourceLabels.map((label) => {
        const id = occurrence.sourceLabelToOptionId[label];
        if (!id) throw new Error(`${occurrence.id}: no stable option ID for ${label}.`);
        return id;
      }).sort(),
    };
  }
  const original = answers.originalAnswers.find((answer) => answer.sourceOccurrenceId === occurrence.id);
  if (!original) throw new Error(`${occurrence.id}: its original answer is missing.`);
  return review.answerStatus === "corrected"
    ? { kind: "manual", reason: "non-choice-format", sourceAnswerAssetIds: original.answerAssetIds }
    : original.value;
}

export function buildReviewOverlay(
  question: Question,
  answers: AnswerRecord,
  sources: ReviewedOccurrence[],
  conversion?: ConversionOverlay,
): ReviewOverlay {
  if (sources.length !== question.sourceOccurrenceIds.length ||
      new Set(sources.map((source) => source.occurrence.id)).size !== sources.length ||
      sources.some(({ occurrence, review }) =>
        !question.sourceOccurrenceIds.includes(occurrence.id) ||
        occurrence.questionId !== question.id ||
        occurrence.questionNumber !== review.sourceQuestionNumber ||
        occurrence.capture.rawPageSha256 !== review.rawPageSha256 ||
        occurrence.commentIds.length !== review.reviewedCommentCount)) {
    throw new Error(`${question.id}: review provenance does not cover every source occurrence.`);
  }
  const sorted = [...sources].sort((a, b) => a.occurrence.questionNumber - b.occurrence.questionNumber);
  const uncertain = sorted.filter(({ review }) =>
    ["unresolved", "outdated-or-defective"].includes(review.answerStatus));
  const corrected = sorted.filter(({ review }) => review.answerStatus === "corrected");
  let answerDecision: ReviewOverlay["answerDecision"] = { kind: "retain-source" };
  if (uncertain.length > 0) {
    answerDecision = {
      kind: "unresolved",
      reason: uncertain.map(({ review }) => review.warnings.join(" ") || review.rationale).join("\n"),
    };
  } else if (corrected.length > 0) {
    const documented = sorted.filter(({ review }) =>
      ["confirmed", "corrected"].includes(review.answerStatus));
    const values = documented.map((source) => ({
      value: sourceDecisionValue(source, answers),
      imageAnswer: source.review.effectiveImageAnswerSummary ?? source.review.sourceImageAnswerSummary,
    }));
    const signatures = new Set(values.map(({ value, imageAnswer }) =>
      digest(value.kind === "manual" ? { value, imageAnswer } : value)));
    if (signatures.size > 1) {
      answerDecision = {
        kind: "unresolved",
        reason: "The documentation reviews of duplicate source occurrences disagree; no correction was applied.",
      };
    } else {
      const correction = corrected[0];
      if (!correction) throw new Error(`${question.id}: missing correction.`);
      const evidence = corrected.flatMap(({ review }) =>
        review.citations.map(({ url, title, detail }) => ({ url, title, note: detail })));
      answerDecision = {
        kind: "override",
        value: sourceDecisionValue(correction, answers),
        rationale: corrected.map(({ review }) =>
          [review.rationale, review.effectiveImageAnswerSummary].filter(Boolean).join("\n")).join("\n\n"),
        evidence: [...new Map(evidence.map((item) => [canonicalJson(item), item])).values()],
      };
    }
  } else if (answers.originalKeysConflict) {
    answerDecision = {
      kind: "unresolved",
      reason: "Duplicate occurrences have conflicting source answer keys; no documented resolution is available.",
    };
  }
  const overlay = ReviewOverlaySchema.parse({
    schemaVersion: 1,
    questionId: question.id,
    basedOnSourceRevision: question.sourceRevision,
    status: "completed",
    reviewer: "Copilot source-review import",
    reviewedAt: new Date(Math.max(...sorted.map(({ review }) => Date.parse(review.reviewedAt)))).toISOString(),
    commentAssessment: {
      assessedCommentIds: sorted.flatMap(({ occurrence }) => occurrence.commentIds).sort(),
      summary: reviewSummary(sorted),
    },
    answerDecision,
    published: false,
  });
  return validateReviewForQuestion(
    question, answers, sorted.flatMap(({ occurrence }) => occurrence.commentIds), overlay, conversion,
  );
}

export async function applySourceReviews(options: {
  requireAll?: boolean; replaceExisting?: boolean;
} = {}) {
  const audit = await auditDataset({ requireComplete: true });
  if (!audit.ok) {
    throw new Error("Normalized source or existing curation is inconsistent; run data:audit before applying reviews.");
  }
  const catalog = await readData(".data/normalized/catalog.json", CatalogSchema);
  const reviews = await readSourceReviews();
  const byNumber = new Map(reviews.map((review) => [review.sourceQuestionNumber, review]));
  const pending: number[] = [];
  const output: Array<{ path: string; overlay: ReviewOverlay }> = [];
  for (const entry of catalog.entries) {
    const missing = entry.sourceQuestionNumbers.filter((number) => !byNumber.has(number));
    if (missing.length) { pending.push(...missing); continue; }
    const question = await readData(`.data/normalized/${entry.questionPath}`, QuestionSchema);
    const answers = await readData(`.data/normalized/${entry.answerPath}`, AnswerRecordSchema);
    const sources: ReviewedOccurrence[] = [];
    for (const id of entry.sourceOccurrenceIds) {
      const occurrence = await readData(`.data/normalized/occurrences/${id}.json`, SourceOccurrenceSchema);
      const review = byNumber.get(occurrence.questionNumber);
      if (!review) throw new Error(`${id}: missing source review.`);
      sources.push({ occurrence, review });
    }
    const conversion = await readOptionalData(`.data/conversions/${entry.id}.json`, ConversionOverlaySchema);
    output.push({
      path: `.data/reviews/${entry.id}.json`,
      overlay: buildReviewOverlay(question, answers, sources, conversion),
    });
  }
  if (options.requireAll && pending.length > 0) {
    throw new Error(`Semantic reviews are still missing for source questions: ${pending.join(", ")}.`);
  }
  let written = 0;
  let unchanged = 0;
  for (const { path, overlay } of output) {
    const result = await writeOverlay(path, overlay, options.replaceExisting === true);
    if (result === "written") written++;
    else unchanged++;
  }
  const report = {
    sourceReviews: reviews.length,
    completedCanonicalQuestions: output.length,
    written,
    unchanged,
    pendingSourceQuestionNumbers: pending.sort((a, b) => a - b),
  };
  await writeData(".data/review-application-report.json", report);
  return report;
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => !["--require-all", "--replace-existing"].includes(arg));
  if (unknown.length) throw new Error(`Unknown review arguments: ${unknown.join(", ")}.`);
  applySourceReviews({
    requireAll: args.includes("--require-all"),
    replaceExisting: args.includes("--replace-existing"),
  }).then((report) => console.log(JSON.stringify(report, null, 2))).catch((error: unknown) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
