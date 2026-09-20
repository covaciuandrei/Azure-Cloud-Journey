import {
  ConversionOverlaySchema, ReviewOverlaySchema, assertAnswerOptionIds, richAssetIds,
  type AnswerRecord, type ConversionOverlay, type Question, type ReviewOverlay,
} from "./schemas.js";

export function validateConversionForQuestion(
  question: Question, answers: AnswerRecord, input: unknown,
): ConversionOverlay {
  const overlay = ConversionOverlaySchema.parse(input);
  if (overlay.questionId !== question.id || overlay.basedOnSourceRevision !== question.sourceRevision) {
    throw new Error(`${question.id}: conversion overlay belongs to a different question/source revision`);
  }
  if (overlay.status === "completed") {
    const requiredAssets = new Set([
      ...richAssetIds(question.prompt),
      ...question.options.flatMap((option) => richAssetIds(option.content)),
      ...answers.originalAnswers.flatMap((answer) => answer.answerAssetIds),
    ]);
    const missing = [...requiredAssets].filter((id) => !overlay.sourceAssetIds.includes(id));
    const unknown = overlay.sourceAssetIds.filter((id) => !question.assetIds.includes(id));
    if (missing.length || unknown.length) {
      throw new Error(`${question.id}: conversion source image references missing [${missing.join(", ")}], unknown [${unknown.join(", ")}]`);
    }
    assertAnswerOptionIds({ id: question.id, kind: overlay.kind, options: overlay.options }, overlay.answer, "Converted answer");
  }
  return overlay;
}

export function validateReviewForQuestion(
  question: Question,
  answers: AnswerRecord,
  commentIds: readonly string[],
  input: unknown,
  conversion?: ConversionOverlay,
): ReviewOverlay {
  const overlay = ReviewOverlaySchema.parse(input);
  if (answers.questionId !== question.id || answers.sourceRevision !== question.sourceRevision) {
    throw new Error(`${question.id}: answers do not match the question source revision`);
  }
  if (overlay.questionId !== question.id || overlay.basedOnSourceRevision !== question.sourceRevision) {
    throw new Error(`${question.id}: review overlay belongs to a different question/source revision`);
  }
  const assessed = new Set(overlay.commentAssessment.assessedCommentIds);
  const expected = new Set(commentIds);
  const missing = [...expected].filter((id) => !assessed.has(id));
  const unknown = [...assessed].filter((id) => !expected.has(id));
  if (missing.length || unknown.length) {
    throw new Error(`${question.id}: semantic comment assessment missing [${missing.join(", ")}], unknown [${unknown.join(", ")}]`);
  }
  if (conversion) validateConversionForQuestion(question, answers, conversion);
  if (overlay.answerDecision.kind === "override") {
    const effectiveQuestion = conversion?.status === "completed"
      ? { id: question.id, kind: conversion.kind, options: conversion.options }
      : question;
    assertAnswerOptionIds(effectiveQuestion, overlay.answerDecision.value, "Review override");
    if (overlay.answerDecision.value.kind === "manual") {
      const unknownAssets = overlay.answerDecision.value.sourceAnswerAssetIds.filter((id) => !question.assetIds.includes(id));
      if (unknownAssets.length) throw new Error(`${question.id}: review refers to unknown answer images ${unknownAssets.join(", ")}`);
    }
  }
  return overlay;
}
