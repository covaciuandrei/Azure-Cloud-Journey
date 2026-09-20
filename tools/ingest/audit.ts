import { lstat, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  AnswerRecordSchema, AssetSchema, CatalogSchema, CommentSchema, ConversionOverlaySchema,
  EXPECTED_COVERAGE, ManifestSchema, QuestionSchema, ReviewOverlaySchema, SourceOccurrenceSchema,
  assertAnswerOptionIds, assertDocumentSize, richAssetIds,
  validateConversionForQuestion, validateReviewForQuestion,
  type AnswerRecord, type Asset, type Catalog, type Comment, type ConversionOverlay,
  type Coverage, type Manifest, type Question, type SourceOccurrence,
} from "../../src/domain/index.js";
import {
  RECORD_COLLECTIONS, collectionDigest, computeCoverage, normalizeCaptures,
  type NormalizationOptions, type RecordCollection,
} from "./normalize-core.js";
import { inspectImage } from "./normalize-assets.js";
import { assertNoSymlinks, readCaptureInputs } from "./normalize.js";
import {
  canonicalJson, digest, errorMessage, occurrenceId, relativeWorkspacePath, sha256, workspacePath,
} from "./normalize-shared.js";

export interface AuditOptions extends NormalizationOptions {
  workspaceRoot?: string;
  inputDirectory?: string;
  outputDirectory?: string;
  reviewDirectory?: string;
  conversionDirectory?: string;
  requireComplete?: boolean;
  forPublication?: boolean;
}
export interface AuditIssue {
  severity: "error" | "warning";
  code: string;
  context: string;
  message: string;
}
export interface AuditReport {
  ok: boolean;
  coverage: Coverage | null;
  records: Record<RecordCollection, number>;
  duplicateGroups: number;
  retainedSourceOccurrences: number;
  conflictingOriginalKeys: number;
  reviewStates: { pending: number; completed: number; stale: number };
  conversionStates: { notRequired: number; pending: number; completed: number; stale: number };
  issues: AuditIssue[];
}

