import { z } from "zod";

export const SCHEMA_VERSION = 1 as const;
export const DATASET_ID = "az104" as const;
export const NORMALIZER_VERSION = "rendered-ui-1" as const;
export const EXPECTED_COVERAGE = { pages: 122, occurrences: 606, pageSize: 5 } as const;
export const MAX_DOCUMENT_BYTES = 800_000;

export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const QuestionIdSchema = z.string().regex(/^q_[a-f0-9]{64}$/);
export const OptionIdSchema = z.string().regex(/^opt_[a-f0-9]{64}(?:_[1-9]\d*)?$/);
export const CommentIdSchema = z.string().regex(/^c_[a-f0-9]{64}$/);
export const OccurrenceIdSchema = z.string().regex(/^examprepper-45-q\d{6}$/);
export const TimestampSchema = z.iso.datetime({ offset: true });
export const SafeUrlSchema = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}, "Expected an absolute HTTP(S) URL without credentials");
export const RelativePathSchema = z.string().min(1).refine(
  (value) => !value.startsWith("/") && !value.includes("\\") &&
    !value.split("/").some((part) => part === ".." || part === "." || part === ""),
  "Expected a workspace-relative path without traversal",
);

const unique = <T>(values: T[]) => new Set(values).size === values.length;
const uniqueIds = <T extends z.ZodType>(schema: T) =>
  z.array(schema).refine(unique, "IDs must be unique");
const MarkSchema = z.enum(["bold", "italic", "underline", "strike", "subscript", "superscript"]);
export const InlineSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string(), marks: z.array(MarkSchema) }).strict(),
  z.object({ type: z.literal("code"), text: z.string(), marks: z.array(MarkSchema) }).strict(),
  z.object({
    type: z.literal("link"), text: z.string(), href: SafeUrlSchema, marks: z.array(MarkSchema),
  }).strict(),
]);
export type Inline = z.infer<typeof InlineSchema>;
export type RichBlock =
  | { type: "text"; spans: Inline[] }
  | { type: "heading"; level: number; spans: Inline[] }
  | { type: "code"; code: string; language: string | null }
  | { type: "image"; assetId: string; alt: string; width: number; height: number }
  | { type: "table"; caption: Inline[]; rows: { cells: {
    header: boolean; rowSpan: number; colSpan: number; blocks: RichBlock[];
  }[] }[] }
  | { type: "list"; ordered: boolean; start: number; items: RichBlock[][] }
  | { type: "quote"; blocks: RichBlock[] }
  | { type: "separator" };

export const RichBlockSchema: z.ZodType<RichBlock> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), spans: z.array(InlineSchema) }).strict(),
    z.object({
      type: z.literal("heading"), level: z.number().int().min(1).max(6), spans: z.array(InlineSchema),
    }).strict(),
    z.object({
      type: z.literal("code"), code: z.string(), language: z.string().nullable(),
    }).strict(),
    z.object({
      type: z.literal("image"), assetId: Sha256Schema, alt: z.string(),
      width: z.number().int().positive(), height: z.number().int().positive(),
    }).strict(),
    z.object({
      type: z.literal("table"), caption: z.array(InlineSchema),
      rows: z.array(z.object({
        cells: z.array(z.object({
          header: z.boolean(), rowSpan: z.number().int().nonnegative(),
          colSpan: z.number().int().positive(), blocks: z.array(RichBlockSchema),
        }).strict()).min(1),
      }).strict()),
    }).strict(),
    z.object({
      type: z.literal("list"), ordered: z.boolean(), start: z.number().int(),
      items: z.array(z.array(RichBlockSchema)),
    }).strict(),
    z.object({ type: z.literal("quote"), blocks: z.array(RichBlockSchema) }).strict(),
    z.object({ type: z.literal("separator") }).strict(),
  ]),
);
export const RichContentSchema = z.array(RichBlockSchema);
export type RichContent = z.infer<typeof RichContentSchema>;

export const OptionSchema = z.object({
  id: OptionIdSchema,
  contentHash: Sha256Schema,
  content: RichContentSchema.min(1),
}).strict().refine((value) => value.id === `opt_${value.contentHash}` ||
  value.id.startsWith(`opt_${value.contentHash}_`), "Option ID must be based on its content hash");
export type Option = z.infer<typeof OptionSchema>;
export const ShuffleReasonSchema = z.enum([
  "label-reference", "relative-option-reference", "ordered-or-matching",
  "duplicate-option-content", "no-discrete-options",
]);
export const ShuffleSchema = z.object({
  allowed: z.boolean(), reasons: uniqueIds(ShuffleReasonSchema),
}).strict().refine((value) => value.allowed === (value.reasons.length === 0), {
  message: "Shuffle permission must agree with its limitations",
});

