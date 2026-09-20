import { z } from "zod";
import {
  AnswerValueSchema, CommentSchema, OccurrenceIdSchema, OptionIdSchema,
  QuestionIdSchema, RichContentSchema, SafeUrlSchema, Sha256Schema,
} from "./schemas.js";

export const CLEAN_BANK_VERSION = "approved-7994-v1" as const;
export const CleanReleaseIdSchema = z.string().regex(/^r_[a-f0-9]{64}$/);
const unique = <T>(values: T[]) => new Set(values).size === values.length;
const ids = <T extends z.ZodType>(schema: T) => z.array(schema).refine(unique, "IDs must be unique");
const relativePath = z.string().min(1).refine((value) =>
  !value.startsWith("/") && !/[\\?#]/.test(value) &&
  value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
"Unsafe relative data path");
const directory = z.string().refine((value) =>
  value.endsWith("/") && relativePath.safeParse(value.slice(0, -1)).success,
"Unsafe relative data directory");

export const CleanCountsSchema = z.object({
  questions: z.number().int().nonnegative(),
  comments: z.number().int().nonnegative(),
  images: z.number().int().nonnegative(),
  automatic: z.number().int().nonnegative(),
  manual: z.number().int().nonnegative(),
  omittedComments: z.number().int().nonnegative(),
  sourceQuestions: z.number().int().nonnegative().optional(),
  duplicatesGrouped: z.number().int().nonnegative().optional(),
}).strict().superRefine((value, context) => {
  if (value.automatic + value.manual !== value.questions) {
    context.addIssue({ code: "custom", message: "Question grading counts do not reconcile" });
  }
  if ((value.sourceQuestions !== undefined || value.duplicatesGrouped !== undefined) &&
      (value.sourceQuestions === undefined || value.duplicatesGrouped === undefined ||
       value.sourceQuestions !== value.questions + value.duplicatesGrouped)) {
    context.addIssue({ code: "custom", message: "Duplicate grouping counts do not reconcile" });
  }
});

export const CleanManifestSchema = z.object({
  schemaVersion: z.literal(1),
  bankVersion: z.literal(CLEAN_BANK_VERSION),
  releaseId: CleanReleaseIdSchema,
  sourceRevision: Sha256Schema,
  approvedCommentsDigest: Sha256Schema,
  catalogUrl: relativePath,
  questionBaseUrl: directory,
  discussionBaseUrl: directory,
  mediaBaseUrl: directory,
  counts: CleanCountsSchema,
}).strict().superRefine((value, context) => {
  const root = `content/${value.releaseId}/`;
  if (value.catalogUrl !== `${root}catalog.json` ||
      value.questionBaseUrl !== `${root}questions/` ||
      value.discussionBaseUrl !== `${root}discussions/` ||
      value.mediaBaseUrl !== `${root}media/`) {
    context.addIssue({ code: "custom", message: "Manifest paths do not match its release" });
  }
});

export const CleanMediaSchema = z.object({
  id: Sha256Schema,
  objectPath: z.string().regex(/^published\/az104\/r_[a-f0-9]{64}\/assets\/[a-f0-9]{64}\.(png|jpg|gif|webp)$/),
  contentType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  byteLength: z.number().int().positive(),
  sourceUrls: z.array(SafeUrlSchema).min(1),
}).strict();

export const CleanQuestionSchema = z.object({
  schemaVersion: z.literal(1),
  id: QuestionIdSchema,
  sourceRevision: Sha256Schema,
  kind: z.enum(["single-select", "multi-select", "manual"]),
  prompt: RichContentSchema.min(1),
  options: z.array(z.object({ id: OptionIdSchema, content: RichContentSchema.min(1) }).strict()),
  shuffle: z.object({ allowed: z.boolean() }).strict(),
  fixedOptionOrder: ids(OptionIdSchema),
  sourceOccurrenceIds: ids(OccurrenceIdSchema).min(1),
  assetIds: ids(Sha256Schema),
  commentCount: z.number().int().nonnegative(),
  readiness: z.object({ grading: z.enum(["automatic", "manual"]) }).strict(),
  media: z.array(CleanMediaSchema),
  sources: z.array(z.object({
    questionNumber: z.number().int().min(1).max(606),
    pageNumber: z.number().int().positive(),
    url: SafeUrlSchema,
  }).strict()).min(1),
}).strict().superRefine((question, context) => {
  const options = question.options.map((option) => option.id);
  if (!unique(options) || question.fixedOptionOrder.length !== options.length ||
      !question.fixedOptionOrder.every((id) => options.includes(id))) {
    context.addIssue({ code: "custom", message: "Fixed option order must contain each option ID exactly once" });
  }
  if (question.kind !== "manual" && options.length < 2) {
    context.addIssue({ code: "custom", message: "Choice questions need at least two options" });
  }
  if (question.kind === "manual" && question.readiness.grading === "automatic") {
    context.addIssue({ code: "custom", message: "Manual questions cannot be automatically graded" });
  }
  const occurrences = question.sources.map((source) =>
    `examprepper-45-q${String(source.questionNumber).padStart(6, "0")}`);
  if (!unique(occurrences) || occurrences.length !== question.sourceOccurrenceIds.length ||
      !occurrences.every((id) => question.sourceOccurrenceIds.includes(id))) {
    context.addIssue({ code: "custom", message: "Source attribution must match the question occurrences" });
  }
  if (!unique(question.media.map((media) => media.id))) {
    context.addIssue({ code: "custom", message: "Media IDs must be unique" });
  }
});

export const CleanAnswerSchema = z.object({
  schemaVersion: z.literal(1),
  id: QuestionIdSchema,
  questionId: QuestionIdSchema,
  sourceRevision: Sha256Schema,
  originalAnswers: z.array(z.object({
    sourceOccurrenceId: OccurrenceIdSchema,
    value: AnswerValueSchema,
    explanation: RichContentSchema,
    answerAssetIds: ids(Sha256Schema),
    provenance: z.object({
      source: z.literal("examprepper"),
      url: SafeUrlSchema,
    }).strict(),
  }).strict()).min(1),
  effectiveAnswer: z.object({ value: AnswerValueSchema }).strict(),
  provisional: z.boolean(),
}).strict();

export const CleanSummarySchema = z.object({
  id: QuestionIdSchema,
  number: z.number().int().min(1).max(606),
  kind: z.enum(["single-select", "multi-select", "manual"]),
  grading: z.enum(["automatic", "manual"]),
  provisional: z.boolean(),
  commentCount: z.number().int().nonnegative(),
  omittedCommentCount: z.number().int().nonnegative(),
  hasImages: z.boolean(),
  preview: z.string(),
  searchText: z.string(),
  sourceNumbers: ids(z.number().int().min(1).max(606)).nonempty().optional(),
  discussionEnabled: z.boolean(),
}).strict();

export const CleanCatalogSchema = z.object({
  schemaVersion: z.literal(1),
  bankVersion: z.literal(CLEAN_BANK_VERSION),
  releaseId: CleanReleaseIdSchema,
  sourceRevision: Sha256Schema,
  counts: CleanCountsSchema,
  questions: z.array(CleanSummarySchema),
}).strict();

export const CleanDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  releaseId: CleanReleaseIdSchema,
  question: CleanQuestionSchema,
  answers: CleanAnswerSchema,
  discussionEnabled: z.boolean(),
}).strict().superRefine(({ question, answers, discussionEnabled, releaseId }, context) => {
  const issue = (message: string) => context.addIssue({ code: "custom", message });
  if (answers.id !== question.id || answers.questionId !== question.id ||
      answers.sourceRevision !== question.sourceRevision) issue("Question and answer identity must agree");
  if (discussionEnabled !== (question.commentCount > 0)) issue("Discussion availability must match its count");
  const originalIds = answers.originalAnswers.map((answer) => answer.sourceOccurrenceId);
  if (!unique(originalIds) || originalIds.length !== question.sourceOccurrenceIds.length ||
      !originalIds.every((id) => question.sourceOccurrenceIds.includes(id))) {
    issue("Original answers must match source occurrences");
  }
  const options = new Set(question.options.map((option) => option.id));
  const values = [answers.effectiveAnswer.value, ...answers.originalAnswers.map((answer) => answer.value)];
  if (values.some((value) => value.kind === "option-selection" &&
      value.optionIds.some((id) => !options.has(id)))) issue("Answer references an unknown option ID");
  const effective = answers.effectiveAnswer.value;
  if (effective.kind === "option-selection" && question.kind === "single-select" &&
      effective.optionIds.length !== 1) issue("Single-select key must contain one option");
  if (question.readiness.grading === "automatic" && effective.kind !== "option-selection") {
    issue("Automatic grading requires an option-selection key");
  }
  for (const media of question.media) {
    if (media.objectPath !== `published/az104/${releaseId}/assets/${media.id}.${mediaExtension(media.contentType)}`) {
      issue("Media path does not match its release and hash");
    }
  }
});

