import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { z } from "zod";
import {
  AnswerRecordSchema,
  AssetSchema,
  CatalogSchema,
  CommentSchema,
  ManifestSchema,
  PreparedAnswerSchema,
  PreparedCatalogSchema,
  PreparedQuestionSchema,
  QuestionSchema,
  SourceOccurrenceSchema,
  assertDocumentSize,
  richAssetIds,
  type AnswerRecord,
  type Asset,
  type Catalog,
  type Comment,
  type Manifest,
  type PreparedQuestion,
  type Question,
} from "../../src/domain/index.js";
import { assertNoSymlinks } from "../ingest/normalize.js";
import { auditDataset } from "../ingest/audit.js";
import { collectionDigest } from "../ingest/normalize-core.js";
import { buildPreparedSnapshot } from "../review/prepare.js";
import { isMissingFile } from "../review/data.js";
import { canonicalJson, digest, sha256, workspacePath } from "../ingest/normalize-shared.js";
import {
  UPLOAD_PROJECT_ID,
  type DocumentOperation,
  type ObjectOperation,
  type UploadMode,
  type UploadPlan,
} from "./types.js";

function assertFirestoreValue(value: unknown, context: string): void {
  const visit = (current: unknown, parentIsArray: boolean): void => {
    if (current === undefined) throw new Error(`${context}: undefined is not a supported Firestore value.`);
    if (Array.isArray(current)) {
      if (parentIsArray) throw new Error(`${context}: nested arrays are not supported by Firestore.`);
      current.forEach((item) => visit(item, true));
      return;
    }
    if (current !== null && typeof current === "object") {
      Object.values(current as Record<string, unknown>).forEach((item) => visit(item, false));
    }
  };
  visit(value, false);
  assertDocumentSize(value, context);
}

function documentOperation(
  phase: DocumentOperation["phase"],
  path: string,
  value: unknown,
  options: { sourcePath?: string; questionId?: string } = {},
): DocumentOperation {
  const segments = path.split("/");
  if (segments.length % 2 !== 0 || segments.some((segment) =>
    !segment || segment === "." || segment === ".." || segment.includes("\\"))) {
    throw new Error(`${path}: expected a safe Firestore document path.`);
  }
  assertFirestoreValue(value, path);
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  return {
    kind: "document",
    phase,
    path,
    contentHash: digest(value),
    byteLength: bytes,
    ...(options.sourcePath ? { sourcePath: options.sourcePath } : { data: value }),
    ...(options.questionId ? { questionId: options.questionId } : {}),
  };
}

async function readVerifiedFile(workspace: string, relativePath: string): Promise<Uint8Array> {
  await assertNoSymlinks(workspace, relativePath);
  const absolute = workspacePath(workspace, relativePath);
  const stat = await lstat(absolute);
  if (!stat.isFile()) throw new Error(`${relativePath}: expected a regular file.`);
  return readFile(absolute);
}

async function objectOperation(
  workspace: string,
  phase: ObjectOperation["phase"],
  path: string,
  sourcePath: string,
  expectedSha256: string,
  contentType: string,
  questionIds: string[] = [],
): Promise<ObjectOperation> {
  const segments = path.split("/");
  if (segments.some((segment) =>
    !segment || segment === "." || segment === ".." || segment.includes("\\")) ||
      (phase === "media" && !path.startsWith("staging/az104/") && !path.startsWith("published/az104/")) ||
      (phase === "archive" && !path.startsWith("private/az104/"))) {
    throw new Error(`${path}: expected an approved, safe Storage object path.`);
  }
  const bytes = await readVerifiedFile(workspace, sourcePath);
  const actual = sha256(bytes);
  if (actual !== expectedSha256) {
    throw new Error(`${sourcePath}: byte hash ${actual} does not match expected ${expectedSha256}.`);
  }
  return {
    kind: "object",
    phase,
    path,
    sourcePath,
    sha256: expectedSha256,
    byteLength: bytes.byteLength,
    contentType,
    questionIds: [...questionIds].sort(),
  };
}

