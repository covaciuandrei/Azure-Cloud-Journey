import { z } from "zod";
import {
  AnswerRecordSchema, CatalogSchema, EvidenceSchema, OptionSchema, QuestionSchema,
  RecordCountsSchema, RichContentSchema, SafeUrlSchema, Sha256Schema, ShuffleSchema, SourceOccurrenceSchema,
} from "./schemas.js";

export const StudyAnswerStatusSchema = z.enum([
  "source-default", "confirmed", "corrected", "unresolved", "outdated-or-defective",
]);
export const CommentVerdictSchema = z.enum([
  "supports-source", "disputes-source", "mixed", "no-comments", "insufficient-evidence",
]);
export const OfficialDocumentationUrlSchema = z.url().refine((value) => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password &&
    (url.hostname === "microsoft.com" || url.hostname.endsWith(".microsoft.com"));
}, "A consulted citation must be an HTTPS Microsoft documentation URL.");

export const StudyAssessmentSchema = z.object({
  status: StudyAnswerStatusSchema,
  provisional: z.boolean(),
  summary: z.string().min(1),
  warnings: z.array(z.string().min(1)),
  citations: z.array(EvidenceSchema.safeExtend({ url: OfficialDocumentationUrlSchema })),
  sourceQuestionNumbers: z.array(z.number().int().min(1).max(606)).min(1),
  originalImageAnswers: z.array(z.object({
    sourceQuestionNumber: z.number().int().positive(),
    summary: z.string().min(1),
  }).strict()),
  effectiveImageAnswerSummary: z.string().min(1).nullable(),
}).strict().superRefine((value, context) => {
  const uncertain = ["unresolved", "outdated-or-defective"].includes(value.status);
  if (value.provisional !== uncertain || (uncertain && value.warnings.length === 0)) {
    context.addIssue({ code: "custom", message: "Uncertain answers need a warning and provisional result." });
  }
  if (["confirmed", "corrected"].includes(value.status) && value.citations.length === 0) {
    context.addIssue({ code: "custom", message: "Documented answer decisions need citations." });
  }
});
export type StudyAssessment = z.infer<typeof StudyAssessmentSchema>;

export const ReleaseIdSchema = z.string().regex(/^r_[a-f0-9]{64}$/);
export const PublicMediaSchema = z.object({
  id: Sha256Schema,
  objectPath: z.string().regex(
    /^published\/az104\/r_[a-f0-9]{64}\/assets\/[a-f0-9]{64}\.(png|jpg|gif|webp)$/,
  ),
  contentType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  byteLength: z.number().int().positive(),
  sourceUrls: z.array(SafeUrlSchema).min(1),
}).strict();

export const PreparedQuestionSchema = QuestionSchema.safeExtend({
  sourceCommentCount: z.number().int().nonnegative().optional(),
  omittedCommentCount: z.number().int().nonnegative().optional(),
  sourcePresentation: z.object({
    kind: z.enum(["single-select", "multi-select", "manual"]),
    prompt: RichContentSchema,
    options: z.array(OptionSchema),
    shuffle: ShuffleSchema,
  }).strict(),
  media: z.array(PublicMediaSchema),
  sources: z.array(z.object({
    questionNumber: SourceOccurrenceSchema.shape.questionNumber,
    pageNumber: SourceOccurrenceSchema.shape.pageNumber,
    url: SourceOccurrenceSchema.shape.url,
    sourceLabelToOptionId: SourceOccurrenceSchema.shape.sourceLabelToOptionId,
    sourceOptionOrder: SourceOccurrenceSchema.shape.sourceOptionOrder,
  }).strict()).min(1),
}).superRefine((question, context) => {
  if (question.sourceCommentCount !== undefined || question.omittedCommentCount !== undefined) {
    if (question.sourceCommentCount === undefined || question.omittedCommentCount === undefined ||
        question.sourceCommentCount !== question.commentCount + question.omittedCommentCount) {
      context.addIssue({ code: "custom", message: "Original, retained, and omitted comment counts must reconcile." });
    }
  }
});
export const PreparedAnswerSchema = AnswerRecordSchema.safeExtend({
  assessment: StudyAssessmentSchema,
});
export const PreparedCatalogSchema = CatalogSchema.safeExtend({
  releaseId: ReleaseIdSchema,
  published: z.boolean(),
  records: RecordCountsSchema,
  sourceRecords: RecordCountsSchema.optional(),
  commentFilter: z.object({
    version: z.string().min(1),
    original: z.number().int().nonnegative(),
    retained: z.number().int().nonnegative(),
    omitted: z.number().int().nonnegative(),
    decisionDigest: Sha256Schema,
  }).strict().optional(),
  reviewCounts: z.record(StudyAnswerStatusSchema, z.number().int().nonnegative()),
  gradingCounts: z.object({
    automatic: z.number().int().nonnegative(),
    manual: z.number().int().nonnegative(),
  }).strict(),
}).superRefine((catalog, context) => {
  if (catalog.commentFilter) {
    const filter = catalog.commentFilter;
    if (!catalog.sourceRecords || filter.original !== catalog.sourceRecords.comments ||
        filter.retained !== catalog.records.comments ||
        filter.original !== filter.retained + filter.omitted ||
        catalog.entries.reduce((sum, entry) => sum + entry.commentCount, 0) !== filter.retained) {
      context.addIssue({ code: "custom", message: "Catalog comment filtering counts do not match the source or public records." });
    }
  }
});
export type PreparedQuestion = z.infer<typeof PreparedQuestionSchema>;
export type PreparedAnswer = z.infer<typeof PreparedAnswerSchema>;
export type PreparedCatalog = z.infer<typeof PreparedCatalogSchema>;
