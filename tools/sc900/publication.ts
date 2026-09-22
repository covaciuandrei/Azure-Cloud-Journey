import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, statfs, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  SC900_BANK_VERSION, SC900_METADATA_PATHS, SC900_STATIC_BASE,
  Sc900CatalogSchema, Sc900DiscussionSchema, Sc900DocumentSchema, Sc900ManifestSchema,
  sc900FirestoreRoot,
  type Sc900Catalog, type Sc900Discussion, type Sc900Document, type Sc900Manifest,
} from "../../src/domain/sc900Bank.js";
import { Sc900CaptureLedgerSchema, type Sc900CaptureLedger } from "../../src/domain/sc900Capture.js";
import { Sc900TopicMapSchema, type Sc900TopicMap } from "../../src/domain/sc900Topics.js";
import {
  Sc900LearningDatasetSchema, Sc900LearningManifestSchema,
  type Sc900LearningExplanation,
  type Sc900LearningDataset, type Sc900LearningManifest,
} from "../../src/domain/sc900Learning.js";
import { Sc900EligibilityPolicySchema, type Sc900EligibilityPolicy } from "../../src/domain/sc900Eligibility.js";
import {
  Sc900ApprovalReceiptSchema, Sc900ExpectedCaptureSchema, Sc900FinalReviewSchema,
  Sc900PublicationProofSchema, Sc900PublicationReviewSchema,
  type Sc900ApprovalReceipt, type Sc900FinalReview, type Sc900PublicationReview, type Sc900ReviewTarget,
  type Sc900ExpectedCapture,
} from "../../src/domain/sc900Publication.js";
import { richAssetIds } from "../../src/domain/schemas.js";
import { assertNoCredentialUrls } from "../../src/domain/publicUrls.js";
import { SC900_INACTIVE, Sc900AvailabilitySchema } from "../../src/domain/examAvailability.js";
import { mediaExtension } from "../../src/domain/cleanBank.js";
import { inspectImage } from "../ingest/normalize-assets.js";
import { plainText } from "../ingest/normalize-shared.js";
import { assertPlannedHeadroom, OperationBudget, writeBudgetForUsage } from "../publish/operation-budget.js";
import { acquireUploadLock, pacificQuotaDay } from "../publish/quota.js";
import type { FirestoreUsage } from "../publish/usage.js";
import { byteSha256, canonicalJson, sc900Hash, sc900OptionId, sc900QuestionId, sc900SourceRevision } from "./canonical.js";

export const SC900_DRAFT_RELEASE_ID = `r_${"0".repeat(64)}`;
export const SC900_EXPORT_LIMITS = {
  files: 10000,
  jsonBytes: 800000,
  assetBytes: 8 * 1024 * 1024,
  totalBytes: 512 * 1024 * 1024,
  imagePixels: 40_000_000,
  proofBytes: 16 * 1024 * 1024,
  minimumFreeBytes: 2.5 * 1024 ** 3,
} as const;

export interface Sc900PublicationInput {
  expectedCapture: Sc900ExpectedCapture;
  ledger: Sc900CaptureLedger;
  documents: Sc900Document[];
  discussions: Sc900Discussion[];
  topics: Sc900TopicMap;
  learning: Sc900LearningDataset;
  eligibility: Sc900EligibilityPolicy;
  assets: ReadonlyMap<string, Uint8Array>;
}

export interface Sc900PreparedRelease {
  expectedCapture: Sc900ExpectedCapture;
  ledger: Sc900CaptureLedger;
  manifest: Sc900Manifest;
  catalog: Sc900Catalog;
  documents: Sc900Document[];
  discussions: Sc900Discussion[];
  topics: Sc900TopicMap;
  learning: Sc900LearningDataset;
  learningManifest: Sc900LearningManifest;
  eligibility: Sc900EligibilityPolicy;
  assets: ReadonlyMap<string, Uint8Array>;
}

export interface Sc900ExportFile {
  path: string;
  sha256: string;
  byteLength: number;
  contentType: "application/json" | "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  bytes: Uint8Array;
}

export interface Sc900StaticPlan {
  schemaVersion: 1;
  examId: "sc900";
  activate: false;
  release: Sc900PreparedRelease;
  review: Sc900PublicationReview;
  reviewDigest: string;
  planDigest: string;
  files: Sc900ExportFile[];
  totalBytes: number;
}

const Sc900InventorySchema = z.array(z.object({
  path: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  byteLength: z.number().int().positive().max(SC900_EXPORT_LIMITS.assetBytes),
  contentType: z.enum(["application/json", "image/png", "image/jpeg", "image/gif", "image/webp"]),
}).strict()).nonempty().max(SC900_EXPORT_LIMITS.files)
  .refine((files) => new Set(files.map((file) => file.path)).size === files.length, "SC900 inventory paths must be unique");