async function readRecord<T extends { id: string }>(
  workspace: string,
  path: string,
  schema: z.ZodType<T>,
): Promise<T> {
  await assertNoSymlinks(workspace, path);
  const value = schema.parse(JSON.parse(await readFile(workspacePath(workspace, path), "utf8")));
  if (basename(path) !== `${value.id}.json`) {
    throw new Error(`${path}: filename does not match record ID ${value.id}.`);
  }
  assertFirestoreValue(value, path);
  return value;
}

async function listJson(workspace: string, directory: string): Promise<string[]> {
  await assertNoSymlinks(workspace, directory);
  return (await readdir(workspacePath(workspace, directory)))
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => `${directory}/${name}`);
}

async function verifyNormalized(
  workspace: string,
): Promise<{
  manifest: Manifest;
  catalog: Catalog;
  questions: Map<string, Question>;
  assets: Map<string, Asset>;
  stageDocuments: DocumentOperation[];
}> {
  const manifest = await readDataAt(workspace, ".data/normalized/manifest.json", ManifestSchema);
  const catalogBytes = await readVerifiedFile(workspace, ".data/normalized/catalog.json");
  if (sha256(catalogBytes) !== manifest.catalogSha256) {
    throw new Error(".data/normalized/catalog.json: byte hash differs from the normalization manifest.");
  }
  const catalog = CatalogSchema.parse(JSON.parse(new TextDecoder().decode(catalogBytes)));
  if (catalog.sourceRevision !== manifest.sourceRevision) {
    throw new Error("Normalized catalog and manifest source revisions differ.");
  }
  const questions = new Map<string, Question>();
  const assets = new Map<string, Asset>();
  const stageDocuments: DocumentOperation[] = [];
  const requiredAssets: Array<{ id: string; context: string }> = [];
  async function readCollection<T extends { id: string }>(
    name: "questions" | "answers" | "occurrences" | "comments" | "assets",
    schema: z.ZodType<T>,
    accept: (value: T, path: string) => void,
  ): Promise<void> {
    const values: T[] = [];
    for (const path of await listJson(workspace, `.data/normalized/${name}`)) {
      const value = await readRecord(workspace, path, schema);
      values.push(value);
      accept(value, path);
    }
    if (values.length !== manifest.records[name] ||
        collectionDigest(values) !== manifest.recordDigests[name]) {
      throw new Error(`${name}: record count or digest differs from the normalization manifest.`);
    }
  }
  const stage = <T extends { id: string }>(
    name: "questions" | "answers" | "occurrences" | "comments" | "assets",
    value: T,
    path: string,
    questionId?: string,
  ) => {
    stageDocuments.push(documentOperation(
      "stage",
      `importRuns/${manifest.importId}/${name}/${value.id}`,
      value,
      { sourcePath: path, ...(questionId ? { questionId } : {}) },
    ));
  };
  await readCollection("questions", QuestionSchema, (value, path) => {
    questions.set(value.id, value);
    stage("questions", value, path, value.id);
    for (const id of [
      ...value.assetIds,
      ...richAssetIds(value.prompt),
      ...value.options.flatMap((option) => richAssetIds(option.content)),
    ]) requiredAssets.push({ id, context: value.id });
  });
  await readCollection("answers", AnswerRecordSchema, (answer, path) => {
    stage("answers", answer, path, answer.questionId);
    for (const original of answer.originalAnswers) {
      for (const id of [...original.answerAssetIds, ...richAssetIds(original.explanation)]) {
        requiredAssets.push({ id, context: answer.id });
      }
      if (original.value.kind === "manual") {
        for (const id of original.value.sourceAnswerAssetIds) {
          requiredAssets.push({ id, context: answer.id });
        }
      }
    }
    if (answer.effectiveAnswer.value.kind === "manual") {
      for (const id of answer.effectiveAnswer.value.sourceAnswerAssetIds) {
        requiredAssets.push({ id, context: answer.id });
      }
    }
  });
  await readCollection("occurrences", SourceOccurrenceSchema,
    (value, path) => stage("occurrences", value, path));
  await readCollection("comments", CommentSchema, (comment, path) => {
    stage("comments", comment, path, comment.questionId);
    for (const id of richAssetIds(comment.body)) requiredAssets.push({ id, context: comment.id });
  });
  await readCollection("assets", AssetSchema, (asset, path) => {
    assets.set(asset.id, asset);
    stage("assets", asset, path);
  });
  for (const reference of requiredAssets) {
    if (!assets.has(reference.id)) {
      throw new Error(`${reference.context}: missing referenced asset ${reference.id}.`);
    }
  }
  if (catalog.entries.length !== manifest.records.questions ||
      new Set(catalog.entries.map((entry) => entry.id)).size !== catalog.entries.length) {
    throw new Error("Normalized catalog does not uniquely index every question.");
  }
  for (const entry of catalog.entries) {
    const question = questions.get(entry.id);
    if (!question || entry.questionPath !== `questions/${entry.id}.json` ||
        entry.answerPath !== `answers/${entry.id}.json`) {
      throw new Error(`${entry.id}: invalid or missing normalized catalog paths.`);
    }
    for (const assetId of [
      ...question.assetIds,
      ...richAssetIds(question.prompt),
      ...question.options.flatMap((option) => richAssetIds(option.content)),
    ]) {
      if (!assets.has(assetId)) throw new Error(`${entry.id}: missing referenced asset ${assetId}.`);
    }
  }
  return { manifest, catalog, questions, assets, stageDocuments };
}

