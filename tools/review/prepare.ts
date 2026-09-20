import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import {
  AnswerRecordSchema, AssetSchema, CatalogSchema, CommentSchema, ConversionOverlaySchema, ManifestSchema,
  PreparedCatalogSchema, QuestionSchema, ReviewOverlaySchema, SourceOccurrenceSchema,
  assertDocumentSize, type Asset, type Catalog, type PreparedAnswer,
  type Comment, type PreparedQuestion, type StudyAssessment,
} from "../../src/domain/index.js";
import { auditDataset } from "../ingest/audit.js";
import { collectionDigest } from "../ingest/normalize-core.js";
import { digest, errorMessage, workspacePath } from "../ingest/normalize-shared.js";
import { isMain, readData, readOptionalData, writeData } from "./data.js";
import { type ReviewedOccurrence } from "./apply.js";
import { materializeQuestion, type MaterializeInput } from "./materialize.js";
import { readSourceReviews } from "./source-review.js";
import {
  COMMENT_FILTER_VERSION, filterQuestionComments,
} from "./filter-comments.js";

export async function buildPreparedSnapshot(workspaceRoot = process.cwd()) {
  const workspace = resolve(workspaceRoot);
  const read = <T>(path: string, schema: z.ZodType<T>) => readData(path, schema, workspace);
  const audit = await auditDataset({ workspaceRoot: workspace, requireComplete: true, forPublication: true });
  if (!audit.ok) {
    const errors = audit.issues.filter((issue) => issue.severity === "error");
    throw new Error(`Publication audit blocked preparation (${errors.length} errors):\n` +
      errors.slice(0, 15).map((issue) => `${issue.context}: ${issue.message}`).join("\n"));
  }
  const manifest = await read(".data/normalized/manifest.json", ManifestSchema);
  const catalog = await read(".data/normalized/catalog.json", CatalogSchema);
  const sourceReviews = new Map((await readSourceReviews(
    ".data/curation/source-reviews", ".data/raw/pages", workspace,
  )).map((review) =>
    [review.sourceQuestionNumber, review]));
  const inputs: MaterializeInput[] = [];
  for (const entry of [...catalog.entries].sort((a, b) =>
    Math.min(...a.sourceQuestionNumbers) - Math.min(...b.sourceQuestionNumbers))) {
    const question = await read(`.data/normalized/${entry.questionPath}`, QuestionSchema);
    const answers = await read(`.data/normalized/${entry.answerPath}`, AnswerRecordSchema);
    const review = await read(`.data/reviews/${entry.id}.json`, ReviewOverlaySchema);
    const conversion = await readOptionalData(`.data/conversions/${entry.id}.json`, ConversionOverlaySchema, workspace);
    const sources: ReviewedOccurrence[] = [];
    for (const id of question.sourceOccurrenceIds) {
      const occurrence = await read(`.data/normalized/occurrences/${id}.json`, SourceOccurrenceSchema);
      const source = sourceReviews.get(occurrence.questionNumber);
      if (!source) throw new Error(`${id}: a validated source review is missing.`);
      sources.push({ occurrence, review: source });
    }
    inputs.push({ question, answers, review, sources, ...(conversion ? { conversion } : {}) });
  }
  const assets = new Map<string, Asset>();
  for (const filename of (await readdir(workspacePath(workspace, ".data/normalized/assets"))).sort()) {
    if (!filename.endsWith(".json")) continue;
    const asset = await read(`.data/normalized/assets/${filename}`, AssetSchema);
    assets.set(asset.id, asset);
  }
  const commentsByQuestion = new Map<string, Comment[]>();
  for (const filename of (await readdir(workspacePath(workspace, ".data/normalized/comments"))).sort()) {
    if (!filename.endsWith(".json")) continue;
    const comment = await read(`.data/normalized/comments/${filename}`, CommentSchema);
    const group = commentsByQuestion.get(comment.questionId) ?? [];
    group.push(comment);
    commentsByQuestion.set(comment.questionId, group);
  }
  const filteredByQuestion = new Map(inputs.map((input) => [
    input.question.id, filterQuestionComments(input, commentsByQuestion.get(input.question.id) ?? []),
  ]));
  const decisions = [...filteredByQuestion.values()].flatMap((filtered) => filtered.decisions);
  const retainedComments = [...filteredByQuestion.values()].flatMap((filtered) => filtered.comments);
  const releaseId = `r_${digest({
    preparerVersion: "reviewed-publication-2",
    commentFilterVersion: COMMENT_FILTER_VERSION,
    commentDecisionDigest: digest(decisions),
    retainedCommentsDigest: collectionDigest(retainedComments),
    sourceRevision: manifest.sourceRevision,
    reviews: inputs.map((input) => ({ id: input.question.id, review: input.review, sources: input.sources })),
    conversions: inputs.map((input) => input.conversion ?? null),
  })}`;
  const entries: Catalog["entries"] = [];
  const reviewCounts: Record<StudyAssessment["status"], number> = {
    "source-default": 0, confirmed: 0, corrected: 0, unresolved: 0, "outdated-or-defective": 0,
  };
  const gradingCounts = { automatic: 0, manual: 0 };
  const questions: PreparedQuestion[] = [];
  const answerRecords: PreparedAnswer[] = [];
  for (const input of inputs) {
    const prepared = materializeQuestion(input, assets, releaseId);
    const filtered = filteredByQuestion.get(input.question.id);
    if (!filtered) throw new Error(`${input.question.id}: missing full-discussion relevance decisions.`);
    prepared.question.sourceCommentCount = prepared.question.commentCount;
    prepared.question.commentCount = filtered.comments.length;
    prepared.question.omittedCommentCount = prepared.question.sourceCommentCount - filtered.comments.length;
    assertDocumentSize(prepared.question, input.question.id);
    assertDocumentSize(prepared.answers, `${input.question.id} answers`);
    questions.push(prepared.question);
    answerRecords.push(prepared.answers);
    reviewCounts[prepared.answers.assessment.status]++;
    gradingCounts[prepared.question.readiness.grading]++;
    entries.push({
      id: prepared.question.id,
      sourceRevision: prepared.question.sourceRevision,
      questionPath: `questions/${prepared.question.id}.json`,
      answerPath: `answers/${prepared.question.id}.json`,
      sourceOccurrenceIds: prepared.question.sourceOccurrenceIds,
      sourceQuestionNumbers: input.sources.map(({ occurrence }) => occurrence.questionNumber),
      kind: prepared.question.kind,
      commentCount: prepared.question.commentCount,
      conversionStatus: prepared.question.conversion.status,
      reviewStatus: "completed",
      published: true,
    });
  }
  const commentFilter = {
    version: COMMENT_FILTER_VERSION, original: manifest.records.comments,
    retained: retainedComments.length, omitted: manifest.records.comments - retainedComments.length,
    decisionDigest: digest(decisions),
  };
  const records = { ...manifest.records, comments: retainedComments.length };
  const omissionReasons: Record<string, number> = {};
  for (const decision of decisions) {
    if (!decision.retained) omissionReasons[decision.reason] = (omissionReasons[decision.reason] ?? 0) + 1;
  }
  const commentFilterReport = {
    schemaVersion: 1, sourceRevision: manifest.sourceRevision, releaseId,
    ...commentFilter, omissionReasons,
    questionsWithoutRetainedComments: questions.filter((question) => question.commentCount === 0).map((question) => ({
      id: question.id, sourceQuestionNumbers: question.sources.map((source) => source.questionNumber),
      omitted: question.omittedCommentCount,
    })),
    decisions,
  };
  const preparedCatalog = PreparedCatalogSchema.parse({
    ...catalog, entries, releaseId, published: true, records,
    sourceRecords: manifest.records, commentFilter, reviewCounts, gradingCounts,
  });
  assertDocumentSize(preparedCatalog, "Prepared catalog");
  const report = {
    schemaVersion: 1, releaseId, sourceRevision: manifest.sourceRevision,
    preparerVersion: "reviewed-publication-2",
    sourceImportId: manifest.importId, records, sourceRecords: manifest.records,
    commentFilter, reviewCounts, gradingCounts,
    catalogDigest: digest(preparedCatalog), publicationAuditPassed: true,
    recordDigests: {
      questions: collectionDigest(questions),
      answers: collectionDigest(answerRecords),
      comments: collectionDigest(retainedComments),
    },
    uploaded: false,
  };
  return {
    catalog: preparedCatalog, questions, answers: answerRecords, comments: retainedComments,
    commentFilterReport, report,
  };
}

export type PreparedSnapshot = Awaited<ReturnType<typeof buildPreparedSnapshot>>;

export async function prepareDataset(workspace = process.cwd()) {
  const snapshot = await buildPreparedSnapshot(workspace);
  for (const question of snapshot.questions) {
    await writeData(`.data/prepared/questions/${question.id}.json`, question, workspace);
  }
  for (const answer of snapshot.answers) {
    await writeData(`.data/prepared/answers/${answer.id}.json`, answer, workspace);
  }
  for (const comment of snapshot.comments) {
    await writeData(`.data/prepared/comments/${comment.id}.json`, comment, workspace);
  }
  await writeData(".data/prepared/comment-filter-report.json", snapshot.commentFilterReport, workspace);
  await writeData(".data/prepared/catalog.json", snapshot.catalog, workspace);
  await writeData(".data/prepared/report.json", snapshot.report, workspace);
  return snapshot.report;
}

if (isMain(import.meta.url)) {
  if (process.argv.length > 2) throw new Error("review:prepare does not accept arguments.");
  prepareDataset().then((report) => console.log(JSON.stringify(report, null, 2))).catch((error: unknown) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