export interface Sc900Publication {
  source: { directory: string };
  expectedCapture: Sc900ExpectedCapture;
  manifest: Sc900Manifest;
  catalog: Sc900Catalog;
  documents: Sc900Document[];
  discussions: Sc900Discussion[];
  topics: Sc900TopicMap;
  learning: Sc900LearningManifest;
  explanations: Map<string, Sc900LearningExplanation>;
  eligibility: Sc900EligibilityPolicy;
  releases: Array<Pick<Sc900PreparedRelease, "catalog" | "documents" | "discussions">>;
  files: Map<string, { kind: "source"; path: string }>;
  receipt: Sc900ApprovalReceipt;
  inventory: z.infer<typeof Sc900InventorySchema>;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function sameIds(a: Iterable<string>, b: Iterable<string>): boolean {
  const left = [...a].sort();
  const right = [...b].sort();
  return canonicalJson(left) === canonicalJson(right);
}
function same(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
function sorted<T>(items: readonly T[], id: (item: T) => string): T[] {
  return [...items].sort((a, b) => id(a).localeCompare(id(b)));
}
export function sc900OriginalKeyDigest(document: Sc900Document): string {
  return sc900Hash("original-answers", document.answers.originalAnswers);
}

function releaseIdentity(input: Omit<Sc900PublicationInput, "assets">): unknown {
  return {
    expectedCapture: input.expectedCapture,
    ledger: input.ledger,
    documents: input.documents.map(({ releaseId: _release, question, ...document }) => ({
      ...document,
      question: { ...question, media: question.media.map(({ objectPath: _path, ...media }) => media) },
    })),
    discussions: input.discussions.map(({ releaseId: _release, ...discussion }) => discussion),
    topics: (({ releaseId: _release, ...topics }) => topics)(input.topics),
    learning: (({ releaseId: _release, baseReleaseId: _base, ...learning }) => learning)(input.learning),
    eligibility: (({ releaseId: _release, teachingReleaseId: _teaching, policyId: _id, ...eligibility }) =>
      eligibility)(input.eligibility),
  };
}

/** Bind draft release placeholders to one immutable, exam-scoped content identity. Does not approve or write. */
export function prepareSc900Release(input: Sc900PublicationInput): Sc900PreparedRelease {
  assertNoCredentialUrls(input);
  assert(input.documents.length * 3 + input.assets.size + 6 <= SC900_EXPORT_LIMITS.files &&
    [...input.assets.values()].reduce((total, bytes) => total + bytes.byteLength, 0) <= SC900_EXPORT_LIMITS.totalBytes,
  "SC900 input exceeds the bounded static export budget");
  const expectedCapture = Sc900ExpectedCaptureSchema.parse(input.expectedCapture);
  const ledger = Sc900CaptureLedgerSchema.parse(input.ledger);
  assert(ledger.reported.questions === expectedCapture.questions && ledger.reported.pages === expectedCapture.pages,
    "SC900 capture ledger does not match the independently verified expected source scope");
  const documents = sorted(input.documents.map((item) => Sc900DocumentSchema.parse(item)), (item) => item.question.id);
  const discussions = sorted(input.discussions.map((item) => Sc900DiscussionSchema.parse(item)), (item) => item.questionId);
  const topics = Sc900TopicMapSchema.parse(input.topics);
  const learning = Sc900LearningDatasetSchema.parse(input.learning);
  learning.explanations = sorted(learning.explanations, (item) => item.questionId);
  const eligibility = Sc900EligibilityPolicySchema.parse(input.eligibility);
  assertNoCredentialUrls({ expectedCapture, ledger, documents, discussions, topics, learning, eligibility });
  const sourceRevision = sc900SourceRevision(ledger);
  const captureLedgerDigest = sc900Hash("capture-ledger", ledger);
  eligibility.reviewedQuestionIds.sort();
  eligibility.activeQuestionIds.sort();
  eligibility.retired = sorted(eligibility.retired, (item) => item.questionId);
  const ids = documents.map((document) => document.question.id);
  assert(ids.length > 0 && new Set(ids).size === ids.length, "SC900 canonical questions must be nonempty and unique");
  assert(documents.length <= SC900_EXPORT_LIMITS.files, "SC900 input exceeds the bounded export file budget");
  assert(sameIds(ids, discussions.map((item) => item.questionId)), "Every SC900 question requires one discussion record, including empty discussions");
  assert(sameIds(ids, Object.keys(topics.assignments)), "SC900 topic assignments must cover exactly this canonical bank");
  assert(sameIds(ids, learning.explanations.map((item) => item.questionId)), "SC900 learning must cover exactly this canonical bank");
  assert(sameIds(ids, eligibility.reviewedQuestionIds), "SC900 relevance review must cover exactly this canonical bank");
  assert([topics, learning, eligibility].every((item) => item.sourceRevision === sourceRevision),
    "SC900 metadata source revisions differ from the verified capture");
  const allOccurrences = documents.flatMap((document) => document.question.sourceOccurrenceIds);
  assert(sameIds(allOccurrences, ledger.occurrences.map((item) => item.id)),
    "SC900 bank must preserve every verified source occurrence exactly once");
  const mediaById = new Map<string, Sc900Document["question"]["media"][number]>();
  for (const document of documents) {
    const question = document.question;
    assert(question.id === sc900QuestionId(question), "SC900 question ID is not its exam-scoped canonical content hash");
    assert(question.sourceRevision === sourceRevision, "SC900 question source revision must bind the verified capture ledger");
    for (const option of question.options) {
      const base = sc900OptionId(option.content);
      assert(option.id === base || new RegExp(`^${base}_[1-9]\\d*$`).test(option.id),
        "SC900 option ID is not its exam-scoped content hash");
    }
    const discussion = discussions.find((item) => item.questionId === question.id)!;
    const occurrences = ledger.occurrences.filter((item) => question.sourceOccurrenceIds.includes(item.id));
    assert(sameIds(discussion.comments.map((comment) => comment.id), occurrences.flatMap((item) => item.commentIds)),
      "SC900 discussion does not preserve every verified captured comment");
    assert(question.commentCount === discussion.comments.length, "SC900 question comment count is incomplete");
    for (const comment of discussion.comments) {
      assert(comment.sourceRevision === sourceRevision &&
        occurrences.find((item) => item.id === comment.sourceOccurrenceId)?.commentIds.includes(comment.id),
      "SC900 comment source attribution does not match the ledger");
    }
    for (const source of question.sources) {
      const occurrence = occurrences.find((item) => item.questionNumber === source.questionNumber);
      const page = ledger.pages.find((item) => item.pageNumber === source.pageNumber);
      assert(occurrence && occurrence.pageNumber === source.pageNumber && page?.url === source.url,
        "SC900 source number, page or URL differs from the verified capture ledger");
      const answer = document.answers.originalAnswers.find((item) => item.sourceOccurrenceId === occurrence.id);
      assert(answer?.provenance.url === source.url, "SC900 original answer source URL differs from its occurrence");
    }
    const referenced = new Set([
      ...question.assetIds, ...richAssetIds(question.prompt),
      ...question.options.flatMap((option) => richAssetIds(option.content)),
      ...document.answers.originalAnswers.flatMap((answer) => [
        ...answer.answerAssetIds, ...richAssetIds(answer.explanation),
        ...(answer.value.kind === "manual" ? answer.value.sourceAnswerAssetIds : []),
      ]),
      ...(document.answers.effectiveAnswer.value.kind === "manual" ?
        document.answers.effectiveAnswer.value.sourceAnswerAssetIds : []),
      ...discussion.comments.flatMap((comment) => richAssetIds(comment.body)),
    ]);
    const capturedAssetIds = new Set(occurrences.flatMap((item) => item.assetIds));
    assert(sameIds(capturedAssetIds, question.media.map((asset) => asset.id)) &&
      sameIds(capturedAssetIds, referenced), "Every captured SC900 asset must remain referenced and locally available");
    for (const media of question.media) {
      const previous = mediaById.get(media.id);
      assert(!previous || same(previous, media), "Shared SC900 image metadata differs across questions");
      mediaById.set(media.id, media);
    }
    const explanation = learning.explanations.find((item) => item.questionId === question.id)!;
    assert(explanation.questionSourceRevision === sourceRevision && explanation.originalKeyDigest === sc900OriginalKeyDigest(document),
      "SC900 teaching explanation is stale against its source answers");
    assert(sameIds(explanation.options.map((option) => option.optionId), question.options.map((option) => option.id)),
      "SC900 explanation must discuss every option exactly once");
    assert((explanation.correctOptionIds ?? []).every((id) => question.options.some((option) => option.id === id)),
      "SC900 explanation references an unknown option");
    const effective = document.answers.effectiveAnswer.value;
    if (question.readiness.grading === "automatic" &&
        ["supported", "corrected"].includes(explanation.status)) {
      assert(effective.kind === "option-selection" &&
        sameIds(effective.optionIds, explanation.correctOptionIds ?? []),
      "SC900 automatic grading contradicts the reviewed learning explanation");
    }
  }
  assert(sameIds(mediaById.keys(), ledger.assets.map((asset) => asset.id)) &&
    sameIds(input.assets.keys(), mediaById.keys()), "SC900 export asset inventory differs from capture");
  const assets = new Map<string, Uint8Array>();
  for (const captured of ledger.assets) {
    const media = mediaById.get(captured.id)!;
    const bytes = input.assets.get(captured.id)!;
    assert(captured.byteLength <= SC900_EXPORT_LIMITS.assetBytes &&
      captured.width * captured.height <= SC900_EXPORT_LIMITS.imagePixels, "SC900 image exceeds export limits");
    assert(bytes.byteLength === captured.byteLength && byteSha256(bytes) === captured.id,
      "SC900 asset bytes do not match the verified capture hash and length");
    const info = inspectImage(Buffer.from(bytes), captured.contentType, captured.id);
    assert(["contentType", "width", "height", "byteLength"].every((key) =>
      media[key as keyof typeof media] === captured[key as keyof typeof captured]) &&
      info.contentType === captured.contentType && info.width === captured.width && info.height === captured.height,
    "SC900 media signature, MIME, dimensions or length differs from capture");
    assets.set(captured.id, Uint8Array.from(bytes));
  }
  const retired = new Map(eligibility.retired.map((item) => [item.questionId, item]));
  for (const document of documents) {
    const retirement = retired.get(document.question.id);
    if (retirement) {
      assert(sameIds(retirement.sourceNumbers.map(String), document.question.sources.map((source) => String(source.questionNumber))),
        "SC900 retirement source numbers do not match their question");
    }
  }
  const countsFor = (selected: Sc900Document[]) => {
    const sourceQuestions = selected.reduce((total, document) => total + document.question.sources.length, 0);
    const automatic = selected.filter((document) => document.question.readiness.grading === "automatic").length;
    return {
      questions: selected.length,
      comments: selected.reduce((total, document) => total + document.question.commentCount, 0),
      images: new Set(selected.flatMap((document) => document.question.media.map((asset) => asset.id))).size,
      automatic, manual: selected.length - automatic, omittedComments: 0,
      sourceQuestions, duplicatesGrouped: sourceQuestions - selected.length,
    };
  };
  assert(same(eligibility.activeCounts, countsFor(documents.filter((document) =>
    eligibility.activeQuestionIds.includes(document.question.id)))), "SC900 relevance active counts do not match the selected bank");
  const releaseId = `r_${sc900Hash("release", releaseIdentity({
    expectedCapture, ledger, documents, discussions, topics, learning, eligibility,
  }))}`;
  for (const document of documents) {
    document.releaseId = releaseId;
    document.question.media.forEach((media) => {
      media.objectPath = `published/sc900/${releaseId}/assets/${media.id}.${mediaExtension(media.contentType)}`;
    });
  }
  discussions.forEach((discussion) => { discussion.releaseId = releaseId; });
  topics.releaseId = releaseId;
  learning.releaseId = releaseId;
  learning.baseReleaseId = releaseId;
  eligibility.releaseId = releaseId;
  eligibility.teachingReleaseId = releaseId;
  const { policyId: _policyId, ...policyIdentity } = eligibility;
  eligibility.policyId = `e_${sc900Hash("eligibility", policyIdentity)}`;
  const counts = countsFor(documents);
  const catalog = Sc900CatalogSchema.parse({
    schemaVersion: 1, examId: "sc900", bankVersion: SC900_BANK_VERSION, releaseId, sourceRevision, counts,
    questions: documents.map(({ question, answers, discussionEnabled }) => ({
      id: question.id,
      number: Math.min(...question.sources.map((source) => source.questionNumber)),
      kind: question.kind, grading: question.readiness.grading, provisional: answers.provisional,
      commentCount: question.commentCount, omittedCommentCount: 0, hasImages: question.media.length > 0,
      preview: plainText(question.prompt).slice(0, 4000),
      searchText: plainText([...question.prompt, ...question.options.flatMap((option) => option.content)]).slice(0, 100000),
      sourceNumbers: question.sources.map((source) => source.questionNumber).sort((a, b) => a - b), discussionEnabled,
    })).sort((a, b) => a.number - b.number),
  });
  const manifest = Sc900ManifestSchema.parse({
    schemaVersion: 1, examId: "sc900", bankVersion: SC900_BANK_VERSION, releaseId, sourceRevision, captureLedgerDigest,
    approvedCommentsDigest: sc900Hash("approved-comments", discussions.flatMap((discussion) => discussion.comments)),
    catalogUrl: `content/${releaseId}/catalog.json`, questionBaseUrl: `content/${releaseId}/questions/`,
    discussionBaseUrl: `content/${releaseId}/discussions/`, mediaBaseUrl: `content/${releaseId}/media/`, counts,
  });
  const learningManifest = Sc900LearningManifestSchema.parse({
    schemaVersion: 1, examId: "sc900", bankVersion: SC900_BANK_VERSION,
    releaseId, baseReleaseId: releaseId, sourceRevision, questionCount: documents.length,
    records: Object.fromEntries(learning.explanations.map((item) => [item.questionId, {
      sha256: byteSha256(jsonBytes(item)), sourceRevisions: [item.questionSourceRevision],
    }])),
  });
  return { expectedCapture, ledger, manifest, catalog, documents, discussions, topics, learning, learningManifest, eligibility, assets };
}

export function sc900ReviewTargets(release: Sc900PreparedRelease): Sc900ReviewTarget[] {
  return release.documents.map((document) => ({
    questionId: document.question.id,
    documentHash: sc900Hash("document", document),
    discussionHash: sc900Hash("discussion", release.discussions.find((item) => item.questionId === document.question.id)),
    learningHash: sc900Hash("learning", release.learning.explanations.find((item) => item.questionId === document.question.id)),
    topicsHash: sc900Hash("topics", release.topics.assignments[document.question.id]),
    relevanceHash: sc900Hash("relevance", {
      active: release.eligibility.activeQuestionIds.includes(document.question.id),
      retirement: release.eligibility.retired.find((item) => item.questionId === document.question.id) ?? null,
    }),
  }));
}

function jsonBytes(value: unknown): Uint8Array {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}

export function isSc900ExportPath(path: string, releaseId: string): boolean {
  if (!/^r_[a-f0-9]{64}$/.test(releaseId)) return false;
  if (path === `${SC900_STATIC_BASE}manifest.json` || path === `${SC900_STATIC_BASE}availability.json`) return true;
  const root = `${SC900_STATIC_BASE}content/${releaseId}/`;
  if (!path.startsWith(root)) return false;
  const leaf = path.slice(root.length);
  return /^(catalog|topics|eligibility)\.json$/.test(leaf) ||
    /^questions\/q_[a-f0-9]{64}\.json$/.test(leaf) ||
    /^discussions\/q_[a-f0-9]{64}\.json$/.test(leaf) ||
    /^learning\/manifest\.json$/.test(leaf) ||
    /^learning\/questions\/q_[a-f0-9]{64}\.json$/.test(leaf) ||
    /^media\/[a-f0-9]{64}\.(png|jpg|gif|webp)$/.test(leaf);
}

function exportFiles(release: Sc900PreparedRelease): Sc900ExportFile[] {
  const files: Sc900ExportFile[] = [];
  const put = (path: string, bytes: Uint8Array, contentType: Sc900ExportFile["contentType"]) => {
    assert(isSc900ExportPath(path, release.manifest.releaseId), "Path is outside the SC900 static export allowlist");
    assert(bytes.byteLength > 0 && bytes.byteLength <= (contentType === "application/json" ?
      SC900_EXPORT_LIMITS.jsonBytes : SC900_EXPORT_LIMITS.assetBytes), "SC900 export file exceeds size limits");
    files.push({ path, bytes, contentType, byteLength: bytes.byteLength, sha256: byteSha256(bytes) });
  };
  const root = `${SC900_STATIC_BASE}content/${release.manifest.releaseId}/`;
  const json = (path: string, value: unknown) => put(path, jsonBytes(value), "application/json");
  json(`${SC900_STATIC_BASE}availability.json`, Sc900AvailabilitySchema.parse(SC900_INACTIVE));
  json(`${SC900_STATIC_BASE}manifest.json`, release.manifest);
  json(`${root}catalog.json`, release.catalog);
  json(`${root}topics.json`, release.topics);
  json(`${root}eligibility.json`, release.eligibility);
  json(`${root}learning/manifest.json`, release.learningManifest);
  release.documents.forEach((document) => json(`${root}questions/${document.question.id}.json`, document));
  release.discussions.forEach((discussion) => json(`${root}discussions/${discussion.questionId}.json`, discussion));
  release.learning.explanations.forEach((explanation) => json(`${root}learning/questions/${explanation.questionId}.json`, explanation));
  release.ledger.assets.forEach((asset) =>
    put(`${root}media/${asset.id}.${mediaExtension(asset.contentType)}`, release.assets.get(asset.id)!, asset.contentType));
  assert(files.length <= SC900_EXPORT_LIMITS.files &&
    files.reduce((total, file) => total + file.byteLength, 0) <= SC900_EXPORT_LIMITS.totalBytes,
  "SC900 static export exceeds the bounded file or byte budget");
  return sorted(files, (file) => file.path);
}

function fileInventory(files: Sc900ExportFile[]) {
  return files.map(({ bytes: _bytes, ...file }) => file);
}

function publicationProof(plan: Sc900StaticPlan) {
  return Sc900PublicationProofSchema.parse({
    schemaVersion: 1, examId: "sc900", expectedCapture: plan.release.expectedCapture,
    ledger: plan.release.ledger, review: plan.review,
  });
}

export function buildSc900StaticPlan(input: Sc900PublicationInput, reviewInput: Sc900PublicationReview): Sc900StaticPlan {
  const release = prepareSc900Release(input);
  const review = Sc900PublicationReviewSchema.parse(reviewInput);
  assert(review.releaseId === release.manifest.releaseId &&
    review.sourceRevision === release.manifest.sourceRevision &&
    review.captureLedgerDigest === release.manifest.captureLedgerDigest &&
    Date.parse(review.reviewedAt) >= Date.parse(release.ledger.capturedAt) &&
    same(sorted(review.questions, (item) => item.questionId), sc900ReviewTargets(release)),
  "Full SC900 review is missing, stale, or does not cover every exact question, answer, discussion, image and metadata record");
  const files = exportFiles(release);
  const reviewDigest = sc900Hash("full-review", review);
  const planDigest = sc900Hash("static-plan", {
    releaseId: release.manifest.releaseId, captureLedgerDigest: release.manifest.captureLedgerDigest,
    reviewDigest, files: fileInventory(files),
  });
  return {
    schemaVersion: 1, examId: "sc900", activate: false, release, review, reviewDigest, planDigest, files,
    totalBytes: files.reduce((total, file) => total + file.byteLength, 0),
  };
}

export function validateSc900StaticPlan(plan: Sc900StaticPlan): Sc900StaticPlan {
  const rebuilt = buildSc900StaticPlan({ ...plan.release, assets: plan.release.assets }, plan.review);
  assert(plan.schemaVersion === 1 && plan.examId === "sc900" && plan.activate === false &&
    plan.planDigest === rebuilt.planDigest && plan.reviewDigest === rebuilt.reviewDigest &&
    plan.totalBytes === rebuilt.totalBytes && same(fileInventory(plan.files), fileInventory(rebuilt.files)) &&
    plan.files.every((file) => byteSha256(file.bytes) === file.sha256 && file.bytes.byteLength === file.byteLength),
  "SC900 static plan or file bytes were modified after full review");
  return rebuilt;
}

export function createSc900ApprovalReceipt(planInput: Sc900StaticPlan, finalInput?: Sc900FinalReview): Sc900ApprovalReceipt {
  const plan = validateSc900StaticPlan(planInput);
  const finalReview = finalInput === undefined ? null : Sc900FinalReviewSchema.parse(finalInput);
  if (finalReview) {
    assert(finalReview.reviewer.toLowerCase() !== plan.review.reviewer.toLowerCase(),
      "The external final reviewer must be independent of the content reviewer");
    assert(Date.parse(finalReview.reviewedAt) >= Date.parse(plan.review.reviewedAt),
      "SC900 final approval cannot predate the full content review");
  }
  return Sc900ApprovalReceiptSchema.parse({
    schemaVersion: 1, examId: "sc900", bankVersion: SC900_BANK_VERSION,
    releaseId: plan.release.manifest.releaseId, sourceRevision: plan.release.manifest.sourceRevision,
    captureLedgerDigest: plan.release.manifest.captureLedgerDigest,
    planDigest: plan.planDigest, reviewDigest: plan.reviewDigest, fileCount: plan.files.length,
    totalBytes: plan.totalBytes, activate: finalReview !== null, finalReview,
  });
}

async function safeDirectory(workspace: string, path: string, create: boolean): Promise<void> {
  const local = relative(workspace, path);
  assert(local !== "" && !local.startsWith(`..${sep}`) && local !== "..", "SC900 staging must remain inside the workspace");
  let cursor = workspace;
  for (const part of local.split(sep)) {
    cursor = resolve(cursor, part);
    let stat;
    try { stat = await lstat(cursor); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) throw error;
      try { await mkdir(cursor); } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
      }
      stat = await lstat(cursor);
    }
    assert(stat.isDirectory() && !stat.isSymbolicLink(), "SC900 staging refuses symlink or non-directory parents");
  }
}