export const ReviewStateSchema = z.object({
  status: z.enum(["pending", "completed"]),
  basedOnSourceRevision: Sha256Schema.nullable(),
  reviewer: z.string().min(1).nullable(),
  reviewedAt: TimestampSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.status === "completed" &&
      (!value.basedOnSourceRevision || !value.reviewer || !value.reviewedAt)) {
    context.addIssue({ code: "custom", message: "Completed review requires revision, reviewer and time" });
  }
});
export const pendingReview = () => ({
  status: "pending" as const, basedOnSourceRevision: null, reviewer: null, reviewedAt: null,
});
export const ConversionStateSchema = z.object({
  status: z.enum(["not-required", "pending", "completed"]),
  reason: z.string().min(1).nullable(),
}).strict();

const QuestionObjectSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: QuestionIdSchema,
  exam: z.literal("AZ-104"),
  fingerprint: Sha256Schema,
  sourceRevision: Sha256Schema,
  kind: z.enum(["single-select", "multi-select", "manual"]),
  prompt: RichContentSchema.min(1),
  options: z.array(OptionSchema),
  shuffle: ShuffleSchema,
  sourceOccurrenceIds: uniqueIds(OccurrenceIdSchema).min(1),
  assetIds: uniqueIds(Sha256Schema),
  commentCount: z.number().int().nonnegative(),
  review: ReviewStateSchema,
  conversion: ConversionStateSchema,
  readiness: z.object({
    content: z.literal("complete"),
    grading: z.enum(["automatic", "manual"]),
    publication: z.enum(["blocked-review", "ready"]),
  }).strict(),
  published: z.boolean(),
}).strict();
export const QuestionSchema = QuestionObjectSchema.superRefine((value, context) => {
  if (value.id !== `q_${value.fingerprint}`) {
    context.addIssue({ code: "custom", path: ["id"], message: "Question ID must be its canonical fingerprint" });
  }
  if (!unique(value.options.map((option) => option.id))) {
    context.addIssue({ code: "custom", path: ["options"], message: "Duplicate option IDs" });
  }
  if (value.kind !== "manual" && value.options.length < 2) {
    context.addIssue({ code: "custom", path: ["options"], message: "Choice questions need at least two options" });
  }
  if (value.readiness.grading === "automatic" &&
      (value.kind === "manual" || value.conversion.status === "pending")) {
    context.addIssue({ code: "custom", message: "Unconverted/manual questions cannot be automatically graded" });
  }
  const reviewed = value.review.status === "completed" &&
    value.review.basedOnSourceRevision === value.sourceRevision;
  if ((value.published || value.readiness.publication === "ready") && !reviewed) {
    context.addIssue({ code: "custom", message: "Publication requires current semantic comment assessment" });
  }
});
export type Question = z.infer<typeof QuestionSchema>;

export const OptionSelectionSchema = z.object({
  kind: z.literal("option-selection"), optionIds: uniqueIds(OptionIdSchema).min(1),
}).strict();
export const ManualAnswerSchema = z.object({
  kind: z.literal("manual"),
  reason: z.enum([
    "image-only", "non-choice-format", "no-readable-key", "conflicting-source-keys",
    "ambiguous-options", "conversion-pending", "review-unresolved",
  ]),
  sourceAnswerAssetIds: uniqueIds(Sha256Schema),
}).strict();
export const AnswerValueSchema = z.discriminatedUnion("kind", [
  OptionSelectionSchema, ManualAnswerSchema,
]);
export type AnswerValue = z.infer<typeof AnswerValueSchema>;
export const OriginalAnswerSchema = z.object({
  sourceOccurrenceId: OccurrenceIdSchema,
  value: AnswerValueSchema,
  sourceLabels: uniqueIds(z.string().regex(/^[A-Z]$/)),
  explanation: RichContentSchema,
  answerAssetIds: uniqueIds(Sha256Schema),
  provenance: z.object({
    kind: z.literal("source-default"),
    source: z.literal("examprepper"),
    url: SafeUrlSchema,
    capturedAt: TimestampSchema,
    evidence: z.enum(["rendered-green-border", "rendered-answer-image", "rendered-author-text", "no-readable-key"]),
    verification: z.literal("not-independently-verified"),
  }).strict(),
}).strict();
export type OriginalAnswer = z.infer<typeof OriginalAnswerSchema>;
export const AnswerRecordSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: QuestionIdSchema,
  questionId: QuestionIdSchema,
  sourceRevision: Sha256Schema,
  originalAnswers: z.array(OriginalAnswerSchema).min(1),
  originalKeysConflict: z.boolean(),
  effectiveAnswer: z.object({
    value: AnswerValueSchema,
    basis: z.enum(["source-default", "source-conflict", "manual-required", "review-override", "review-unresolved"]),
    sourceOccurrenceIds: uniqueIds(OccurrenceIdSchema),
    verification: z.enum(["not-independently-verified", "community-reviewed", "documented"]),
  }).strict(),
  review: ReviewStateSchema,
  published: z.boolean(),
}).strict().superRefine((value, context) => {
  if (value.id !== value.questionId) context.addIssue({ code: "custom", message: "Answer ID must equal question ID" });
  if (!unique(value.originalAnswers.map((answer) => answer.sourceOccurrenceId))) {
    context.addIssue({ code: "custom", message: "Each source occurrence needs one original answer" });
  }
  if (!value.effectiveAnswer.sourceOccurrenceIds.every((id) =>
    value.originalAnswers.some((answer) => answer.sourceOccurrenceId === id))) {
    context.addIssue({ code: "custom", message: "Effective answer provenance must refer to retained original answers" });
  }
  if (value.published && (value.review.status !== "completed" ||
      value.review.basedOnSourceRevision !== value.sourceRevision)) {
    context.addIssue({ code: "custom", message: "Published answers need current semantic comment assessment" });
  }
});
export type AnswerRecord = z.infer<typeof AnswerRecordSchema>;

