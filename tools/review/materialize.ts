import {
  PreparedAnswerSchema, PreparedQuestionSchema, StudyAssessmentSchema,
  richAssetIds, validateConversionForQuestion, validateReviewForQuestion,
  type AnswerRecord, type Asset, type ConversionOverlay, type PreparedAnswer,
  type PreparedQuestion, type Question, type ReviewOverlay, type StudyAssessment,
} from "../../src/domain/index.js";
import { shufflePolicy } from "../ingest/normalize-core.js";
import { canonicalJson, digest } from "../ingest/normalize-shared.js";
import { type ReviewedOccurrence } from "./apply.js";

export interface MaterializeInput {
  question: Question;
  answers: AnswerRecord;
  review: ReviewOverlay;
  sources: ReviewedOccurrence[];
  conversion?: ConversionOverlay;
}

export function assessmentFor(input: MaterializeInput): StudyAssessment {
  const { review, sources } = input;
  let status: StudyAssessment["status"] = "source-default";
  if (review.answerDecision.kind === "override") status = "corrected";
  else if (review.answerDecision.kind === "unresolved") {
    status = sources.some((source) => source.review.answerStatus === "outdated-or-defective")
      ? "outdated-or-defective" : "unresolved";
  } else if (sources.every((source) => source.review.answerStatus === "confirmed")) {
    status = "confirmed";
  }
  const warnings = [...new Set(sources.flatMap((source) => source.review.warnings))];
  if (review.answerDecision.kind === "unresolved" && !warnings.includes(review.answerDecision.reason)) {
    warnings.push(review.answerDecision.reason);
  }
  const citations = sources.flatMap(({ review: source }) =>
    source.citations.map(({ url, title, detail }) => ({ url, title, note: detail })));
  if (review.answerDecision.kind === "override") citations.push(...review.answerDecision.evidence);
  const effectiveImages = [...new Set(sources.flatMap(({ review: source }) =>
    source.effectiveImageAnswerSummary ? [source.effectiveImageAnswerSummary] : []))];
  return StudyAssessmentSchema.parse({
    status,
    provisional: ["unresolved", "outdated-or-defective"].includes(status),
    summary: [
      review.commentAssessment.summary,
      ...(review.answerDecision.kind === "override" ? [review.answerDecision.rationale] : []),
    ].join("\n\n"),
    warnings,
    citations: [...new Map(citations.map((item) => [canonicalJson(item), item])).values()],
    sourceQuestionNumbers: sources.map(({ occurrence }) => occurrence.questionNumber),
    originalImageAnswers: sources.flatMap(({ review: source }) => source.sourceImageAnswerSummary
      ? [{ sourceQuestionNumber: source.sourceQuestionNumber, summary: source.sourceImageAnswerSummary }]
      : []),
    effectiveImageAnswerSummary: status === "corrected" && effectiveImages.length === 1
      ? effectiveImages[0] : null,
  });
}

export function materializeQuestion(
  input: MaterializeInput,
  assets: ReadonlyMap<string, Asset>,
  releaseId: string,
): { question: PreparedQuestion; answers: PreparedAnswer } {
  const { question, answers, review, sources, conversion } = input;
  const commentIds = sources.flatMap(({ occurrence }) => occurrence.commentIds);
  validateReviewForQuestion(question, answers, commentIds, review, conversion);
  if (conversion) validateConversionForQuestion(question, answers, conversion);
  const completedConversion = conversion?.status === "completed" ? conversion : undefined;
  if (completedConversion) {
    if (completedConversion.options.some((option) => option.contentHash !== digest(option.content))) {
      throw new Error(`${question.id}: a converted option's content hash does not match its text.`);
    }
    const references = [
      ...richAssetIds(completedConversion.prompt),
      ...completedConversion.options.flatMap((option) => richAssetIds(option.content)),
    ];
    if (references.some((id) => !question.assetIds.includes(id))) {
      throw new Error(`${question.id}: a converted prompt or option refers to unavailable media.`);
    }
  }
  const assessment = assessmentFor(input);
  let value = completedConversion?.answer ?? answers.effectiveAnswer.value;
  let basis = completedConversion ? "source-default" as const : answers.effectiveAnswer.basis;
  if (review.answerDecision.kind === "override") {
    value = review.answerDecision.value;
    basis = "review-override";
  } else if (review.answerDecision.kind === "unresolved") {
    if (completedConversion && answers.effectiveAnswer.value.kind === "manual") {
      value = completedConversion.answer;
    }
    basis = "review-unresolved";
  }
  const needsConversion = !completedConversion &&
    (conversion?.status === "pending" || question.conversion.status === "pending");
  const grading = !needsConversion && value.kind === "option-selection" &&
    (completedConversion !== undefined || question.kind !== "manual") ? "automatic" : "manual";
  if (grading === "manual") {
    assessment.warnings.push("This question requires manual answer comparison; no automatic grade is claimed.");
  }
  const reviewState = {
    status: "completed" as const,
    basedOnSourceRevision: question.sourceRevision,
    reviewer: review.reviewer,
    reviewedAt: review.reviewedAt,
  };
  const preparedQuestion = PreparedQuestionSchema.parse({
    ...question,
    ...(completedConversion ? {
      kind: completedConversion.kind,
      prompt: completedConversion.prompt,
      options: completedConversion.options,
      shuffle: shufflePolicy(completedConversion.prompt, completedConversion.options),
      conversion: { status: "completed", reason: completedConversion.notes },
    } : conversion?.status === "pending" ? {
      conversion: { status: "pending", reason: conversion.notes },
    } : {}),
    review: reviewState,
    readiness: { content: "complete", grading, publication: "ready" },
    published: true,
    sourcePresentation: {
      kind: question.kind, prompt: question.prompt, options: question.options, shuffle: question.shuffle,
    },
    media: question.assetIds.map((id) => {
      const asset = assets.get(id);
      if (!asset) throw new Error(`${question.id}: missing media ${id}.`);
      return {
        id, objectPath: `published/az104/${releaseId}/assets/${id}.${asset.extension}`,
        contentType: asset.contentType, width: asset.width, height: asset.height,
        byteLength: asset.byteLength, sourceUrls: asset.sourceUrls,
      };
    }),
    sources: sources.map(({ occurrence }) => ({
      questionNumber: occurrence.questionNumber,
      pageNumber: occurrence.pageNumber,
      url: occurrence.url,
      sourceLabelToOptionId: occurrence.sourceLabelToOptionId,
      sourceOptionOrder: occurrence.sourceOptionOrder,
    })),
  });
  const preparedAnswers = PreparedAnswerSchema.parse({
    ...answers,
    effectiveAnswer: {
      ...answers.effectiveAnswer,
      value,
      basis,
      verification: ["confirmed", "corrected"].includes(assessment.status)
        ? "documented" : "community-reviewed",
    },
    review: reviewState,
    published: true,
    assessment,
  });
  return { question: preparedQuestion, answers: preparedAnswers };
}