async function regularFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    const stat = await lstat(directory);
    assert(stat.isDirectory() && !stat.isSymbolicLink(), "SC900 stage contains a symlink or invalid directory");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      const child = await lstat(path);
      assert(!child.isSymbolicLink(), "SC900 stage refuses symlinks");
      if (child.isDirectory()) await visit(path);
      else {
        assert(child.isFile() && child.nlink === 1, "SC900 stage refuses nonregular or hard-linked files");
        files.push(relative(root, path).split(sep).join("/"));
      }
      assert(files.length <= SC900_EXPORT_LIMITS.files + 3, "SC900 stage contains too many files");
    }
  }
  await visit(root);
  return files.sort();
}

export async function validateSc900StagedExport(
  directory: string, planInput: Sc900StaticPlan, receiptInput: Sc900ApprovalReceipt,
): Promise<void> {
  const plan = validateSc900StaticPlan(planInput);
  const receipt = Sc900ApprovalReceiptSchema.parse(receiptInput);
  assert(same(receipt, createSc900ApprovalReceipt(plan, receipt.finalReview ?? undefined)), "SC900 receipt does not approve this plan");
  const files = await regularFiles(directory);
  assert(sameIds(files, [...plan.files.map((file) => file.path), "approval-receipt.json", "inventory.json", "publication-proof.json"]),
    "SC900 staged export contains missing or unapproved files");
  for (const file of plan.files) {
    const path = resolve(directory, file.path);
    assert((await lstat(path)).size === file.byteLength, "SC900 staged file length changed");
    assert(byteSha256(await readFile(path)) === file.sha256, "SC900 staged file hash changed");
  }
  for (const [name, expected] of [
    ["approval-receipt.json", receipt], ["inventory.json", fileInventory(plan.files)],
    ["publication-proof.json", publicationProof(plan)],
  ] as const) {
    const path = resolve(directory, name);
    assert((await lstat(path)).size === jsonBytes(expected).byteLength &&
      byteSha256(await readFile(path)) === byteSha256(jsonBytes(expected)), "SC900 stage receipt or inventory changed");
  }
}