async function readDataAt<T>(workspace: string, path: string, schema: z.ZodType<T>): Promise<T> {
  await assertNoSymlinks(workspace, path);
  return schema.parse(JSON.parse(await readFile(workspacePath(workspace, path), "utf8")));
}

function assertPreparedMatches(expected: unknown, actual: unknown, context: string): void {
  if (canonicalJson(expected) !== canonicalJson(actual)) {
    throw new Error(`${context}: prepared data is stale or edited; rerun review:prepare from the current reviews.`);
  }
}

function emptyPlan(
  mode: UploadMode,
  createdAt: string,
  blocker: string,
): UploadPlan {
  return {
    schemaVersion: 1,
    projectId: UPLOAD_PROJECT_ID,
    mode,
    status: "blocked",
    importId: "unavailable",
    releaseId: null,
    sourceRevision: "unavailable",
    createdAt,
    blockers: [blocker],
    warnings: [],
    documents: [],
    objects: [],
    counts: {
      documents: 0, objects: 0, objectBytes: 0,
      questions: 0, answers: 0, comments: 0, occurrences: 0, assets: 0,
    },
  };
}

async function buildStagePlan(workspace: string, createdAt: string): Promise<UploadPlan> {
  const source = await verifyNormalized(workspace);
  const documents: DocumentOperation[] = [...source.stageDocuments];
  const objects: ObjectOperation[] = [];
  documents.unshift(documentOperation("stage", `importRuns/${source.manifest.importId}`, {
    schemaVersion: 1,
    datasetId: "az104",
    importId: source.manifest.importId,
    sourceRevision: source.manifest.sourceRevision,
    records: source.manifest.records,
    published: false,
  }));
  for (const asset of source.assets.values()) {
    objects.push(await objectOperation(
      workspace,
      "media",
      `staging/az104/${source.manifest.importId}/assets/${asset.id}.${asset.extension}`,
      asset.filePath,
      asset.sha256,
      asset.contentType,
      [...new Set(asset.uses.map((use) => use.questionId))],
    ));
  }
  for (const page of source.manifest.rawPages) {
    objects.push(await objectOperation(
      workspace,
      "archive",
      `private/az104/${source.manifest.importId}/raw/${basename(page.path)}`,
      page.path,
      page.sha256,
      "application/json",
    ));
  }
  objects.push(await objectOperation(
    workspace,
    "archive",
    `private/az104/${source.manifest.importId}/normalized/manifest.json`,
    ".data/normalized/manifest.json",
    sha256(await readVerifiedFile(workspace, ".data/normalized/manifest.json")),
    "application/json",
  ));
  return finalizePlan({
    schemaVersion: 1,
    projectId: UPLOAD_PROJECT_ID,
    mode: "stage",
    status: "planned",
    importId: source.manifest.importId,
    releaseId: null,
    sourceRevision: source.manifest.sourceRevision,
    createdAt,
    blockers: [],
    warnings: [
      "Staging is private and does not publish reviewed study records.",
      ...(!source.manifest.coverage.complete ? [
        "This staging snapshot contains an incomplete capture; it is not the complete exam bank.",
      ] : []),
    ],
    documents,
    objects,
    counts: {
      documents: 0, objects: 0, objectBytes: 0,
      ...source.manifest.records,
    },
  });
}