export const CaptureIssueSchema = z.object({
  code: z.string().min(1), context: z.string().min(1), message: z.string().min(1),
}).strict();
export type CaptureIssue = z.infer<typeof CaptureIssueSchema>;
export const SourceOccurrenceSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: OccurrenceIdSchema,
  questionId: QuestionIdSchema,
  sourceRevision: Sha256Schema,
  source: z.literal("examprepper"),
  sourceExamId: z.literal("45"),
  pageNumber: z.number().int().positive(),
  questionNumber: z.number().int().positive(),
  heading: z.string().min(1),
  url: SafeUrlSchema,
  title: z.string().min(1),
  capturedAt: TimestampSchema,
  sourceLabelToOptionId: z.record(z.string().regex(/^[A-Z]$/), OptionIdSchema),
  sourceOptionOrder: uniqueIds(z.string().regex(/^[A-Z]$/)),
  commentIds: uniqueIds(CommentIdSchema),
  rootCommentIds: uniqueIds(CommentIdSchema),
  capture: z.object({
    version: z.literal(1),
    method: z.literal("rendered-browser-ui"),
    rawPagePath: RelativePathSchema,
    rawPageSha256: Sha256Schema,
    htmlSha256: Sha256Schema,
    renderedTextSha256: Sha256Schema,
    answerEvidence: z.enum(["flag-and-hide-control", "legacy-hide-control"]),
    discussionEvidence: z.enum(["rendered-comments", "confirmed-empty", "explicit-empty-state"]),
    discussionLoadStatus: z.enum(["loaded", "rendered-only", "legacy-rendered"]),
    expectedCommentCount: z.number().int().nonnegative(),
    parsedCommentCount: z.number().int().nonnegative(),
  }).strict(),
  issues: z.array(CaptureIssueSchema),
}).strict().superRefine((value, context) => {
  if (value.capture.expectedCommentCount !== value.capture.parsedCommentCount ||
      value.commentIds.length !== value.capture.parsedCommentCount) {
    context.addIssue({ code: "custom", message: "Captured/parsed/indexed comment counts must reconcile" });
  }
  if (value.capture.parsedCommentCount === 0 &&
      (value.capture.discussionLoadStatus !== "loaded" || value.capture.discussionEvidence === "rendered-comments")) {
    context.addIssue({ code: "custom", message: "An empty discussion requires confirmed successful loading, not a placeholder or unknown request state" });
  }
  if (!value.rootCommentIds.every((id) => value.commentIds.includes(id))) {
    context.addIssue({ code: "custom", message: "Root comment IDs must belong to this occurrence" });
  }
  if (Object.keys(value.sourceLabelToOptionId).sort().join() !== [...value.sourceOptionOrder].sort().join()) {
    context.addIssue({ code: "custom", message: "Source option order and label mapping must agree" });
  }
  if (!unique(Object.values(value.sourceLabelToOptionId))) {
    context.addIssue({ code: "custom", message: "Source labels must retain distinct option identities" });
  }
});
export type SourceOccurrence = z.infer<typeof SourceOccurrenceSchema>;