/** Writes only under ignored .data. It never replaces a live manifest or calls Firebase. */
export async function stageSc900Publication(
  planInput: Sc900StaticPlan,
  options: { workspaceRoot?: string; finalReview?: Sc900FinalReview } = {},
): Promise<{ directory: string; receipt: Sc900ApprovalReceipt }> {
  const plan = validateSc900StaticPlan(planInput);
  const receipt = createSc900ApprovalReceipt(plan, options.finalReview);
  const proofBytes = jsonBytes(publicationProof(plan));
  const inventoryBytes = jsonBytes(fileInventory(plan.files));
  const receiptBytes = jsonBytes(receipt);
  assert(proofBytes.byteLength <= SC900_EXPORT_LIMITS.proofBytes, "SC900 private publication proof exceeds its safety limit");
  const workspace = await realpath(resolve(options.workspaceRoot ?? process.cwd()));
  const disk = await statfs(workspace);
  assert(disk.bavail * disk.bsize - plan.totalBytes - proofBytes.byteLength - inventoryBytes.byteLength -
    receiptBytes.byteLength >= SC900_EXPORT_LIMITS.minimumFreeBytes,
    "SC900 staging stopped: less than 2.5 GiB free after the planned export");
  const parent = resolve(workspace, ".data/sc900-publication");
  await safeDirectory(workspace, parent, true);
  const directory = resolve(parent, plan.release.manifest.releaseId);
  try {
    await lstat(directory);
    await validateSc900StagedExport(directory, plan, receipt);
    return { directory, receipt };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      await lstat(directory);
      throw new Error("An incomplete immutable SC900 stage already exists; refusing replacement");
    } catch (missing) {
      if ((missing as NodeJS.ErrnoException).code !== "ENOENT") throw missing;
    }
  }
  const pending = resolve(parent, `.stage-${plan.release.manifest.releaseId}-${randomUUID()}`);
  await mkdir(pending);
  try {
    for (const file of plan.files) {
      const path = resolve(pending, file.path);
      await safeDirectory(workspace, dirname(path), true);
      await writeFile(path, file.bytes, { flag: "wx", mode: 0o600 });
    }
    await writeFile(resolve(pending, "inventory.json"), inventoryBytes, { flag: "wx", mode: 0o600 });
    await writeFile(resolve(pending, "approval-receipt.json"), receiptBytes, { flag: "wx", mode: 0o600 });
    await writeFile(resolve(pending, "publication-proof.json"), proofBytes, { flag: "wx", mode: 0o600 });
    await validateSc900StagedExport(pending, plan, receipt);
    try { await rename(pending, directory); }
    catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      await validateSc900StagedExport(directory, plan, receipt);
    }
    await validateSc900StagedExport(directory, plan, receipt);
    return { directory, receipt };
  } finally {
    await rm(pending, { recursive: true, force: true });
  }
}

