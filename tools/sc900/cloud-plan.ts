import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { Sc900CloudEnvelopeSchema } from "../../src/domain/sc900Cloud.js";
import { Sc900CatalogSchema, Sc900CommentSchema, Sc900DocumentSchema, Sc900ReleasePointerSchema } from "../../src/domain/sc900Bank.js";
import { Sc900LearningExplanationSchema, Sc900LearningManifestSchema } from "../../src/domain/sc900Learning.js";
import { Sc900TopicMapSchema } from "../../src/domain/sc900Topics.js";
import { Sc900DiscussionScopeSchema } from "../../src/domain/sc900Scope.js";
import { Sc900PageNumberSchema, Sc900SourceNumberSchema, sc900SourcePageUrl } from "../../src/domain/sc900Capture.js";
import { Sha256Schema, TimestampSchema } from "../../src/domain/schemas.js";
import { assertNoCredentialUrls } from "../../src/domain/publicUrls.js";
import { crc32c } from "../publish/storage-clean.js";
import { uploadPlanInternals } from "../publish/plan.js";
import { assertSafeDirectory, childPath } from "../web/bank.js";
import { byteSha256, canonicalJson, sc900Hash } from "./canonical.js";
import { loadSc900Publication } from "./publication.js";

export const CLOUD_PROJECT = "study-az104";
export const CLOUD_BUCKET = "study-az104.firebasestorage.app";
export const EMULATOR_PROJECT = "demo-az104-study";
export const EMULATOR_BUCKET = "demo-az104-study.appspot.com";
export const METADATA_PATHS = ["studyMetadata/sc900Bank", "studyMetadata/sc900Topics", "studyMetadata/sc900Learning"] as const;
export const MAX_CLOUD_PLAN_BYTES = 64 * 1024 * 1024;
export const SourceScopeReceiptSchema = z.object({
  checkedAt: TimestampSchema, examId: z.literal(128), url: z.string(), title: z.string(),
  headings: z.array(z.string().trim().regex(/^Question [1-9]\d{0,5}$/)).min(1).max(5),
  nextVisible: z.literal(0), lastVisible: z.literal(0),
  sourceMethod: z.literal("Last paginator button inspected solely to establish source scope; no answers or discussions requested."),
  observedSourceQuestionCount: Sc900SourceNumberSchema, observedPageCount: Sc900PageNumberSchema,
  discussionRequests: z.literal(0),
}).strict().refine((value) => value.observedPageCount === Math.ceil(value.observedSourceQuestionCount / 5) &&
  value.url === sc900SourcePageUrl(value.observedPageCount) &&
  value.title === `Microsoft - SC-900 - Page ${value.observedPageCount} | Examprepper` &&
  canonicalJson(value.headings.map((heading) => Number(heading.slice(9)))) === canonicalJson(Array.from({
    length: value.observedSourceQuestionCount - (value.observedPageCount - 1) * 5,
  }, (_, index) => (value.observedPageCount - 1) * 5 + index + 1)),
"Source scope must bind the observed last page, complete final question sequence and terminal navigation");