export const CommentSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: CommentIdSchema,
  questionId: QuestionIdSchema,
  sourceOccurrenceId: OccurrenceIdSchema,
  sourceRevision: Sha256Schema,
  sourceCommentId: z.null(),
  sourceCreatedAt: z.null(),
  author: z.string().min(1),
  votes: z.number().int(),
  voteText: z.string().min(1),
  displayedTimestamp: z.string().min(1),
  capturedAt: TimestampSchema,
  bodyText: z.string(),
  bodyTextContent: z.string(),
  body: RichContentSchema,
  parentId: CommentIdSchema.nullable(),
  rootId: CommentIdSchema,
  childIds: uniqueIds(CommentIdSchema),
  treePath: z.array(z.number().int().nonnegative()).min(1),
  trust: z.literal("untrusted-source-content"),
}).strict();
export type Comment = z.infer<typeof CommentSchema>;

export const AssetRoleSchema = z.enum(["prompt", "option", "answer", "comment"]);
export const AssetUseSchema = z.object({
  sourceOccurrenceId: OccurrenceIdSchema,
  questionId: QuestionIdSchema,
  commentId: CommentIdSchema.nullable(),
  role: AssetRoleSchema,
  presentationIndex: z.number().int().nonnegative(),
  sourceUrl: SafeUrlSchema,
  alt: z.string(),
}).strict();
export type AssetUse = z.infer<typeof AssetUseSchema>;
export const AssetSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: Sha256Schema,
  sha256: Sha256Schema,
  contentType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  extension: z.enum(["png", "jpg", "gif", "webp"]),
  byteLength: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  filePath: RelativePathSchema,
  sourceUrls: uniqueIds(SafeUrlSchema).min(1),
  sourceResponses: z.array(z.object({
    url: SafeUrlSchema, declaredContentType: z.string().min(1),
  }).strict()).min(1),
  uses: z.array(AssetUseSchema),
  validation: z.object({
    signature: z.literal("verified"), dimensions: z.literal("verified"),
    mime: z.enum(["matched", "corrected-from-signature"]),
  }).strict(),
}).strict().refine((value) => value.id === value.sha256, "Asset ID must be its byte hash");
export type Asset = z.infer<typeof AssetSchema>;

export const EvidenceSchema = z.object({
  url: SafeUrlSchema, title: z.string().min(1), note: z.string(),
}).strict();
export const ReviewOverlaySchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  questionId: QuestionIdSchema,
  basedOnSourceRevision: Sha256Schema,
  status: z.literal("completed"),
  reviewer: z.string().min(1),
  reviewedAt: TimestampSchema,
  commentAssessment: z.object({
    assessedCommentIds: uniqueIds(CommentIdSchema),
    summary: z.string().min(1),
  }).strict(),
  answerDecision: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("retain-source") }).strict(),
    z.object({
      kind: z.literal("override"), value: AnswerValueSchema,
      rationale: z.string().min(1), evidence: z.array(EvidenceSchema),
    }).strict(),
    z.object({ kind: z.literal("unresolved"), reason: z.string().min(1) }).strict(),
  ]),
  published: z.boolean(),
}).strict();
export type ReviewOverlay = z.infer<typeof ReviewOverlaySchema>;
export const ConversionOverlaySchema = z.discriminatedUnion("status", [
  z.object({
    schemaVersion: z.literal(SCHEMA_VERSION), questionId: QuestionIdSchema,
    basedOnSourceRevision: Sha256Schema, status: z.literal("pending"), notes: z.string(),
  }).strict(),
  z.object({
    schemaVersion: z.literal(SCHEMA_VERSION), questionId: QuestionIdSchema,
    basedOnSourceRevision: Sha256Schema, status: z.literal("completed"),
    converter: z.string().min(1), convertedAt: TimestampSchema,
    kind: z.enum(["single-select", "multi-select"]),
    prompt: RichContentSchema.min(1), options: z.array(OptionSchema).min(2),
    answer: OptionSelectionSchema,
    sourceAssetIds: uniqueIds(Sha256Schema).min(1),
    notes: z.string().min(1),
  }).strict(),
]).superRefine((value, context) => {
  if (value.status === "completed") {
    const ids = value.options.map((option) => option.id);
    if (!unique(ids) || !value.answer.optionIds.every((id) => ids.includes(id))) {
      context.addIssue({ code: "custom", message: "Converted answer must reference unique converted options" });
    }
    if (value.kind === "single-select" && value.answer.optionIds.length !== 1) {
      context.addIssue({ code: "custom", message: "Single-select conversion needs one correct option" });
    }
  }
});
export type ConversionOverlay = z.infer<typeof ConversionOverlaySchema>;