/** Persist a later independent approval separately without changing an immutable staged release. */
export async function writeSc900FinalApproval(
  planInput: Sc900StaticPlan, finalReview: Sc900FinalReview, workspaceRoot = process.cwd(),
): Promise<{ path: string; receipt: Sc900ApprovalReceipt }> {
  const plan = validateSc900StaticPlan(planInput);
  const receipt = createSc900ApprovalReceipt(plan, finalReview);
  const workspace = await realpath(resolve(workspaceRoot));
  const parent = resolve(workspace, ".data/sc900-publication");
  await safeDirectory(workspace, parent, false);
  const stage = resolve(parent, plan.release.manifest.releaseId);
  const storedReceiptPath = resolve(stage, "approval-receipt.json");
  const storedReceiptStat = await lstat(storedReceiptPath);
  assert(storedReceiptStat.isFile() && !storedReceiptStat.isSymbolicLink() && storedReceiptStat.nlink === 1 &&
    storedReceiptStat.size <= SC900_EXPORT_LIMITS.jsonBytes, "Invalid immutable SC900 stage receipt");
  const storedReceipt = Sc900ApprovalReceiptSchema.parse(JSON.parse(await readFile(storedReceiptPath, "utf8")));
  await validateSc900StagedExport(stage, plan, storedReceipt);
  const directory = resolve(parent, "approvals", plan.release.manifest.releaseId);
  await safeDirectory(workspace, directory, true);
  const path = resolve(directory, `${plan.planDigest}-${sc900Hash("activation-receipt", receipt)}.json`);
  const bytes = jsonBytes(receipt);
  try { await writeFile(path, bytes, { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const stat = await lstat(path);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size === bytes.byteLength &&
      byteSha256(await readFile(path)) === byteSha256(bytes), "Conflicting immutable SC900 activation approval");
  }
  return { path, receipt };
}

async function readBoundedPrivateFile(workspace: string, path: string, maximum: number): Promise<Buffer> {
  await safeDirectory(workspace, dirname(path), false);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    assert(stat.isFile() && stat.nlink === 1 && stat.size > 0 && stat.size <= maximum,
      "SC900 publication source must be a bounded regular file without hard links");
    const bytes = await handle.readFile();
    assert(bytes.byteLength === stat.size && bytes.byteLength <= maximum, "SC900 publication file changed during reading");
    return bytes;
  } finally {
    await handle.close();
  }
}