const safeLocalPath = z.string().refine((path) => path.startsWith(".data/") &&
  /^[a-zA-Z0-9_./-]+$/.test(path) && path.split("/").every((part) => part && part !== "." && part !== ".."),
"Cloud inputs must be explicit safe paths under ignored .data");
const SnapshotSchema = z.object({ sha256: Sha256Schema, updateTime: TimestampSchema }).strict().nullable();
const MetadataPathSchema = z.enum(METADATA_PATHS);
export const CloudCurrentReceiptSchema = z.object({
  schemaVersion: z.literal(1), examId: z.literal("sc900"), target: z.enum(["production", "emulator"]),
  planDigest: Sha256Schema, releaseId: z.string().regex(/^r_[a-f0-9]{64}$/),
  records: z.array(z.object({ path: MetadataPathSchema, snapshot: SnapshotSchema }).strict()).length(3),
}).strict();
const DocumentSchema = z.object({
  path: z.string(), sha256: Sha256Schema, data: z.record(z.string(), z.unknown()),
}).strict();
const ObjectSchema = z.object({
  name: z.string().regex(/^published\/sc900\/r_[a-f0-9]{64}\/assets\/[a-f0-9]{64}\.(png|jpg|gif|webp)$/),
  source: safeLocalPath, sha256: Sha256Schema, md5Hash: z.string(), crc32c: z.string(),
  byteLength: z.number().int().positive().max(8 * 1024 * 1024),
  contentType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
}).strict();
export const Sc900CloudPlanSchema = z.object({
  schemaVersion: z.literal(1), examId: z.literal("sc900"), target: z.enum(["production", "emulator"]),
  dataKind: z.enum(["authorized-source", "synthetic-test"]),
  projectId: z.enum([CLOUD_PROJECT, EMULATOR_PROJECT]), bucket: z.enum([CLOUD_BUCKET, EMULATOR_BUCKET]),
  releaseId: z.string().regex(/^r_[a-f0-9]{64}$/), staticPlanDigest: Sha256Schema,
  bankApprovalSha256: Sha256Schema,
  bankApprovedAt: TimestampSchema,
  discussionScope: Sc900DiscussionScopeSchema.optional(),
  sourceScopeSha256: Sha256Schema, approvalPath: safeLocalPath, sourceScopePath: safeLocalPath,
  baseline: z.array(z.object({ path: MetadataPathSchema, snapshot: SnapshotSchema }).strict()).length(3),
  documents: z.array(DocumentSchema).min(1).max(20_000),
  objects: z.array(ObjectSchema).max(10_000),
  metadata: z.array(DocumentSchema).length(3), planDigest: Sha256Schema,
}).strict();
export type Sc900CloudPlan = z.infer<typeof Sc900CloudPlanSchema>;
export type CloudDocument = z.infer<typeof DocumentSchema>;
export type CloudObject = z.infer<typeof ObjectSchema>;
export type CloudSnapshot = z.infer<typeof SnapshotSchema>;
export const CloudApplyApprovalSchema = z.object({
  schemaVersion: z.literal(1), examId: z.literal("sc900"), target: z.enum(["production", "emulator"]),
  dataKind: z.enum(["authorized-source", "synthetic-test"]),
  planDigest: Sha256Schema, staticPlanDigest: Sha256Schema, sourceScopeSha256: Sha256Schema,
  discussionScope: Sc900DiscussionScopeSchema.optional(),
  reviewer: z.string().trim().min(1).max(200), reviewedAt: TimestampSchema,
  decision: z.literal("approve-cloud-upload-and-metadata-switch"),
}).strict();
export type CloudApplyApproval = z.infer<typeof CloudApplyApprovalSchema>;

export async function readCloudFile(workspace: string, path: string, maximum = MAX_CLOUD_PLAN_BYTES) {
  safeLocalPath.parse(path);
  await assertSafeDirectory(workspace, dirname(path));
  const file = await open(childPath(workspace, path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximum || stat.size < 1) throw new Error("Unsafe or oversized cloud input.");
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length !== stat.size) throw new Error("Cloud input changed during reading.");
    return bytes.subarray(0, length);
  } finally { await file.close(); }
}

function document(path: string, data: Record<string, unknown>): CloudDocument {
  uploadPlanInternals.documentOperation("stage", path, data);
  return { path, data, sha256: byteSha256(canonicalJson(data)) };
}
function envelope(value: unknown, questionId?: string) {
  const payload = canonicalJson(value);
  return Sc900CloudEnvelopeSchema.parse({
    schemaVersion: 1, examId: "sc900", encoding: "sc900-json-v1",
    payload, sha256: byteSha256(payload), ...(questionId ? { questionId } : {}),
  });
}