async function buildPublishPlan(workspace: string, createdAt: string): Promise<UploadPlan> {
  let preparedCatalog;
  try {
    preparedCatalog = await readDataAt(workspace, ".data/prepared/catalog.json", PreparedCatalogSchema);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return emptyPlan("publish", createdAt,
        "Prepared publication data is missing; complete semantic reviews and run review:prepare.");
    }
    throw error;
  }
  const publicationAudit = await auditDataset({
    workspaceRoot: workspace,
    requireComplete: true,
    forPublication: true,
  });
  if (!publicationAudit.ok) {
    const errors = publicationAudit.issues.filter((issue) => issue.severity === "error");
    throw new Error(`Fresh publication audit failed (${errors.length} errors): ` +
      errors.slice(0, 10).map((issue) => `${issue.context}: ${issue.message}`).join("; "));
  }
  const source = await verifyNormalized(workspace);
  const expected = await buildPreparedSnapshot(workspace);
  assertPreparedMatches(expected.catalog, preparedCatalog, ".data/prepared/catalog.json");
  const savedReport = JSON.parse(new TextDecoder().decode(
    await readVerifiedFile(workspace, ".data/prepared/report.json"),
  )) as unknown;
  assertPreparedMatches(expected.report, savedReport, ".data/prepared/report.json");
  const expectedQuestions = new Map(expected.questions.map((question) => [question.id, question]));
  const expectedAnswers = new Map(expected.answers.map((answer) => [answer.id, answer]));
  if (preparedCatalog.sourceRevision !== source.manifest.sourceRevision ||
      canonicalJson(preparedCatalog.sourceRecords) !== canonicalJson(source.manifest.records) ||
      preparedCatalog.published !== true) {
    throw new Error("Prepared catalog does not describe this complete normalized source revision.");
  }
  const documents: DocumentOperation[] = [];
  const objectsByPath = new Map<string, ObjectOperation>();
  const commentsByQuestion = new Map<string, Comment[]>();
  for (const expectedComment of expected.comments) {
    const path = `.data/prepared/comments/${expectedComment.id}.json`;
    const comment = await readRecord(workspace, path, CommentSchema);
    assertPreparedMatches(expectedComment, comment, path);
    const group = commentsByQuestion.get(comment.questionId) ?? [];
    group.push(comment);
    commentsByQuestion.set(comment.questionId, group);
  }
  const preparedQuestions = new Map<string, PreparedQuestion>();
  for (const entry of preparedCatalog.entries) {
    if (!entry.published || entry.reviewStatus !== "completed") {
      throw new Error(`${entry.id}: prepared catalog contains an unpublished or unreviewed entry.`);
    }
    const questionPath = `.data/prepared/${entry.questionPath}`;
    const answerPath = `.data/prepared/${entry.answerPath}`;
    const question = await readRecord(workspace, questionPath, PreparedQuestionSchema);
    const answer = await readRecord(workspace, answerPath, PreparedAnswerSchema);
    const expectedQuestion = expectedQuestions.get(entry.id);
    const expectedAnswer = expectedAnswers.get(entry.id);
    if (!expectedQuestion || !expectedAnswer) {
      throw new Error(`${entry.id}: prepared record does not belong to the current reviewed dataset.`);
    }
    assertPreparedMatches(expectedQuestion, question, questionPath);
    assertPreparedMatches(expectedAnswer, answer, answerPath);
    if (question.id !== entry.id || answer.id !== entry.id || !question.published || !answer.published ||
        question.readiness.publication !== "ready") {
      throw new Error(`${entry.id}: prepared records are not publication-ready.`);
    }
    preparedQuestions.set(question.id, question);
    const comments = [...(commentsByQuestion.get(question.id) ?? [])]
      .sort((a, b) => a.id.localeCompare(b.id));
    if (comments.length !== question.commentCount) {
      throw new Error(`${question.id}: prepared comment count does not match normalized comments.`);
    }
    const publicMediaIds = new Set(question.media.map((media) => media.id));
    const requiredMedia = new Set([
      ...question.assetIds,
      ...comments.flatMap((comment) => richAssetIds(comment.body)),
      ...answer.originalAnswers.flatMap((original) => [
        ...original.answerAssetIds,
        ...richAssetIds(original.explanation),
        ...(original.value.kind === "manual" ? original.value.sourceAnswerAssetIds : []),
      ]),
      ...(answer.effectiveAnswer.value.kind === "manual"
        ? answer.effectiveAnswer.value.sourceAnswerAssetIds
        : []),
    ]);
    for (const assetId of requiredMedia) {
      if (!publicMediaIds.has(assetId)) {
        throw new Error(`${question.id}: required public media ${assetId} is absent from prepared media.`);
      }
    }
    for (const comment of comments) {
      documents.push(documentOperation(
        "comments",
        `questions/${question.id}/comments/${comment.id}`,
        comment,
        { sourcePath: `.data/prepared/comments/${comment.id}.json`, questionId: question.id },
      ));
    }
    documents.push(documentOperation(
      "publication", `answerKeys/${answer.id}`, answer,
      { sourcePath: answerPath, questionId: question.id },
    ));
    documents.push(documentOperation(
      "publication", `questions/${question.id}`, question,
      { sourcePath: questionPath, questionId: question.id },
    ));
    for (const media of question.media) {
      const asset = source.assets.get(media.id);
      if (!asset || asset.sha256 !== media.id || asset.contentType !== media.contentType ||
          asset.byteLength !== media.byteLength || asset.width !== media.width ||
          asset.height !== media.height ||
          media.objectPath !== `published/az104/${preparedCatalog.releaseId}/assets/${asset.id}.${asset.extension}`) {
        throw new Error(`${question.id}: prepared media ${media.id} does not match verified normalized bytes.`);
      }
      const existing = objectsByPath.get(media.objectPath);
      const questionIds = [...new Set([...(existing?.questionIds ?? []), question.id])].sort();
      objectsByPath.set(media.objectPath, await objectOperation(
        workspace, "media", media.objectPath, asset.filePath, asset.sha256, asset.contentType, questionIds,
      ));
    }
  }
  if (preparedQuestions.size !== source.manifest.records.questions ||
      documents.filter((operation) => operation.phase === "comments").length !== preparedCatalog.records.comments) {
    throw new Error("Prepared publication does not include every question and comment.");
  }
  documents.push(documentOperation(
    "catalog", "catalogs/az104", preparedCatalog,
    { sourcePath: ".data/prepared/catalog.json" },
  ));
  const addArchive = async (path: string, sourcePath: string) => {
    const bytes = await readVerifiedFile(workspace, sourcePath);
    const operation = await objectOperation(
      workspace, "archive", path, sourcePath, sha256(bytes), "application/json",
    );
    objectsByPath.set(path, operation);
  };
  for (const page of source.manifest.rawPages) {
    await addArchive(
      `private/az104/${source.manifest.importId}/raw/${basename(page.path)}`, page.path,
    );
  }
  await addArchive(
    `private/az104/${source.manifest.importId}/normalized/manifest.json`,
    ".data/normalized/manifest.json",
  );
  await addArchive(
    `private/az104/${preparedCatalog.releaseId}/prepared/report.json`,
    ".data/prepared/report.json",
  );
  const filterReport = JSON.parse(new TextDecoder().decode(
    await readVerifiedFile(workspace, ".data/prepared/comment-filter-report.json"),
  )) as unknown;
  assertPreparedMatches(expected.commentFilterReport, filterReport, ".data/prepared/comment-filter-report.json");
  await addArchive(
    `private/az104/${preparedCatalog.releaseId}/prepared/comment-filter-report.json`,
    ".data/prepared/comment-filter-report.json",
  );
  for (const entry of preparedCatalog.entries) {
    await addArchive(
      `private/az104/${preparedCatalog.releaseId}/reviews/${entry.id}.json`,
      `.data/reviews/${entry.id}.json`,
    );
    const conversionPath = `.data/conversions/${entry.id}.json`;
    let hasConversion = false;
    try {
      await assertNoSymlinks(workspace, conversionPath);
      hasConversion = (await lstat(workspacePath(workspace, conversionPath))).isFile();
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    if (hasConversion) {
      await addArchive(
        `private/az104/${preparedCatalog.releaseId}/conversions/${entry.id}.json`,
        conversionPath,
      );
    }
    for (const number of entry.sourceQuestionNumbers) {
      const filename = `q-${String(number).padStart(4, "0")}.json`;
      await addArchive(
        `private/az104/${preparedCatalog.releaseId}/source-reviews/${filename}`,
        `.data/curation/source-reviews/${filename}`,
      );
    }
  }
  return finalizePlan({
    schemaVersion: 1,
    projectId: UPLOAD_PROJECT_ID,
    mode: "publish",
    status: "planned",
    importId: source.manifest.importId,
    releaseId: preparedCatalog.releaseId,
    sourceRevision: source.manifest.sourceRevision,
    createdAt,
    blockers: [],
    warnings: [
      "Publication still requires --apply and a fresh successful cloud safety preflight.",
      "The Firestore write budget is a conservative application limit, not a guaranteed spending cap.",
    ],
    documents,
    objects: [...objectsByPath.values()].sort((a, b) => a.path.localeCompare(b.path)),
    counts: {
      documents: 0, objects: 0, objectBytes: 0,
      ...preparedCatalog.records,
    },
  });
}