/** Load only an explicitly selected independent bank approval, never the newest or merely staged release. */
export async function loadSc900Publication(
  workspaceRoot = process.cwd(), options: { approvalPath?: string } = {},
): Promise<Sc900Publication> {
  const workspace = await realpath(resolve(workspaceRoot));
  const approvalPath = options.approvalPath ?? ".data/sc900-publication/current-approval.json";
  assert(approvalPath.startsWith(".data/sc900-publication/") &&
    /^[a-zA-Z0-9_./-]+\.json$/.test(approvalPath) &&
    approvalPath.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
  "SC900 approval selection must be a safe path inside ignored local publication data");
  const readJson = async (path: string, maximum = SC900_EXPORT_LIMITS.proofBytes) =>
    JSON.parse((await readBoundedPrivateFile(workspace, path, maximum)).toString("utf8")) as unknown;
  const receipt = Sc900ApprovalReceiptSchema.parse(await readJson(resolve(workspace, approvalPath), SC900_EXPORT_LIMITS.jsonBytes));
  assert(receipt.activate && receipt.finalReview !== null, "SC900 publication requires an explicitly selected independent final approval");
  const stage = resolve(workspace, ".data/sc900-publication", receipt.releaseId);
  await safeDirectory(workspace, stage, false);
  const inventory = Sc900InventorySchema.parse(await readJson(resolve(stage, "inventory.json")));
  assert(inventory.every((file) => isSc900ExportPath(file.path, receipt.releaseId)) &&
    receipt.fileCount === inventory.length &&
    receipt.totalBytes === inventory.reduce((total, file) => total + file.byteLength, 0) &&
    receipt.totalBytes <= SC900_EXPORT_LIMITS.totalBytes &&
    receipt.planDigest === sc900Hash("static-plan", {
      releaseId: receipt.releaseId, captureLedgerDigest: receipt.captureLedgerDigest,
      reviewDigest: receipt.reviewDigest, files: inventory,
    }), "SC900 selected approval does not bind this exact static inventory");
  const proof = Sc900PublicationProofSchema.parse(await readJson(resolve(stage, "publication-proof.json")));
  assert(sc900Hash("full-review", proof.review) === receipt.reviewDigest &&
    sc900Hash("capture-ledger", proof.ledger) === receipt.captureLedgerDigest &&
    sc900SourceRevision(proof.ledger) === receipt.sourceRevision,
  "SC900 source capture or full review proof differs from the selected approval");
  const bytesByPath = new Map<string, Buffer>();
  for (const file of inventory) {
    const bytes = await readBoundedPrivateFile(workspace, resolve(stage, file.path),
      file.contentType === "application/json" ? SC900_EXPORT_LIMITS.jsonBytes : SC900_EXPORT_LIMITS.assetBytes);
    assert(bytes.length === file.byteLength && byteSha256(bytes) === file.sha256,
      "SC900 approved static file hash or length differs from its inventory");
    bytesByPath.set(file.path, bytes);
  }
  const json = (path: string): unknown => {
    const bytes = bytesByPath.get(path);
    assert(bytes && inventory.find((file) => file.path === path)?.contentType === "application/json",
      `Missing approved SC900 JSON file: ${path}`);
    return JSON.parse(bytes.toString("utf8")) as unknown;
  };
  const manifest = Sc900ManifestSchema.parse(json(`${SC900_STATIC_BASE}manifest.json`));
  assert(manifest.releaseId === receipt.releaseId, "SC900 selected manifest belongs to another release");
  const root = `${SC900_STATIC_BASE}content/${receipt.releaseId}/`;
  const catalog = Sc900CatalogSchema.parse(json(`${root}catalog.json`));
  const documents = catalog.questions.map((question) =>
    Sc900DocumentSchema.parse(json(`${root}questions/${question.id}.json`)));
  const discussions = catalog.questions.map((question) =>
    Sc900DiscussionSchema.parse(json(`${root}discussions/${question.id}.json`)));
  const learning = Sc900LearningManifestSchema.parse(json(`${root}learning/manifest.json`));
  const dataset = Sc900LearningDatasetSchema.parse({
    schemaVersion: 1, examId: "sc900", bankVersion: SC900_BANK_VERSION,
    releaseId: learning.releaseId, baseReleaseId: learning.baseReleaseId, sourceRevision: learning.sourceRevision,
    explanations: Object.keys(learning.records).map((id) => json(`${root}learning/questions/${id}.json`)),
  });
  const plan = buildSc900StaticPlan({
    expectedCapture: proof.expectedCapture, ledger: proof.ledger, documents, discussions, learning: dataset,
    topics: Sc900TopicMapSchema.parse(json(`${root}topics.json`)),
    eligibility: Sc900EligibilityPolicySchema.parse(json(`${root}eligibility.json`)),
    assets: new Map(proof.ledger.assets.map((asset) => {
      const bytes = bytesByPath.get(`${root}media/${asset.id}.${mediaExtension(asset.contentType)}`);
      assert(bytes, "Missing approved SC900 image bytes");
      return [asset.id, bytes];
    })),
  }, proof.review);
  assert(same(receipt, createSc900ApprovalReceipt(plan, receipt.finalReview)), "SC900 final approval does not match the reconstructed publication");
  const stagedReceipt = Sc900ApprovalReceiptSchema.parse(await readJson(resolve(stage, "approval-receipt.json"), SC900_EXPORT_LIMITS.jsonBytes));
  await validateSc900StagedExport(stage, plan, stagedReceipt);
  return {
    source: { directory: stage }, expectedCapture: plan.release.expectedCapture,
    manifest: plan.release.manifest, catalog: plan.release.catalog,
    documents: plan.release.documents, discussions: plan.release.discussions,
    topics: plan.release.topics, learning: plan.release.learningManifest,
    explanations: new Map(plan.release.learning.explanations.map((item) => [item.questionId, item])),
    eligibility: plan.release.eligibility,
    releases: [{ catalog: plan.release.catalog, documents: plan.release.documents, discussions: plan.release.discussions }],
    files: new Map(plan.files.map((file) => [file.path, { kind: "source" as const, path: resolve(stage, file.path) }])),
    receipt, inventory,
  };
}