export async function buildSc900CloudPlan(workspace: string, options: {
  target: Sc900CloudPlan["target"]; approvalPath: string; sourceScopePath: string;
  baseline?: Sc900CloudPlan["baseline"];
}): Promise<Sc900CloudPlan> {
  const bankApprovalSha256 = byteSha256(await readCloudFile(workspace, options.approvalPath, 800_000));
  const publication = await loadSc900Publication(workspace, { approvalPath: options.approvalPath });
  const sourceBytes = await readCloudFile(workspace, options.sourceScopePath, 64 * 1024);
  const source = SourceScopeReceiptSchema.parse(JSON.parse(sourceBytes.toString("utf8")));
  const sourceScopeSha256 = byteSha256(sourceBytes);
  if (sourceScopeSha256 !== publication.expectedCapture.receiptSha256 ||
      source.observedSourceQuestionCount !== publication.expectedCapture.questions || source.observedPageCount !== publication.expectedCapture.pages ||
      Date.parse(source.checkedAt) > Date.parse(publication.receipt.finalReview!.reviewedAt)) {
    throw new Error("The actual source-scope receipt does not match the independently approved bank.");
  }
  const dataKind = options.target === "production" ? "authorized-source" as const : "synthetic-test" as const;
  const synthetic = /original.synthetic|synthetic.fixture|synthetic source question|synthetic security concept|synthetic integration fixture|original-synthetic-demo|"fixtureOnly":true/i
    .test(canonicalJson([publication.documents, publication.discussions, [...publication.explanations.values()], publication.receipt]));
  if (options.target === "production" && synthetic) {
    throw new Error("Synthetic fixtures cannot be uploaded to the production Firebase project.");
  }
  if (options.target === "emulator" && !synthetic) throw new Error("Emulator upload requires explicitly marked synthetic test fixtures.");
  const releaseId = publication.manifest.releaseId;
  const root = `studyBanks/sc900/releases/${releaseId}`;
  const documents: CloudDocument[] = [document(`${root}/catalogs/sc900`, envelope(publication.catalog))];
  for (const value of publication.documents) documents.push(document(`${root}/questions/${value.question.id}`, envelope(value)));
  for (const value of publication.explanations.values()) documents.push(document(`${root}/explanations/${value.questionId}`, envelope(value)));
  for (const discussion of publication.discussions) for (const value of discussion.comments) {
    documents.push(document(`${root}/comments/${value.id}`, envelope(value, value.questionId)));
  }
  documents.sort((a, b) => a.path.localeCompare(b.path));
  const objects: CloudObject[] = [];
  for (const [path, file] of publication.files) {
    const media = /\/media\/([a-f0-9]{64})\.(png|jpg|gif|webp)$/.exec(path);
    if (!media) continue;
    if (file.kind !== "source") throw new Error("SC900 cloud assets require verified original binary files.");
    const source = relative(resolve(workspace), file.path).split(sep).join("/");
    const bytes = await readCloudFile(workspace, source, 8 * 1024 * 1024);
    if (byteSha256(bytes) !== media[1]) throw new Error("SC900 cloud asset changed after static approval.");
    objects.push(ObjectSchema.parse({
      name: `published/sc900/${releaseId}/assets/${media[1]}.${media[2]}`, source, sha256: media[1],
      md5Hash: createHash("md5").update(bytes).digest("base64"), crc32c: crc32c(bytes),
      byteLength: bytes.length, contentType: `image/${media[2] === "jpg" ? "jpeg" : media[2]}`,
    }));
  }
  objects.sort((a, b) => a.name.localeCompare(b.name));
  const metadata = [
    document(METADATA_PATHS[0], Sc900ReleasePointerSchema.parse({
      schemaVersion: 1, examId: "sc900", bankVersion: publication.manifest.bankVersion,
      releaseId, sourceRevision: publication.manifest.sourceRevision,
      ...(publication.manifest.discussionScope ? { discussionScope: publication.manifest.discussionScope } : {}),
    })),
    document(METADATA_PATHS[1], publication.topics),
    document(METADATA_PATHS[2], publication.learning),
  ];
  const baseline = options.baseline ?? METADATA_PATHS.map((path) => ({ path, snapshot: null }));
  const content = {
    schemaVersion: 1 as const, examId: "sc900" as const, target: options.target, dataKind,
    projectId: options.target === "production" ? CLOUD_PROJECT : EMULATOR_PROJECT,
    bucket: options.target === "production" ? CLOUD_BUCKET : EMULATOR_BUCKET,
    releaseId, staticPlanDigest: publication.receipt.planDigest, bankApprovalSha256,
    bankApprovedAt: publication.receipt.finalReview!.reviewedAt, sourceScopeSha256,
    ...(publication.manifest.discussionScope ? { discussionScope: publication.manifest.discussionScope } : {}),
    approvalPath: options.approvalPath, sourceScopePath: options.sourceScopePath, baseline, documents, objects, metadata,
  };
  return validateSc900CloudPlan({ ...content, planDigest: sc900Hash("cloud-plan", content) });
}