export async function auditDataset(options: AuditOptions = {}): Promise<AuditReport> {
  const workspace = resolve(options.workspaceRoot ?? process.cwd());
  const inputDirectory = options.inputDirectory ?? ".data/raw/pages";
  const outputDirectory = options.outputDirectory ?? ".data/normalized";
  const assetDirectory = relativeWorkspacePath(workspace, options.assetDirectory ?? ".data/assets");
  const reviewDirectory = options.reviewDirectory ?? ".data/reviews";
  const conversionDirectory = options.conversionDirectory ?? ".data/conversions";
  const expected = options.expected ?? EXPECTED_COVERAGE;
  const report: AuditReport = {
    ok: false, coverage: null,
    records: { questions: 0, answers: 0, occurrences: 0, comments: 0, assets: 0 },
    duplicateGroups: 0, retainedSourceOccurrences: 0, conflictingOriginalKeys: 0,
    reviewStates: { pending: 0, completed: 0, stale: 0 },
    conversionStates: { notRequired: 0, pending: 0, completed: 0, stale: 0 },
    issues: [],
  };
  const issue = (code: string, context: string, message: string, severity: AuditIssue["severity"] = "error") =>
    report.issues.push({ severity, code, context, message });
  const check = (condition: boolean, code: string, context: string, message: string) => {
    if (!condition) issue(code, context, message);
  };
  async function readJson(path: string, optional = false): Promise<unknown | undefined> {
    try {
      await assertNoSymlinks(workspace, path);
      const absolute = workspacePath(workspace, path);
      const stat = await lstat(absolute);
      if (!stat.isFile()) throw new Error("Expected a regular JSON file");
      return JSON.parse(await readFile(absolute, "utf8")) as unknown;
    } catch (error) {
      if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      issue((error as NodeJS.ErrnoException).code === "ENOENT" ? "missing-file" : "unreadable-json", path, errorMessage(error));
      return undefined;
    }
  }
  function parse<T>(schema: z.ZodType<T>, value: unknown, context: string): T | undefined {
    if (value === undefined) return undefined;
    const result = schema.safeParse(value);
    if (!result.success) { issue("schema-invalid", context, result.error.message); return undefined; }
    return result.data;
  }
  async function readCollection<T extends { id: string }>(collection: RecordCollection, schema: z.ZodType<T>): Promise<T[]> {
    const directory = `${outputDirectory}/${collection}`;
    let entries: string[];
    try {
      await assertNoSymlinks(workspace, directory);
      entries = await readdir(workspacePath(workspace, directory));
    } catch (error) { issue("missing-collection", directory, errorMessage(error)); return []; }
    const records: T[] = [];
    for (const filename of [...entries].map(String).filter((name) => name.endsWith(".json")).sort()) {
      const path = `${directory}/${filename}`;
      const value = parse(schema, await readJson(path), path);
      if (value) {
        check(filename === `${value.id}.json`, "record-filename-mismatch", path, `Record ID ${value.id} does not match its filename`);
        try { assertDocumentSize(value, path); }
        catch (error) { issue("oversize-document", path, errorMessage(error)); }
        records.push(value);
      }
    }
    check(new Set(records.map((record) => record.id)).size === records.length,
      "duplicate-record-id", directory, "Multiple files identify the same record");
    return records;
  }
  const manifestPath = `${outputDirectory}/manifest.json`;
  const catalogPath = `${outputDirectory}/catalog.json`;
  const manifest: Manifest | undefined = parse(ManifestSchema, await readJson(manifestPath), manifestPath);
  const catalog: Catalog | undefined = parse(CatalogSchema, await readJson(catalogPath), catalogPath);
  const [questions, answers, occurrences, comments, assets]: [Question[], AnswerRecord[], SourceOccurrence[], Comment[], Asset[]] = await Promise.all([
    readCollection("questions", QuestionSchema),
    readCollection("answers", AnswerRecordSchema),
    readCollection("occurrences", SourceOccurrenceSchema),
    readCollection("comments", CommentSchema),
    readCollection("assets", AssetSchema),
  ]);
  const records = { questions, answers, occurrences, comments, assets };
  const questionMap = new Map(questions.map((record) => [record.id, record]));
  const answerMap = new Map(answers.map((record) => [record.id, record]));
  const occurrenceMap = new Map(occurrences.map((record) => [record.id, record]));
  const commentMap = new Map(comments.map((record) => [record.id, record]));
  const assetMap = new Map(assets.map((record) => [record.id, record]));
  for (const collection of RECORD_COLLECTIONS) {
    report.records[collection] = records[collection].length;
    if (manifest) {
      check(records[collection].length === manifest.records[collection], "record-count-mismatch", collection,
        `Manifest has ${manifest.records[collection]}, parsed ${records[collection].length}`);
      check(collectionDigest(records[collection]) === manifest.recordDigests[collection], "record-digest-mismatch", collection,
        "Source records differ from the completed normalization manifest");
    }
  }
  if (manifest) {
    report.coverage = manifest.coverage;
    check(manifest.coverage.expectedPages === expected.pages && manifest.coverage.expectedOccurrences === expected.occurrences &&
      manifest.coverage.pageSize === expected.pageSize, "wrong-expected-coverage", manifestPath,
    `Required coverage is ${expected.pages} pages / ${expected.occurrences} occurrences / ${expected.pageSize} per full page`);
    check(canonicalJson(computeCoverage(manifest.rawPages, expected)) === canonicalJson(manifest.coverage),
      "coverage-mismatch", manifestPath, "Coverage is inconsistent with the raw page inventory");
    if (catalog) {
      check(catalog.sourceRevision === manifest.sourceRevision, "catalog-revision-mismatch", catalogPath, "Catalog and manifest identify different source revisions");
      try {
        check(sha256(await readFile(workspacePath(workspace, catalogPath))) === manifest.catalogSha256,
          "catalog-digest-mismatch", catalogPath, "Catalog bytes differ from the manifest");
      } catch (error) { issue("unreadable-catalog", catalogPath, errorMessage(error)); }
    }
  }
  try {
    const rawInputs = await readCaptureInputs(workspace, inputDirectory);
    const source = normalizeCaptures(rawInputs, { expected, assetDirectory });
    report.coverage = source.manifest.coverage;
    if (manifest) {
      check(manifest.sourceRevision === source.manifest.sourceRevision, "stale-source-revision", manifestPath,
        `Raw captures changed; normalize again. Current source revision: ${source.manifest.sourceRevision}`);
      check(canonicalJson(manifest) === canonicalJson(source.manifest), "source-manifest-mismatch", manifestPath,
        "Stored import metadata differs from deterministic normalization of current captures");
    }
    for (const collection of RECORD_COLLECTIONS) {
      const actualIds = new Set(records[collection].map((record) => record.id));
      const expectedIds = new Set(source[collection].map((record) => record.id));
      const missing = [...expectedIds].filter((id) => !actualIds.has(id));
      const extra = [...actualIds].filter((id) => !expectedIds.has(id));
      if (missing.length) issue("missing-source-records", collection, missing.join(", "));
      if (extra.length) issue("unexpected-source-records", collection, extra.join(", "));
      check(collectionDigest(records[collection]) === source.manifest.recordDigests[collection],
        "source-content-mismatch", collection, "Records do not exactly preserve the current rendered source normalization");
    }
  } catch (error) {
    issue("raw-capture-invalid", inputDirectory, errorMessage(error));
  }
  if (report.coverage && !report.coverage.complete) {
    issue("incomplete-coverage", inputDirectory,
      `Missing pages [${report.coverage.missingPages.join(", ")}]; missing source questions [${report.coverage.missingQuestionNumbers.join(", ")}]`,
      options.requireComplete || options.forPublication ? "error" : "warning");
  }
  const commentsByOccurrence = new Map<string, Comment[]>();
  for (const comment of comments) {
    const group = commentsByOccurrence.get(comment.sourceOccurrenceId) ?? [];
    group.push(comment);
    commentsByOccurrence.set(comment.sourceOccurrenceId, group);
  }
  const checkAssets = (ids: string[], context: string) => {
    for (const id of ids) check(assetMap.has(id), "missing-asset-reference", context, `Missing asset ${id}`);
  };
  for (const occurrence of occurrences) {
    const context = `occurrences/${occurrence.id}`;
    const question = questionMap.get(occurrence.questionId);
    check(occurrence.id === occurrenceId(occurrence.questionNumber), "source-number-mismatch", context, "Occurrence ID does not match the visible question number");
    check(Boolean(question), "missing-question", context, occurrence.questionId);
    check(Boolean(question?.sourceOccurrenceIds.includes(occurrence.id)), "unretained-occurrence", context, "Question does not retain this source occurrence");
    const ownComments = commentsByOccurrence.get(occurrence.id) ?? [];
    check(ownComments.length === occurrence.capture.expectedCommentCount, "comment-reconciliation", context,
      `Captured ${occurrence.capture.expectedCommentCount}, actual comment records ${ownComments.length}`);
    const missing = occurrence.commentIds.filter((id) => !commentMap.has(id));
    const unexpected = ownComments.filter((comment) => !occurrence.commentIds.includes(comment.id)).map((comment) => comment.id);
    if (missing.length || unexpected.length) issue("comment-index-mismatch", context, `Missing [${missing.join(", ")}], unindexed [${unexpected.join(", ")}]`);
    const actualRoots = ownComments.filter((comment) => comment.parentId === null).map((comment) => comment.id).sort();
    check(canonicalJson(actualRoots) === canonicalJson([...occurrence.rootCommentIds].sort()),
      "comment-root-mismatch", context, "Root comment index does not match the preserved tree");
    if (question) {
      const ids = new Set(question.options.map((option) => option.id));
      for (const [label, id] of Object.entries(occurrence.sourceLabelToOptionId)) {
        check(ids.has(id), "invalid-source-label-mapping", context, `${label} refers to unknown option ${id}`);
      }
      check(Object.values(occurrence.sourceLabelToOptionId).length === question.options.length,
        "source-options-missing", context, "Source label mapping does not retain every question option");
    }
  }
  for (const comment of comments) {
    const context = `comments/${comment.id}`;
    const occurrence = occurrenceMap.get(comment.sourceOccurrenceId);
    check(Boolean(occurrence?.commentIds.includes(comment.id)), "orphan-comment", context, "Comment is not indexed by its occurrence");
    check(occurrence?.questionId === comment.questionId, "comment-question-mismatch", context, "Comment points to another occurrence's question");
    if (comment.parentId) {
      const parent = commentMap.get(comment.parentId);
      check(Boolean(parent?.childIds.includes(comment.id)), "comment-parent-mismatch", context, `Parent ${comment.parentId} is missing or does not retain this reply`);
      check(parent?.sourceOccurrenceId === comment.sourceOccurrenceId && parent.rootId === comment.rootId,
        "comment-tree-crosses-source", context, "Reply crosses source occurrences or root threads");
      check(parent?.treePath.length === comment.treePath.length - 1 &&
        canonicalJson(parent.treePath) === canonicalJson(comment.treePath.slice(0, -1)),
      "comment-tree-path-mismatch", context, "Reply path does not extend its parent's path");
    } else {
      check(comment.rootId === comment.id && comment.treePath.length === 1,
        "comment-root-invalid", context, "Top-level comment must be its own root");
    }
    const root = commentMap.get(comment.rootId);
    check(root?.parentId === null && root.sourceOccurrenceId === comment.sourceOccurrenceId,
      "missing-comment-root", context, `Invalid root ${comment.rootId}`);
    for (const id of comment.childIds) {
      check(commentMap.get(id)?.parentId === comment.id, "missing-comment-reply", context, `Reply ${id} is missing or misparented`);
    }
    checkAssets(richAssetIds(comment.body), context);
  }
  for (const question of questions) {
    const context = `questions/${question.id}`;
    const answer = answerMap.get(question.id);
    check(Boolean(answer), "missing-answer-record", context, question.id);
    for (const id of question.sourceOccurrenceIds) {
      check(occurrenceMap.get(id)?.questionId === question.id, "missing-source-occurrence", context, id);
    }
    const ownOccurrences = occurrences.filter((occurrence) => occurrence.questionId === question.id);
    check(ownOccurrences.length === question.sourceOccurrenceIds.length,
      "occurrence-reconciliation", context, "Question source occurrence inventory differs from retained records");
    const ownCommentIds = ownOccurrences.flatMap((occurrence) => occurrence.commentIds);
    check(ownCommentIds.length === question.commentCount, "question-comment-reconciliation", context,
      `Question reports ${question.commentCount}, occurrence indices contain ${ownCommentIds.length}`);
    checkAssets([...question.assetIds, ...richAssetIds(question.prompt), ...question.options.flatMap((option) => richAssetIds(option.content))], context);
    if (answer) {
      check(answer.sourceRevision === question.sourceRevision, "answer-revision-mismatch", context, "Answer and question source revisions differ");
      const originalIds = answer.originalAnswers.map((original) => original.sourceOccurrenceId).sort();
      check(canonicalJson(originalIds) === canonicalJson([...question.sourceOccurrenceIds].sort()),
        "original-answer-loss", context, "Every source occurrence must retain its own original answer");
      for (const original of answer.originalAnswers) {
        try { assertAnswerOptionIds(question, original.value, original.sourceOccurrenceId); }
        catch (error) { issue("invalid-original-key", context, errorMessage(error)); }
        checkAssets([...original.answerAssetIds, ...richAssetIds(original.explanation)], context);
        const source = occurrenceMap.get(original.sourceOccurrenceId);
        if (original.value.kind === "option-selection" && source) {
          const mapped = original.sourceLabels.map((label) => source.sourceLabelToOptionId[label]).sort();
          check(canonicalJson(mapped) === canonicalJson([...original.value.optionIds].sort()),
            "original-label-key-mismatch", context, `${original.sourceOccurrenceId}: original source labels and stable answer IDs disagree`);
        }
      }
      try { assertAnswerOptionIds(question, answer.effectiveAnswer.value, context); }
      catch (error) { issue("invalid-effective-key", context, errorMessage(error)); }
      if (answer.effectiveAnswer.value.kind === "manual") checkAssets(answer.effectiveAnswer.value.sourceAnswerAssetIds, context);
    }
    let conversion: ConversionOverlay | undefined;
    const conversionPath = `${conversionDirectory}/${question.id}.json`;
    const conversionJson = await readJson(conversionPath, true);
    if (conversionJson !== undefined) {
      const parsed = parse(ConversionOverlaySchema, conversionJson, conversionPath);
      if (parsed && parsed.basedOnSourceRevision !== question.sourceRevision) {
        report.conversionStates.stale++;
        issue("stale-conversion-overlay", conversionPath, `Expected source revision ${question.sourceRevision}`, "warning");
      } else if (parsed && answer) {
        try {
          conversion = validateConversionForQuestion(question, answer, parsed);
          if (conversion.status === "completed") {
            for (const option of conversion.options) {
              if (digest(option.content) !== option.contentHash) {
                throw new Error(`Converted option ${option.id} does not match its stable content hash`);
              }
            }
          }
          report.conversionStates[conversion.status === "completed" ? "completed" : "pending"]++;
        } catch (error) {
          report.conversionStates.pending++;
          issue("invalid-conversion-overlay", conversionPath, errorMessage(error));
        }
      } else report.conversionStates.pending++;
    } else report.conversionStates[question.conversion.status === "not-required" ? "notRequired" : "pending"]++;
    const reviewPath = `${reviewDirectory}/${question.id}.json`;
    const reviewJson = await readJson(reviewPath, true);
    if (reviewJson === undefined) {
      report.reviewStates.pending++;
      if (options.forPublication) issue("semantic-review-pending", context, "Publication requires a completed semantic discussion assessment");
    } else {
      const review = parse(ReviewOverlaySchema, reviewJson, reviewPath);
      if (review && review.basedOnSourceRevision !== question.sourceRevision) {
        report.reviewStates.stale++;
        issue("stale-review-overlay", reviewPath, `Expected source revision ${question.sourceRevision}`, options.forPublication ? "error" : "warning");
      } else if (review && answer) {
        try {
          validateReviewForQuestion(question, answer, ownCommentIds, review, conversion);
          report.reviewStates.completed++;
        } catch (error) {
          report.reviewStates.pending++;
          issue("invalid-semantic-review", reviewPath, errorMessage(error));
        }
      } else report.reviewStates.pending++;
    }
  }
  for (const answer of answers) {
    check(questionMap.has(answer.questionId), "orphan-answer", `answers/${answer.id}`, "Answer has no retained question");
  }
  for (const asset of assets) {
    const context = `assets/${asset.id}`;
    if (!asset.uses.length) issue("unused-captured-asset", context, "Captured bytes are preserved but have no question/comment use", "warning");
    if (asset.validation.mime === "corrected-from-signature") {
      issue("captured-mime-mismatch", context,
        `Original response MIME was incorrect; verified ${asset.contentType} retained with sourceResponses provenance`, "warning");
    }
    try {
      if (!asset.filePath.startsWith(`${assetDirectory}/`) ||
          asset.filePath !== `${assetDirectory}/${asset.id}.${asset.extension}`) {
        throw new Error("Asset path is outside its expected hash-named binary location");
      }
      await assertNoSymlinks(workspace, asset.filePath);
      const bytes = await readFile(workspacePath(workspace, asset.filePath));
      check(sha256(bytes) === asset.sha256, "asset-hash-mismatch", asset.filePath, "Existing binary differs from captured SHA256");
      check(bytes.length === asset.byteLength, "asset-length-mismatch", asset.filePath, `Declared ${asset.byteLength}, actual ${bytes.length}`);
      const info = inspectImage(bytes, asset.contentType, asset.filePath);
      check(info.width === asset.width && info.height === asset.height && info.extension === asset.extension,
        "asset-dimensions-mismatch", asset.filePath, "Image signature/dimensions do not match metadata");
    } catch (error) { issue("unreadable-asset", context, errorMessage(error)); }
    for (const use of asset.uses) {
      check(occurrenceMap.get(use.sourceOccurrenceId)?.questionId === use.questionId,
        "invalid-asset-occurrence", context, use.sourceOccurrenceId);
      check(Boolean(questionMap.get(use.questionId)?.assetIds.includes(asset.id)),
        "unindexed-question-asset", context, use.questionId);
      check(asset.sourceUrls.includes(use.sourceUrl), "invalid-asset-source-url", context, use.sourceUrl);
      if (use.role === "comment") {
        check(use.commentId !== null && commentMap.get(use.commentId)?.sourceOccurrenceId === use.sourceOccurrenceId,
          "invalid-comment-asset", context, String(use.commentId));
      } else check(use.commentId === null, "asset-role-mismatch", context, "Non-comment asset use has a comment ID");
    }
  }
  if (catalog) {
    check(new Set(catalog.entries.map((entry) => entry.id)).size === catalog.entries.length,
      "duplicate-catalog-id", catalogPath, "Catalog repeats a question ID");
    const catalogIds = new Set(catalog.entries.map((entry) => entry.id));
    for (const question of questions) check(catalogIds.has(question.id), "missing-catalog-entry", catalogPath, question.id);
    for (const entry of catalog.entries) {
      const question = questionMap.get(entry.id);
      check(Boolean(question), "orphan-catalog-entry", catalogPath, entry.id);
      check(entry.questionPath === `questions/${entry.id}.json` && entry.answerPath === `answers/${entry.id}.json`,
        "invalid-catalog-path", catalogPath, entry.id);
      if (question) check(entry.sourceRevision === question.sourceRevision && entry.commentCount === question.commentCount,
        "catalog-question-mismatch", catalogPath, entry.id);
    }
  }
  for (const directory of [reviewDirectory, conversionDirectory]) {
    try {
      await assertNoSymlinks(workspace, directory);
      for (const filename of await readdir(workspacePath(workspace, directory))) {
        if (/^q_[a-f0-9]{64}\.json$/.test(filename) && !questionMap.has(filename.slice(0, -5))) {
          issue("orphan-curation-overlay", `${directory}/${filename}`, "Overlay retained for a source question not present in this normalization", "warning");
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") issue("unreadable-curation-directory", directory, errorMessage(error));
    }
  }
  report.duplicateGroups = questions.filter((question) => question.sourceOccurrenceIds.length > 1).length;
  report.retainedSourceOccurrences = occurrences.length;
  report.conflictingOriginalKeys = answers.filter((answer) => answer.originalKeysConflict).length;
  report.ok = !report.issues.some((item) => item.severity === "error");
  return report;
}

export function parseAuditArgs(args: string[]): AuditOptions & { help?: boolean } {
  const options: AuditOptions & { help?: boolean } = {};
  const names = {
    "--input": "inputDirectory", "--output": "outputDirectory", "--assets": "assetDirectory",
    "--reviews": "reviewDirectory", "--conversions": "conversionDirectory",
  } as const;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--require-complete") { options.requireComplete = true; continue; }
    if (argument === "--for-publication") { options.forPublication = true; continue; }
    if (argument === "--help") { options.help = true; continue; }
    if (!(argument in names)) throw new Error(`Unknown audit argument ${argument}`);
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a directory`);
    options[names[argument as keyof typeof names]] = value;
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseAuditArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: npm run data:audit -- [--input .data/raw/pages] [--output .data/normalized] [--assets .data/assets] [--reviews .data/reviews] [--conversions .data/conversions] [--require-complete] [--for-publication]");
    return;
  }
  const report = await auditDataset(options);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => { console.error(errorMessage(error)); process.exitCode = 1; });
}