/** A quota estimate, not upload operations. Rich-content encoding and cloud preflight remain external gates. */
export function sc900CloudRequirements(planInput: Sc900StaticPlan) {
  const plan = validateSc900StaticPlan(planInput);
  const documents = plan.files.filter((file) => file.contentType === "application/json").length +
    plan.release.manifest.counts.comments + Object.keys(SC900_METADATA_PATHS).length;
  return {
    examId: "sc900" as const, activate: false as const,
    root: sc900FirestoreRoot(plan.release.manifest.releaseId), metadata: SC900_METADATA_PATHS,
    counts: { reads: documents * 2, writes: documents, deletes: 0 },
    storage: { objects: plan.release.assets.size,
      bytes: [...plan.release.assets.values()].reduce((total, bytes) => total + bytes.byteLength, 0) },
    executable: false as const,
    blockers: ["No cloud executor is provided", "Firestore encoding and cloud controls require separate verification",
      "Storage service quotas require separate verification", "Independent external final approval is required"],
  };
}

/** Reserves the existing shared quota journals locally. Never contacts any cloud service. */
export async function reserveSc900CloudHeadroom(
  planInput: Sc900StaticPlan, receiptInput: Sc900ApprovalReceipt, usage: FirestoreUsage, workspace = process.cwd(),
): Promise<void> {
  const plan = validateSc900StaticPlan(planInput);
  const receipt = Sc900ApprovalReceiptSchema.parse(receiptInput);
  assert(receipt.activate && same(receipt, createSc900ApprovalReceipt(plan, receipt.finalReview ?? undefined)),
    "Cloud quota reservation requires an independent exact-hash activation approval");
  assert(usage.pacificDay === pacificQuotaDay(new Date()) && Number.isFinite(Date.parse(usage.checkedAt)) &&
    Date.parse(usage.checkedAt) <= Date.now() && Date.now() - Date.parse(usage.checkedAt) <= 5 * 60_000,
  "Fresh current Pacific-day usage is required before reserving SC900 quota");
  const unlock = await acquireUploadLock(workspace);
  try {
    const reads = await OperationBudget.open("reads", usage.reads, workspace);
    const writes = await writeBudgetForUsage(usage, workspace);
    const counts = sc900CloudRequirements(plan).counts;
    assertPlannedHeadroom(counts, { reads: reads.remaining(), writes: writes.remaining(), deletes: 0 });
    await reads.reserve(counts.reads);
    assert(await writes.reserve(counts.writes), "SC900 write quota changed before reservation");
  } finally {
    await unlock();
  }
}