export const CleanDiscussionSchema = z.object({
  schemaVersion: z.literal(1),
  releaseId: CleanReleaseIdSchema,
  questionId: QuestionIdSchema,
  comments: z.array(CommentSchema),
}).strict();

export const ApprovedCommentsSchema = z.object({
  bankVersion: z.literal(CLEAN_BANK_VERSION),
  comments: z.array(z.object({
    id: CommentSchema.shape.id,
    sourceOccurrenceId: OccurrenceIdSchema,
  }).strict()),
}).strict();

export function mediaExtension(contentType: z.infer<typeof CleanMediaSchema>["contentType"]): string {
  return { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" }[contentType];
}

export function commentIdentity(comment: { id: string; sourceOccurrenceId: string }): string {
  return `${comment.sourceOccurrenceId}/${comment.id}`;
}

export function assertDiscussionThreads(discussion: z.infer<typeof CleanDiscussionSchema>): void {
  const byId = new Map(discussion.comments.map((comment) => [comment.id, comment]));
  if (byId.size !== discussion.comments.length) throw new Error("Duplicate discussion comment IDs");
  for (const comment of discussion.comments) {
    if (comment.questionId !== discussion.questionId) throw new Error("Comment belongs to another question");
    const root = byId.get(comment.rootId);
    if (!root || root.parentId !== null || root.rootId !== root.id) throw new Error("Invalid comment root");
    const seen = new Set([comment.id]);
    let current = comment;
    while (current.parentId !== null) {
      const parent = byId.get(current.parentId);
      if (!parent || !parent.childIds.includes(current.id) || seen.has(parent.id) ||
          parent.rootId !== comment.rootId || parent.sourceOccurrenceId !== comment.sourceOccurrenceId) {
        throw new Error("Invalid comment ancestry");
      }
      seen.add(parent.id);
      current = parent;
    }
    if (current.id !== root.id || comment.childIds.some((id) => byId.get(id)?.parentId !== comment.id)) {
      throw new Error("Invalid comment child/root relation");
    }
  }
}

export type CleanQuestion = z.infer<typeof CleanQuestionSchema>;
export type CleanAnswer = z.infer<typeof CleanAnswerSchema>;
export type CleanDocument = z.infer<typeof CleanDocumentSchema>;
export type CleanCatalog = z.infer<typeof CleanCatalogSchema>;
export type CleanManifest = z.infer<typeof CleanManifestSchema>;
export type CleanDiscussion = z.infer<typeof CleanDiscussionSchema>;