export function validateSc900CloudPlan(raw: unknown): Sc900CloudPlan {
  const plan = Sc900CloudPlanSchema.parse(JSON.parse(canonicalJson(raw)));
  const { planDigest, ...content } = plan;
  const production = plan.target === "production";
  if (plan.projectId !== (production ? CLOUD_PROJECT : EMULATOR_PROJECT) ||
      plan.bucket !== (production ? CLOUD_BUCKET : EMULATOR_BUCKET) ||
      plan.dataKind !== (production ? "authorized-source" : "synthetic-test") ||
      planDigest !== sc900Hash("cloud-plan", content) ||
      new Set(plan.documents.map((item) => item.path)).size !== plan.documents.length ||
      new Set(plan.objects.map((item) => item.name)).size !== plan.objects.length ||
      !plan.metadata.every((item, index) => item.path === METADATA_PATHS[index]) ||
      !plan.baseline.every((item, index) => item.path === METADATA_PATHS[index]) ||
      ![0, 3].includes(plan.baseline.filter((item) => item.snapshot !== null).length)) {
    throw new Error("Invalid or tampered SC900 cloud plan, target or metadata boundary.");
  }
  const root = `studyBanks/sc900/releases/${plan.releaseId}/`;
  for (const item of plan.documents) {
    if (!item.path.startsWith(root) ||
        !/^(catalogs\/sc900|questions\/q_[a-f0-9]{64}|explanations\/q_[a-f0-9]{64}|comments\/c_[a-f0-9]{64})$/.test(item.path.slice(root.length))) {
      throw new Error("SC900 cloud plan contains a foreign document path.");
    }
    const envelope = Sc900CloudEnvelopeSchema.parse(item.data);
    if (byteSha256(envelope.payload) !== envelope.sha256) throw new Error("Cloud payload hash changed.");
    const payload: unknown = JSON.parse(envelope.payload);
    const leaf = item.path.slice(root.length);
    const id = leaf.split("/")[1];
    if (leaf.startsWith("catalogs/")) {
      const catalog = Sc900CatalogSchema.parse(payload);
      if (catalog.releaseId !== plan.releaseId ||
          canonicalJson(catalog.discussionScope ?? null) !== canonicalJson(plan.discussionScope ?? null)) {
        throw new Error("Foreign cloud catalog release or owner-authorized discussion scope.");
      }
    } else if (leaf.startsWith("questions/")) {
      const document = Sc900DocumentSchema.parse(payload);
      if (document.releaseId !== plan.releaseId || document.question.id !== id ||
          canonicalJson(document.question.discussionScope ?? null) !== canonicalJson(plan.discussionScope ?? null)) {
        throw new Error("Foreign cloud question identity or owner-authorized discussion scope.");
      }
    } else if (leaf.startsWith("explanations/")) {
      if (Sc900LearningExplanationSchema.parse(payload).questionId !== id) throw new Error("Foreign cloud explanation identity.");
    } else {
      if (plan.discussionScope) throw new Error("Questions-only cloud publication cannot upload source comments.");
      const comment = Sc900CommentSchema.parse(payload);
      if (comment.id !== id || envelope.questionId !== comment.questionId) throw new Error("Foreign cloud discussion identity.");
    }
  }
  for (const item of [...plan.documents, ...plan.metadata]) {
    uploadPlanInternals.documentOperation("stage", item.path, item.data);
    if (item.sha256 !== byteSha256(canonicalJson(item.data))) throw new Error("Cloud document hash changed.");
  }
  for (const item of plan.objects) {
    if (item.name !== `published/sc900/${plan.releaseId}/assets/${item.sha256}.${item.contentType === "image/jpeg" ? "jpg" : item.contentType.slice(6)}`) {
      throw new Error("Cloud media path differs from the approved immutable media reference.");
    }
  }
  const pointer = Sc900ReleasePointerSchema.parse(plan.metadata[0]!.data);
  const metadata = [pointer, Sc900TopicMapSchema.parse(plan.metadata[1]!.data), Sc900LearningManifestSchema.parse(plan.metadata[2]!.data)];
  if (metadata.some((item) => item.releaseId !== plan.releaseId || item.sourceRevision !== pointer.sourceRevision) ||
      canonicalJson(pointer.discussionScope ?? null) !== canonicalJson(plan.discussionScope ?? null)) {
    throw new Error("Cloud metadata is not one consistent SC900 release and authorized scope.");
  }
  assertNoCredentialUrls(plan);
  if (Buffer.byteLength(canonicalJson(plan)) > MAX_CLOUD_PLAN_BYTES) throw new Error("SC900 cloud plan exceeds its bounded size.");
  return plan;
}

export function validateCloudApplyApproval(raw: unknown, plan: Sc900CloudPlan): CloudApplyApproval {
  const approval = CloudApplyApprovalSchema.parse(raw);
  if (approval.target !== plan.target || approval.dataKind !== plan.dataKind || approval.planDigest !== plan.planDigest ||
      canonicalJson(approval.discussionScope ?? null) !== canonicalJson(plan.discussionScope ?? null) ||
      approval.staticPlanDigest !== plan.staticPlanDigest || approval.sourceScopeSha256 !== plan.sourceScopeSha256 ||
      Date.parse(approval.reviewedAt) > Date.now() || Date.parse(approval.reviewedAt) < Date.parse(plan.bankApprovedAt)) {
    throw new Error("Cloud apply approval does not bind this exact source, target and plan after bank approval.");
  }
  return approval;
}
