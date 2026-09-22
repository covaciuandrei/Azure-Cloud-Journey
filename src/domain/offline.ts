import { z } from "zod";
import { CleanReleaseIdSchema } from "./cleanBank.js";
import { MAX_COURSE_BYTES } from "./courseCatalog.js";
import { ExamIdSchema, type ExamId } from "./exams.js";

export const OFFLINE_PROTOCOL = "az104-offline-v1";
export const OFFLINE_MANIFEST_URL = "/data/offline-manifest.json";
export const OFFLINE_MANIFEST_MAX_BYTES = 4 * 1024 * 1024;
export const OFFLINE_AVAILABILITY_MAX_BYTES = 8_000;
export const OFFLINE_COURSE_MAX_BYTES = MAX_COURSE_BYTES;
const courseUrl = /^\/courses\/c_[a-f0-9]{64}\/(?:networking|az104)\.json$/;
const sc900CourseUrl = /^\/exams\/sc900\/course\/releases\/c_[a-f0-9]{64}\/sc900\.json$/;
export function offlineManifestUrl(examId: ExamId = "az104"): string {
  ExamIdSchema.parse(examId);
  return examId === "sc900" ? "/exams/sc900/offline-manifest.json" : OFFLINE_MANIFEST_URL;
}

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const questionId = z.string().regex(/^q_[a-f0-9]{64}$/);
function fileSchema(examId: ExamId) {
  const root = examId === "sc900" ? "/exams/sc900" : "";
  return z.object({
  url: z.string(),
  sha256: sha,
  bytes: z.number().int().positive().max(16 * 1024 * 1024),
  kind: z.enum(["shell", "data", "image"]),
  releaseId: CleanReleaseIdSchema.optional(),
  questionId: questionId.optional(),
  questionIds: z.array(questionId).min(1).max(606).optional(),
  part: z.enum(["catalog", "question", "discussion", "explanation", "topics", "eligibility", "learning-manifest"]).optional(),
  commentCount: z.number().int().positive().optional(),
}).strict().superRefine((file, context) => {
  let expected: string | undefined;
  if (file.url === "/exams/sc900/availability.json" && file.bytes > OFFLINE_AVAILABILITY_MAX_BYTES) {
    context.addIssue({ code: "custom", message: "SC-900 availability exceeds the 8,000 byte offline limit." });
  }
  if ((courseUrl.test(file.url) || sc900CourseUrl.test(file.url) ||
      (file.kind === "data" && (!file.releaseId || file.part === "learning-manifest"))) &&
      file.bytes > OFFLINE_COURSE_MAX_BYTES) {
    context.addIssue({ code: "custom", message: "Course or manifest content exceeds the 4 MiB offline limit." });
  }
  if (!file.url.startsWith("/") || /[\\%?#]/.test(file.url) || file.url.includes("..") || file.url.startsWith("//")) {
    context.addIssue({ code: "custom", message: "Offline file path is unsafe." });
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
        new RegExp(`^${root}/content/${file.releaseId}/media/${file.sha256}\\.(png|jpg|gif|webp)$`).test(file.url)) expected = file.url;
  } else if (!file.releaseId) {
    if (!file.part && !file.questionId && !file.commentCount &&
        (examId === "az104"
          ? ["/data/manifest.json", "/data/topics.json", "/data/learning.json", "/data/eligibility.json", "/data/course.json"].includes(file.url) ||
            courseUrl.test(file.url)
          : ["/exams/sc900/manifest.json", "/exams/sc900/availability.json", "/exams/sc900/course/current.json"].includes(file.url) ||
            sc900CourseUrl.test(file.url))) expected = file.url;
  } else if (file.part === "catalog" && !file.questionId && !file.commentCount) {
    expected = `${root}/content/${file.releaseId}/catalog.json`;
  } else if (examId === "sc900" && !file.questionId && !file.commentCount &&
      (file.part === "topics" || file.part === "eligibility" || file.part === "learning-manifest")) {
    expected = `${root}/content/${file.releaseId}/${file.part === "learning-manifest" ? "learning/manifest" : file.part}.json`;
  } else if (file.questionId && file.part === "question" && !file.commentCount) {
    expected = `${root}/content/${file.releaseId}/questions/${file.questionId}.json`;
  } else if (file.questionId && file.part === "discussion" && file.commentCount) {
    expected = `${root}/content/${file.releaseId}/discussions/${file.questionId}.json`;
  } else if (file.questionId && file.part === "explanation" && !file.commentCount) {
    expected = examId === "sc900"
      ? `${root}/content/${file.releaseId}/learning/questions/${file.questionId}.json`
      : `/teaching/${file.releaseId}/questions/${file.questionId}.json`;
  }
  if (!expected || file.url !== expected) context.addIssue({ code: "custom", message: "File is outside the offline allowlist." });
});
}

export const OfflineFileSchema = fileSchema("az104");
export const Sc900OfflineFileSchema = fileSchema("sc900");

function manifestSchema<E extends ExamId>(examId: E) {
  return z.object({
  schemaVersion: z.literal(1),
  examId: examId === "az104" ? z.literal(examId).optional() : z.literal(examId),
  buildId: sha,
  releaseId: CleanReleaseIdSchema,
  learningReleaseId: CleanReleaseIdSchema.optional(),
  counts: z.object({
    questions: z.number().int().min(1).max(604),
    comments: z.number().int().min(0).max(7994),
    images: z.number().int().min(examId === "az104" ? 1 : 0).max(784),
  }).strict(),
  files: z.array(fileSchema(examId)).min(1).max(10000),
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
      files.filter((file) => file.url === (examId === "az104" ? "/data/manifest.json" : "/exams/sc900/manifest.json")).length !== 1 ||
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
  if (examId === "sc900" &&
      (files.filter((file) => file.url === "/exams/sc900/availability.json").length !== 1 ||
       files.filter((file) => file.url === "/exams/sc900/course/current.json").length !== 1 ||
       files.filter((file) => sc900CourseUrl.test(file.url)).length !== 1)) {
    context.addIssue({ code: "custom", message: "SC-900 offline packages require availability and the exact course publication." });
  }
});
}
export const Az104OfflineManifestSchema = manifestSchema("az104");
export const Sc900OfflineManifestSchema = manifestSchema("sc900");
export const OfflineManifestSchema = z.union([Az104OfflineManifestSchema, Sc900OfflineManifestSchema]);

export function parseOfflineManifest(value: unknown, examId: ExamId = "az104"): OfflineManifest {
  ExamIdSchema.parse(examId);
  return examId === "sc900" ? Sc900OfflineManifestSchema.parse(value) : Az104OfflineManifestSchema.parse(value);
}

export async function readOfflineManifest(response: Response, examId: ExamId = "az104"): Promise<OfflineManifest> {
  if (!response.ok) throw new Error("This exam does not provide an approved offline download.");
  if (!response.body) throw new Error("The offline manifest is empty.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > OFFLINE_MANIFEST_MAX_BYTES) {
        void reader.cancel().catch(() => {});
        throw new Error("Offline manifest exceeds the 4 MiB size limit.");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return parseOfflineManifest(JSON.parse(new TextDecoder().decode(bytes)), examId);
}

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
      (selected.has(file.releaseId) && (["catalog", "topics", "eligibility", "learning-manifest"].includes(file.part ?? "") ||
        selected.get(file.releaseId)!.has(file.questionId!)));
  });
}
