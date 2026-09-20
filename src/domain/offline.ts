import { z } from "zod";
import { CleanReleaseIdSchema } from "./cleanBank.js";
import { MAX_COURSE_BYTES } from "./courseCatalog.js";

export const OFFLINE_PROTOCOL = "az104-offline-v1";
export const OFFLINE_MANIFEST_URL = "/data/offline-manifest.json";
export const OFFLINE_COURSE_MAX_BYTES = MAX_COURSE_BYTES;
const courseUrl = /^\/courses\/c_[a-f0-9]{64}\/(?:networking|az104)\.json$/;
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const questionId = z.string().regex(/^q_[a-f0-9]{64}$/);
export const OfflineFileSchema = z.object({
  url: z.string(),
  sha256: sha,
  bytes: z.number().int().positive().max(16 * 1024 * 1024),
  kind: z.enum(["shell", "data", "image"]),
  releaseId: CleanReleaseIdSchema.optional(),
  questionId: questionId.optional(),
  questionIds: z.array(questionId).min(1).max(606).optional(),
  part: z.enum(["catalog", "question", "discussion", "explanation"]).optional(),
  commentCount: z.number().int().positive().optional(),
}).strict().superRefine((file, context) => {
  let expected: string | undefined;
  if (courseUrl.test(file.url) && file.bytes > OFFLINE_COURSE_MAX_BYTES) {
    context.addIssue({ code: "custom", message: "Course content exceeds the 4 MiB offline limit." });
  }
  if (file.questionIds && (file.kind !== "image" || new Set(file.questionIds).size !== file.questionIds.length)) {
    context.addIssue({ code: "custom", message: "Only images may declare unique question owners." });
  }
  if (file.kind === "shell") {
    if (["/index.html", "/favicon.svg", "/offline-worker.js"].includes(file.url) ||
        /^\/assets\/[a-zA-Z0-9_.-]+-[a-zA-Z0-9_-]+\.(js|css)$/.test(file.url)) expected = file.url;
    if (file.releaseId || file.questionId || file.part || file.commentCount) expected = undefined;
  } else if (file.kind === "image") {
    if (file.releaseId && !file.questionId && !file.part && !file.commentCount &&
        new RegExp(`^/content/${file.releaseId}/media/${file.sha256}\\.(png|jpg|gif|webp)$`).test(file.url)) expected = file.url;
  } else if (!file.releaseId) {
    if (!file.part && !file.questionId && !file.commentCount &&
        (["/data/manifest.json", "/data/topics.json", "/data/learning.json", "/data/eligibility.json", "/data/course.json"].includes(file.url) ||
          courseUrl.test(file.url))) expected = file.url;
  } else if (file.part === "catalog" && !file.questionId && !file.commentCount) {
    expected = `/content/${file.releaseId}/catalog.json`;
  } else if (file.questionId && file.part === "question" && !file.commentCount) {
    expected = `/content/${file.releaseId}/questions/${file.questionId}.json`;
  } else if (file.questionId && file.part === "discussion" && file.commentCount) {
    expected = `/content/${file.releaseId}/discussions/${file.questionId}.json`;
  } else if (file.questionId && file.part === "explanation" && !file.commentCount) {
    expected = `/teaching/${file.releaseId}/questions/${file.questionId}.json`;
  }
  if (!expected || file.url !== expected) context.addIssue({ code: "custom", message: "File is outside the offline allowlist." });
});

