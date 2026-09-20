import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { assertNoSymlinks } from "../ingest/normalize.js";
import { workspacePath } from "../ingest/normalize-shared.js";
import {
  CommentVerdictSchema, OfficialDocumentationUrlSchema, StudyAnswerStatusSchema,
} from "../../src/domain/study.js";

export const sourceReviewSchema = z.object({
  schemaVersion: z.literal(1),
  sourceQuestionNumber: z.number().int().min(1).max(606),
  sourcePage: z.number().int().min(1).max(122),
  rawPageSha256: z.string().regex(/^[a-f0-9]{64}$/),
  reviewedCommentCount: z.number().int().nonnegative(),
  commentVerdict: CommentVerdictSchema,
  answerStatus: StudyAnswerStatusSchema,
  effectiveSourceLabels: z.array(z.string().regex(/^[A-Z]$/)).nonempty().nullable(),
  sourceImageAnswerSummary: z.string().trim().min(1).nullable(),
  effectiveImageAnswerSummary: z.string().trim().min(1).nullable().optional(),
  rationale: z.string().trim().min(1),
  supportingComments: z.array(z.object({
    author: z.string().trim().min(1),
    excerpt: z.string().trim().min(1),
  })),
  citations: z.array(z.object({
    url: OfficialDocumentationUrlSchema,
    title: z.string().trim().min(1),
    detail: z.string().trim().min(1),
  })),
  warnings: z.array(z.string().trim().min(1)),
  reviewedAt: z.iso.datetime({ offset: true }),
}).superRefine((review, context) => {
  const issue = (path: string, message: string) => {
    context.addIssue({ code: "custom", path: [path], message });
  };
  if (Math.ceil(review.sourceQuestionNumber / 5) !== review.sourcePage) {
    issue("sourcePage", "The source page does not contain this question number.");
  }
  if (review.effectiveSourceLabels &&
      new Set(review.effectiveSourceLabels).size !== review.effectiveSourceLabels.length) {
    issue("effectiveSourceLabels", "Answer labels must be unique.");
  }
  if (["confirmed", "corrected"].includes(review.answerStatus) && review.citations.length === 0) {
    issue("citations", "Confirmed and corrected answers require consulted documentation.");
  }
  if (review.answerStatus === "corrected" && review.effectiveSourceLabels === null &&
      !review.effectiveImageAnswerSummary) {
    issue("effectiveImageAnswerSummary", "A corrected image answer needs a separate effective answer.");
  }
  if (review.answerStatus === "confirmed" && review.effectiveSourceLabels === null &&
      !review.sourceImageAnswerSummary) {
    issue("sourceImageAnswerSummary", "A confirmed image answer must identify the source answer.");
  }
  if (["unresolved", "outdated-or-defective"].includes(review.answerStatus) &&
      review.warnings.length === 0) {
    issue("warnings", "Uncertain or defective questions need a visible warning.");
  }
  if ((review.commentVerdict === "no-comments") !== (review.reviewedCommentCount === 0)) {
    issue("commentVerdict", "The no-comments verdict must agree with the captured comment count.");
  }
});

export type SourceReview = z.infer<typeof sourceReviewSchema>;

export const reviewInputSchema = z.object({
  url: z.url(),
  questions: z.array(z.object({
    heading: z.string(),
    commentCount: z.number().int().nonnegative(),
    choiceStyles: z.array(z.object({
      label: z.string(),
      text: z.string(),
      borderColor: z.string(),
    })),
  })),
});

export type ReviewInput = z.infer<typeof reviewInputSchema>;

export function validateReviewProvenance(
  review: SourceReview,
  input: ReviewInput,
  sha256: string,
): void {
  const prefix = `Question ${review.sourceQuestionNumber}`;
  if (review.rawPageSha256 !== sha256) {
    throw new Error(`${prefix}: the review refers to a different capture revision.`);
  }
  if (input.url !== `https://www.examprepper.co/exam/45/${review.sourcePage}`) {
    throw new Error(`${prefix}: the capture URL does not match its source page.`);
  }
  const question = input.questions.find((item) => item.heading === prefix);
  if (!question) throw new Error(`${prefix}: missing from the referenced capture.`);
  if (question.commentCount !== review.reviewedCommentCount) {
    throw new Error(`${prefix}: the review does not cover the captured discussion.`);
  }
  const labels = new Set(question.choiceStyles.map((choice) => choice.label));
  for (const label of review.effectiveSourceLabels ?? []) {
    if (!labels.has(label)) throw new Error(`${prefix}: unknown answer label ${label}.`);
  }
  const original = question.choiceStyles
    .filter((choice) => choice.borderColor === "rgb(104, 211, 145)")
    .map((choice) => choice.label).sort();
  const effective = [...review.effectiveSourceLabels ?? []].sort();
  if (review.answerStatus === "corrected" && original.length > 0 &&
      JSON.stringify(original) === JSON.stringify(effective)) {
    throw new Error(`${prefix}: an unchanged source key is not a correction; use documented confirmation.`);
  }
  if (review.answerStatus !== "corrected" &&
      JSON.stringify(original) !== JSON.stringify(effective)) {
    throw new Error(`${prefix}: a retained or provisional key must preserve the site's answer.`);
  }
}

export async function readSourceReviews(
  reviewDirectory = ".data/curation/source-reviews",
  captureDirectory = ".data/raw/pages",
  workspace = process.cwd(),
): Promise<SourceReview[]> {
  await assertNoSymlinks(workspace, reviewDirectory);
  const names = (await readdir(workspacePath(workspace, reviewDirectory)))
    .filter((name) => /^q-\d{4}\.json$/.test(name)).sort();
  if (names.length === 0) throw new Error(`No source reviews found in ${reviewDirectory}.`);
  const pages = new Map<number, { input: ReviewInput; sha256: string }>();
  const questions = new Set<number>();
  const reviews: SourceReview[] = [];
  for (const name of names) {
    const path = join(reviewDirectory, name);
    await assertNoSymlinks(workspace, path);
    const parsed = sourceReviewSchema.safeParse(JSON.parse(
      await readFile(workspacePath(workspace, path), "utf8"),
    ));
    if (!parsed.success) throw new Error(`${name}: invalid source review: ${parsed.error.message}`);
    const review = parsed.data;
    if (name !== `q-${String(review.sourceQuestionNumber).padStart(4, "0")}.json` ||
        questions.has(review.sourceQuestionNumber)) {
      throw new Error(`${name}: duplicate or mismatched source question identity.`);
    }
    let page = pages.get(review.sourcePage);
    if (!page) {
      const path = join(captureDirectory, `page-${String(review.sourcePage).padStart(3, "0")}.json`);
      await assertNoSymlinks(workspace, path);
      const bytes = await readFile(workspacePath(workspace, path));
      page = {
        input: reviewInputSchema.parse(JSON.parse(bytes.toString("utf8"))),
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
      pages.set(review.sourcePage, page);
    }
    validateReviewProvenance(review, page.input, page.sha256);
    questions.add(review.sourceQuestionNumber);
    reviews.push(review);
  }
  return reviews;
}
