import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { errorMessage } from "../ingest/normalize-shared.js";
import { isMain, isMissingFile, writeData } from "./data.js";
import {
  reviewInputSchema, sourceReviewSchema, validateReviewProvenance,
  type ReviewInput, type SourceReview,
} from "./source-review.js";

export async function validateSourceReviewRange(from = 1, to = 606) {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to > 606 || from > to) {
    throw new Error("The source review range must be whole question numbers between 1 and 606.");
  }
  const issues: Array<{ question: number; file: string; message: string }> = [];
  const reviews: SourceReview[] = [];
  const pages = new Map<number, { input: ReviewInput; sha256: string }>();
  for (let number = from; number <= to; number++) {
    const file = `.data/curation/source-reviews/q-${String(number).padStart(4, "0")}.json`;
    let text: string;
    try { text = await readFile(file, "utf8"); }
    catch (error) {
      if (isMissingFile(error)) {
        issues.push({ question: number, file, message: "Review is missing." });
        continue;
      }
      throw error;
    }
    let json: unknown;
    try { json = JSON.parse(text); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      issues.push({ question: number, file, message: "Review is not valid JSON." });
      continue;
    }
    const parsed = sourceReviewSchema.safeParse(json);
    if (!parsed.success) {
      issues.push({ question: number, file, message: parsed.error.issues.map((issue) =>
        `${issue.path.join(".")}: ${issue.message}`).join("; ") });
      continue;
    }
    const review = parsed.data;
    if (review.sourceQuestionNumber !== number) {
      issues.push({ question: number, file, message: "Filename and source question number differ." });
      continue;
    }
    let page = pages.get(review.sourcePage);
    if (!page) {
      const bytes = await readFile(`.data/raw/pages/page-${String(review.sourcePage).padStart(3, "0")}.json`);
      page = {
        input: reviewInputSchema.parse(JSON.parse(bytes.toString("utf8"))),
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
      pages.set(review.sourcePage, page);
    }
    try {
      validateReviewProvenance(review, page.input, page.sha256);
    } catch (error) {
      issues.push({ question: number, file, message: errorMessage(error) });
      continue;
    }
    reviews.push(review);
  }
  const statuses: Record<SourceReview["answerStatus"], number> = {
    "source-default": 0, confirmed: 0, corrected: 0, unresolved: 0, "outdated-or-defective": 0,
  };
  for (const review of reviews) statuses[review.answerStatus]++;
  return {
    ok: issues.length === 0,
    from, to, expected: to - from + 1, validated: reviews.length,
    assessedComments: reviews.reduce((sum, review) => sum + review.reviewedCommentCount, 0),
    statuses, issues,
  };
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  let from = 1;
  let to = 606;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument !== "--from" && argument !== "--to") {
      throw new Error(`Unknown review validation argument: ${argument}.`);
    }
    const value = args[++index];
    if (!value || !/^\d+$/.test(value)) throw new Error(`${argument} requires a whole question number.`);
    if (argument === "--from") from = Number(value);
    else to = Number(value);
  }
  validateSourceReviewRange(from, to).then(async (report) => {
    await writeData(`.data/review-validation/${from}-${to}.json`, report);
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 2;
  }).catch((error: unknown) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