export const OfflineManifestSchema = z.object({
  schemaVersion: z.literal(1),
  buildId: sha,
  releaseId: CleanReleaseIdSchema,
  learningReleaseId: CleanReleaseIdSchema.optional(),
  counts: z.object({
    questions: z.number().int().min(1).max(604),
    comments: z.number().int().min(0).max(7994),
    images: z.number().int().min(1).max(784),
  }).strict(),
  files: z.array(OfflineFileSchema).min(1).max(10000),
}).strict().superRefine((manifest, context) => {
  const files = manifest.files;
  const current = files.filter((file) => file.releaseId === manifest.releaseId);
  const images = files.filter((file) => file.kind === "image");
  if (new Set(files.map((file) => file.url)).size !== files.length ||
      images.length !== manifest.counts.images || new Set(images.map((file) => file.sha256)).size !== manifest.counts.images ||
      images.some((file) => file.releaseId !== manifest.releaseId) ||
      current.filter((file) => file.part === "question").length !== manifest.counts.questions ||
      current.reduce((sum, file) => sum + (file.commentCount ?? 0), 0) !== manifest.counts.comments ||
      current.filter((file) => file.part === "catalog").length !== 1 ||
      !files.some((file) => file.url === "/index.html") ||
      !files.some((file) => file.kind === "shell" && file.url.endsWith(".js") && file.url.startsWith("/assets/")) ||
      files.filter((file) => file.url === "/data/manifest.json").length !== 1 ||
      files.reduce((sum, file) => sum + file.bytes, 0) > 256 * 1024 * 1024) {
    context.addIssue({ code: "custom", message: "Offline manifest coverage/counts are inconsistent." });
  }
  const questions = new Set(files.filter((file) => file.part === "question").map((file) => `${file.releaseId}/${file.questionId}`));
  const questionIds = new Set(files.filter((file) => file.part === "question").map((file) => file.questionId));
  if (files.some((file) => file.part === "discussion" && !questions.has(`${file.releaseId}/${file.questionId}`))) {
    context.addIssue({ code: "custom", message: "An offline discussion has no question." });
  }
  if (images.some((file) => file.questionIds?.some((id) => !questionIds.has(id)))) {
    context.addIssue({ code: "custom", message: "An offline image references an unknown question." });
  }
});

export const OfflineReferencesSchema = z.array(z.object({
  releaseId: CleanReleaseIdSchema, questionIds: z.array(questionId).max(606),
}).strict()).max(20);
export const OfflineStateSchema = z.object({
  status: z.enum(["empty", "downloading", "ready", "paused", "error"]),
  ready: z.boolean(),
  buildId: sha.nullable(),
  releaseId: CleanReleaseIdSchema.nullable(),
  totalFiles: z.number().int().nonnegative(),
  completedFiles: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  completedBytes: z.number().int().nonnegative(),
  downloadBytes: z.number().int().nonnegative(),
  error: z.string().nullable(),
  updatedAt: z.number().nullable(),
}).strict();
export type OfflineFile = z.infer<typeof OfflineFileSchema>;
export type OfflineManifest = z.infer<typeof OfflineManifestSchema>;
export type OfflineState = z.infer<typeof OfflineStateSchema>;
export type OfflineReferences = z.infer<typeof OfflineReferencesSchema>;

export function selectOfflineFiles(manifest: OfflineManifest, references: OfflineReferences = []): OfflineFile[] {
  OfflineReferencesSchema.parse(references);
  const selected = new Map<string, Set<string>>();
  const neededIds = new Set(manifest.files.filter((file) =>
    file.part === "question" && file.releaseId === manifest.releaseId).map((file) => file.questionId!));
  for (const reference of references) {
    const ids = selected.get(reference.releaseId) ?? new Set<string>();
    reference.questionIds.forEach((id) => { ids.add(id); neededIds.add(id); });
    selected.set(reference.releaseId, ids);
  }
  for (const [releaseId, ids] of selected) {
    if (!manifest.files.some((file) => file.releaseId === releaseId && file.part === "catalog")) {
      throw new Error("A saved session's snapshot is unavailable for download.");
    }
    for (const id of ids) {
      if (!manifest.files.some((file) => file.releaseId === releaseId && file.questionId === id && file.part === "question")) {
        throw new Error("A saved question is unavailable for download.");
      }
    }
  }
  return manifest.files.filter((file) => {
    if (file.kind === "image") return !file.questionIds || file.questionIds.some((id) => neededIds.has(id));
    if (file.part === "explanation" && manifest.learningReleaseId) {
      return file.releaseId === manifest.learningReleaseId && neededIds.has(file.questionId!);
    }
    return file.kind === "shell" || !file.releaseId || file.releaseId === manifest.releaseId ||
      (selected.has(file.releaseId) && (file.part === "catalog" || selected.get(file.releaseId)!.has(file.questionId!)));
  });
}