function finalizePlan(plan: UploadPlan): UploadPlan {
  plan.documents = [...plan.documents].sort((a, b) => {
    const phase = { stage: 0, comments: 1, publication: 2, catalog: 3 };
    return phase[a.phase] - phase[b.phase] || (a.questionId ?? "").localeCompare(b.questionId ?? "") ||
      a.path.localeCompare(b.path);
  });
  plan.objects = [...plan.objects].sort((a, b) => {
    const phase = { media: 0, archive: 1 };
    return phase[a.phase] - phase[b.phase] || a.path.localeCompare(b.path);
  });
  plan.counts.documents = plan.documents.length;
  plan.counts.objects = plan.objects.length;
  plan.counts.objectBytes = plan.objects.reduce((total, operation) => total + operation.byteLength, 0);
  return plan;
}

export async function buildUploadPlan(
  mode: UploadMode,
  options: { workspace?: string; now?: Date } = {},
): Promise<UploadPlan> {
  const workspace = resolve(options.workspace ?? process.cwd());
  const createdAt = (options.now ?? new Date()).toISOString();
  return mode === "stage"
    ? buildStagePlan(workspace, createdAt)
    : buildPublishPlan(workspace, createdAt);
}

export const uploadPlanInternals = {
  assertFirestoreValue, documentOperation, objectOperation, assertPreparedMatches,
};