export const CoverageSchema = z.object({
  expectedPages: z.number().int().positive(),
  expectedOccurrences: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  actualPages: z.number().int().nonnegative(),
  actualOccurrences: z.number().int().nonnegative(),
  missingPages: uniqueIds(z.number().int().positive()),
  missingQuestionNumbers: uniqueIds(z.number().int().positive()),
  complete: z.boolean(),
}).strict().refine((value) => value.complete === (
  value.actualPages === value.expectedPages && value.actualOccurrences === value.expectedOccurrences &&
  value.missingPages.length === 0 && value.missingQuestionNumbers.length === 0
), "Coverage completion must be truthful");
export type Coverage = z.infer<typeof CoverageSchema>;
export const RecordCountsSchema = z.object({
  questions: z.number().int().nonnegative(), answers: z.number().int().nonnegative(),
  occurrences: z.number().int().nonnegative(), comments: z.number().int().nonnegative(),
  assets: z.number().int().nonnegative(),
}).strict();
export const RawPageMetadataSchema = z.object({
  path: RelativePathSchema, sha256: Sha256Schema, pageNumber: z.number().int().positive(),
  capturedAt: TimestampSchema, questionNumbers: uniqueIds(z.number().int().positive()),
}).strict();
export type RawPageMetadata = z.infer<typeof RawPageMetadataSchema>;
export const ManifestSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  datasetId: z.literal(DATASET_ID),
  normalizerVersion: z.literal(NORMALIZER_VERSION),
  importId: z.string().regex(/^import_[a-f0-9]{64}$/),
  sourceRevision: Sha256Schema,
  sourceMethod: z.literal("rendered-browser-ui"),
  coverage: CoverageSchema,
  rawPages: z.array(RawPageMetadataSchema),
  records: RecordCountsSchema,
  recordDigests: z.object({
    questions: Sha256Schema, answers: Sha256Schema, occurrences: Sha256Schema,
    comments: Sha256Schema, assets: Sha256Schema,
  }).strict(),
  catalogSha256: Sha256Schema,
  duplicateGroups: z.number().int().nonnegative(),
  mergedOccurrences: z.number().int().nonnegative(),
  conflictingOriginalKeys: z.number().int().nonnegative(),
  conversionPending: z.number().int().nonnegative(),
  reviewPending: z.number().int().nonnegative(),
  issues: z.array(CaptureIssueSchema),
}).strict();
export type Manifest = z.infer<typeof ManifestSchema>;
export const CatalogEntrySchema = z.object({
  id: QuestionIdSchema, sourceRevision: Sha256Schema,
  questionPath: RelativePathSchema, answerPath: RelativePathSchema,
  sourceOccurrenceIds: uniqueIds(OccurrenceIdSchema).min(1),
  sourceQuestionNumbers: uniqueIds(z.number().int().positive()).min(1),
  kind: QuestionObjectSchema.shape.kind,
  commentCount: z.number().int().nonnegative(),
  conversionStatus: ConversionStateSchema.shape.status,
  reviewStatus: ReviewStateSchema.shape.status,
  published: z.boolean(),
}).strict();
export const CatalogSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  datasetId: z.literal(DATASET_ID),
  sourceRevision: Sha256Schema,
  entries: z.array(CatalogEntrySchema),
}).strict();
export type Catalog = z.infer<typeof CatalogSchema>;

export function assertAnswerOptionIds(
  question: Pick<Question, "id" | "options" | "kind">,
  value: AnswerValue,
  context: string,
): void {
  if (value.kind !== "option-selection") return;
  const ids = new Set(question.options.map((option) => option.id));
  for (const id of value.optionIds) {
    if (!ids.has(id)) throw new Error(`${context}: answer option ${id} does not belong to ${question.id}`);
  }
  if (question.kind === "single-select" && value.optionIds.length !== 1) {
    throw new Error(`${context}: single-select question ${question.id} needs exactly one answer option`);
  }
}

export function richAssetIds(blocks: RichContent): string[] {
  const ids = new Set<string>();
  const visit = (content: RichContent) => {
    for (const block of content) {
      if (block.type === "image") ids.add(block.assetId);
      if (block.type === "quote") visit(block.blocks);
      if (block.type === "list") block.items.forEach(visit);
      if (block.type === "table") block.rows.forEach((row) => row.cells.forEach((cell) => visit(cell.blocks)));
    }
  };
  visit(blocks);
  return [...ids].sort();
}

export function assertDocumentSize(value: unknown, context: string): void {
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (bytes > MAX_DOCUMENT_BYTES) {
    throw new Error(`${context}: ${bytes} JSON bytes exceeds the ${MAX_DOCUMENT_BYTES}-byte Firestore safety limit`);
  }
}
