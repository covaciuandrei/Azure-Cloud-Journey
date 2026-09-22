import { z } from "zod";
import {
  AnswerValueSchema, CommentSchema, OptionIdSchema, QuestionIdSchema,
  RichContentSchema, Sha256Schema, richAssetIds, type Inline, type RichContent,
} from "./schemas.js";
import { isCredentialFreeUrl, PublicHttpUrlSchema } from "./publicUrls.js";
import { CleanCountsSchema, CleanReleaseIdSchema, mediaExtension } from "./cleanBank.js";
import {
  SC900_EXAM_ID, SC900_SOURCE_BASE_URL, SC900_SOURCE_PAGE_SIZE,
  Sc900OccurrenceIdSchema, Sc900SourceNumberSchema, Sc900PageNumberSchema, Sc900SourcePageUrlSchema,
} from "./sc900Capture.js";
import { Sc900DiscussionScopeSchema, Sc900PublicationCaptureLedgerSchema, type Sc900PublicationCaptureLedger } from "./sc900Scope.js";

export { SC900_EXAM_ID, Sc900OccurrenceIdSchema } from "./sc900Capture.js";
export const SC900_BANK_VERSION = "sc900-approved-v1" as const;
export const SC900_STATIC_BASE = "exams/sc900/" as const;
export const SC900_METADATA_PATHS = {
  bank: "studyMetadata/sc900Bank",
  topics: "studyMetadata/sc900Topics",
  learning: "studyMetadata/sc900Learning",
} as const;
export const Sc900ReleaseIdSchema = CleanReleaseIdSchema;
export const Sc900ReleasePointerSchema = z.object({
  schemaVersion: z.literal(1),
  examId: z.literal(SC900_EXAM_ID),
  bankVersion: z.literal(SC900_BANK_VERSION),
  releaseId: Sc900ReleaseIdSchema,
  sourceRevision: Sha256Schema,
  discussionScope: Sc900DiscussionScopeSchema.optional(),
}).strict();
const unique = <T>(values: T[]) => new Set(values).size === values.length;
const ids = <T extends z.ZodType>(schema: T) => z.array(schema).refine(unique, "IDs must be unique");
const relativePath = z.string().min(1).refine((value) =>
  /^[a-zA-Z0-9_./-]+$/.test(value) &&
  value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
"Unsafe SC900 repository-relative path");
const directory = z.string().refine((value) =>
  value.endsWith("/") && relativePath.safeParse(value.slice(0, -1)).success,
"Unsafe SC900 repository-relative directory");

function credentialFreeRichLinks(content: RichContent): boolean {
  const spans = (values: Inline[]) => values.every((span) => span.type !== "link" || isCredentialFreeUrl(span.href));
  return content.every((block) => {
    switch (block.type) {
      case "text": case "heading": return spans(block.spans);
      case "quote": return credentialFreeRichLinks(block.blocks);
      case "list": return block.items.every(credentialFreeRichLinks);
      case "table": return spans(block.caption) &&
        block.rows.every((row) => row.cells.every((cell) => credentialFreeRichLinks(cell.blocks)));
      case "image": case "code": case "separator": return true;
    }
  });
}
export const Sc900RichContentSchema = RichContentSchema.refine(credentialFreeRichLinks,
  "Credential-bearing URLs cannot be published.");

export const Sc900CountsSchema = CleanCountsSchema.refine((counts) =>
  counts.sourceQuestions !== undefined && counts.duplicatesGrouped !== undefined &&
  counts.questions > 0 && counts.omittedComments === 0,
"SC900 requires a complete source inventory without silently omitted comments");

export const Sc900ManifestSchema = z.object({
  schemaVersion: z.literal(1),
  examId: z.literal(SC900_EXAM_ID),
  bankVersion: z.literal(SC900_BANK_VERSION),
  releaseId: Sc900ReleaseIdSchema,
  sourceRevision: Sha256Schema,
  captureLedgerDigest: Sha256Schema,
  approvedCommentsDigest: Sha256Schema.nullable(),
  discussionScope: Sc900DiscussionScopeSchema.optional(),
  catalogUrl: relativePath,
  questionBaseUrl: directory,
  discussionBaseUrl: directory,
  mediaBaseUrl: directory,
  counts: Sc900CountsSchema,
}).strict().superRefine((manifest, context) => {
  const root = `content/${manifest.releaseId}/`;
  if (manifest.discussionScope ? manifest.approvedCommentsDigest !== null : manifest.approvedCommentsDigest === null) {
    context.addIssue({ code: "custom", message: "Only explicitly unavailable discussions have no comment-review digest" });
  }
  if (manifest.discussionScope && (manifest.counts.comments !== 0 || manifest.counts.duplicatesGrouped !== 0)) {
    context.addIssue({ code: "custom", message: "Questions-only banks have no stored source threads and conserve every source record" });
  }
  if (manifest.catalogUrl !== `${root}catalog.json` ||
      manifest.questionBaseUrl !== `${root}questions/` ||
      manifest.discussionBaseUrl !== `${root}discussions/` ||
      manifest.mediaBaseUrl !== `${root}media/`) {
    context.addIssue({ code: "custom", message: "SC900 paths must be relative to exams/sc900/ and match the immutable release" });
  }
});

export const Sc900MediaSchema = z.object({
  id: Sha256Schema,
  objectPath: z.string().regex(/^published\/sc900\/r_[a-f0-9]{64}\/assets\/[a-f0-9]{64}\.(png|jpg|gif|webp)$/),
  contentType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  byteLength: z.number().int().positive(),
  sourceUrls: ids(PublicHttpUrlSchema).nonempty(),
}).strict();

export const Sc900QuestionSchema = z.object({
  schemaVersion: z.literal(1),
  examId: z.literal(SC900_EXAM_ID),
  id: QuestionIdSchema,
  sourceRevision: Sha256Schema,
  kind: z.enum(["single-select", "multi-select", "manual"]),
  prompt: Sc900RichContentSchema.min(1),
  options: z.array(z.object({ id: OptionIdSchema, content: Sc900RichContentSchema.min(1) }).strict()),
  shuffle: z.object({ allowed: z.boolean() }).strict(),
  fixedOptionOrder: ids(OptionIdSchema),
  sourceOccurrenceIds: ids(Sc900OccurrenceIdSchema).nonempty(),
  assetIds: ids(Sha256Schema),
  commentCount: z.number().int().nonnegative(),
  discussionScope: Sc900DiscussionScopeSchema.optional(),
  readiness: z.object({ grading: z.enum(["automatic", "manual"]) }).strict(),
  media: z.array(Sc900MediaSchema),
  sources: z.array(z.object({
    questionNumber: Sc900SourceNumberSchema,
    pageNumber: Sc900PageNumberSchema,
    url: Sc900SourcePageUrlSchema,
  }).strict()).nonempty(),
}).strict().superRefine((question, context) => {
  const issue = (message: string) => context.addIssue({ code: "custom", message });
  if (question.discussionScope && (question.commentCount !== 0 || question.sourceOccurrenceIds.length !== 1)) {
    issue("Questions-only questions require explicit unavailable discussions and one conserved source record");
  }
  const options = question.options.map((option) => option.id);
  if (!unique(options) || question.fixedOptionOrder.length !== options.length ||
      !question.fixedOptionOrder.every((id) => options.includes(id))) {
    issue("Fixed option order must contain every option ID exactly once");
  }
  if (question.kind !== "manual" && options.length < 2) issue("Choice questions need at least two options");
  if (question.kind === "manual" && question.readiness.grading === "automatic") {
    issue("Manual questions cannot be automatically graded");
  }
  const occurrences = question.sources.map((source) => `examprepper-128-q${String(source.questionNumber).padStart(6, "0")}`);
  if (!unique(occurrences) || occurrences.length !== question.sourceOccurrenceIds.length ||
      !occurrences.every((id) => question.sourceOccurrenceIds.includes(id))) {
    issue("SC900 source attribution must match its occurrences");
  }
  if (question.sources.some((source) =>
    source.pageNumber !== Math.floor((source.questionNumber - 1) / SC900_SOURCE_PAGE_SIZE) + 1 ||
    source.url !== `${SC900_SOURCE_BASE_URL}${source.pageNumber}`)) {
    issue("SC900 question sources must use their exact five-question source page");
  }
  if (!unique(question.media.map((media) => media.id))) issue("Media IDs must be unique");
});

export const Sc900AnswerSchema = z.object({
  schemaVersion: z.literal(1),
  examId: z.literal(SC900_EXAM_ID),
  id: QuestionIdSchema,
  questionId: QuestionIdSchema,
  sourceRevision: Sha256Schema,
  originalAnswers: z.array(z.object({
    sourceOccurrenceId: Sc900OccurrenceIdSchema,
    value: AnswerValueSchema,
    explanation: Sc900RichContentSchema,
    answerAssetIds: ids(Sha256Schema),
    provenance: z.object({
      source: z.literal("examprepper"),
      url: Sc900SourcePageUrlSchema,
    }).strict(),
  }).strict()).nonempty(),
  effectiveAnswer: z.object({ value: AnswerValueSchema }).strict(),
  provisional: z.boolean(),
}).strict().superRefine((answers, context) => {
  for (const answer of answers.originalAnswers) {
    const number = Number(answer.sourceOccurrenceId.slice(-6));
    const page = Math.floor((number - 1) / SC900_SOURCE_PAGE_SIZE) + 1;
    if (answer.provenance.url !== `${SC900_SOURCE_BASE_URL}${page}`) {
      context.addIssue({ code: "custom", message: "SC900 original answer provenance must match its occurrence-derived source page" });
    }
  }
});

export const Sc900SummarySchema = z.object({
  id: QuestionIdSchema,
  number: Sc900SourceNumberSchema,
  kind: z.enum(["single-select", "multi-select", "manual"]),
  grading: z.enum(["automatic", "manual"]),
  provisional: z.boolean(),
  commentCount: z.number().int().nonnegative(),
  omittedCommentCount: z.literal(0),
  hasImages: z.boolean(),
  preview: z.string().max(4000),
  searchText: z.string().max(100000),
  sourceNumbers: ids(Sc900SourceNumberSchema).nonempty(),
  discussionEnabled: z.boolean(),
}).strict().refine((value) =>
  value.number === Math.min(...value.sourceNumbers) &&
  value.discussionEnabled === (value.commentCount > 0),
"Summary must represent its source numbers and discussion availability");

export const Sc900CatalogSchema = z.object({
  schemaVersion: z.literal(1),
  examId: z.literal(SC900_EXAM_ID),
  bankVersion: z.literal(SC900_BANK_VERSION),
  releaseId: Sc900ReleaseIdSchema,
  sourceRevision: Sha256Schema,
  discussionScope: Sc900DiscussionScopeSchema.optional(),
  counts: Sc900CountsSchema,
  questions: z.array(Sc900SummarySchema).nonempty(),
}).strict().superRefine((catalog, context) => {
  const numbers = catalog.questions.flatMap((question) => question.sourceNumbers);
  if (catalog.discussionScope && (catalog.counts.comments !== 0 || catalog.counts.duplicatesGrouped !== 0 ||
      catalog.questions.some((question) => question.discussionEnabled || question.sourceNumbers.length !== 1))) {
    context.addIssue({ code: "custom", message: "Scoped catalog must conserve each source separately and disclose unavailable threads" });
  }
  if (!unique(catalog.questions.map((question) => question.id)) || !unique(numbers) ||
      catalog.questions.length !== catalog.counts.questions ||
      numbers.length !== catalog.counts.sourceQuestions ||
      catalog.questions.filter((question) => question.grading === "automatic").length !== catalog.counts.automatic ||
      catalog.questions.reduce((total, question) => total + question.commentCount, 0) !== catalog.counts.comments) {
    context.addIssue({ code: "custom", message: "SC900 catalog counts and unique identities must reconcile" });
  }
});

export const Sc900DocumentSchema = z.object({
  schemaVersion: z.literal(1),
  examId: z.literal(SC900_EXAM_ID),
  releaseId: Sc900ReleaseIdSchema,
  question: Sc900QuestionSchema,
  answers: Sc900AnswerSchema,
  discussionEnabled: z.boolean(),
}).strict().superRefine(({ question, answers, discussionEnabled, releaseId }, context) => {
  const issue = (message: string) => context.addIssue({ code: "custom", message });
  if (answers.id !== question.id || answers.questionId !== question.id ||
      answers.sourceRevision !== question.sourceRevision) issue("Question and answer identities must agree");
  if (discussionEnabled !== (question.commentCount > 0)) issue("Discussion availability must match its count");
  const originals = answers.originalAnswers.map((answer) => answer.sourceOccurrenceId);
  if (!unique(originals) || originals.length !== question.sourceOccurrenceIds.length ||
      !originals.every((id) => question.sourceOccurrenceIds.includes(id))) {
    issue("Every SC900 source occurrence requires exactly one original answer");
  }
  for (const answer of answers.originalAnswers) {
    const source = question.sources.find((item) => item.questionNumber === Number(answer.sourceOccurrenceId.slice(-6)));
    if (!source || answer.provenance.url !== source.url) {
      issue("SC900 original answer provenance must match its corresponding question source");
    }
  }
  const options = new Set(question.options.map((option) => option.id));
  const values = [answers.effectiveAnswer.value, ...answers.originalAnswers.map((answer) => answer.value)];
  if (values.some((value) => value.kind === "option-selection" &&
      value.optionIds.some((id) => !options.has(id)))) issue("Answer references an unknown option");
  if (values.some((value) => value.kind === "option-selection" &&
      question.kind === "single-select" && value.optionIds.length !== 1)) {
    issue("Single-select answers require exactly one option");
  }
  if (question.readiness.grading === "automatic" && answers.effectiveAnswer.value.kind !== "option-selection") {
    issue("Automatic grading requires an option-selection answer");
  }
  const references = new Set([
    ...question.assetIds, ...richAssetIds(question.prompt),
    ...question.options.flatMap((option) => richAssetIds(option.content)),
    ...answers.originalAnswers.flatMap((answer) => [
      ...answer.answerAssetIds, ...richAssetIds(answer.explanation),
    ]),
    ...values.flatMap((value) => value.kind === "manual" ? value.sourceAnswerAssetIds : []),
  ]);
  if ([...references].some((id) => !question.media.some((media) => media.id === id))) {
    issue("Question and answer images must have complete local media metadata");
  }
  for (const media of question.media) {
    if (media.objectPath !== `published/sc900/${releaseId}/assets/${media.id}.${mediaExtension(media.contentType)}`) {
      issue("SC900 media path must match its release and hash");
    }
  }
});

export const Sc900CommentSchema = CommentSchema.extend({
  examId: z.literal(SC900_EXAM_ID),
  sourceOccurrenceId: Sc900OccurrenceIdSchema,
  body: Sc900RichContentSchema,
}).strict();

export const Sc900DiscussionSchema = z.object({
  schemaVersion: z.literal(1),
  examId: z.literal(SC900_EXAM_ID),
  releaseId: Sc900ReleaseIdSchema,
  questionId: QuestionIdSchema,
  discussionScope: Sc900DiscussionScopeSchema.optional(),
  comments: z.array(Sc900CommentSchema),
}).strict().superRefine((discussion, context) => {
  const byId = new Map(discussion.comments.map((comment) => [comment.id, comment]));
  const issue = () => context.addIssue({ code: "custom", message: "Invalid SC900 comment thread identity or ancestry" });
  if (discussion.discussionScope && discussion.comments.length) {
    context.addIssue({ code: "custom", message: "Unavailable discussions cannot claim any captured thread" });
  }
  if (byId.size !== discussion.comments.length) issue();
  for (const comment of discussion.comments) {
    const root = byId.get(comment.rootId);
    if (comment.questionId !== discussion.questionId || !root || root.parentId !== null ||
        root.rootId !== root.id || root.sourceOccurrenceId !== comment.sourceOccurrenceId) {
      issue();
      continue;
    }
    const seen = new Set([comment.id]);
    let current = comment;
    while (current.parentId !== null) {
      const parent = byId.get(current.parentId);
      if (!parent || seen.has(parent.id) || !parent.childIds.includes(current.id) ||
          parent.rootId !== comment.rootId || parent.sourceOccurrenceId !== comment.sourceOccurrenceId) {
        issue();
        break;
      }
      seen.add(parent.id);
      current = parent;
    }
    if (current.id !== root.id || comment.childIds.some((id) => byId.get(id)?.parentId !== comment.id)) issue();
  }
});

export function sc900FirestoreRoot(releaseId: string): string {
  return `studyBanks/sc900/releases/${Sc900ReleaseIdSchema.parse(releaseId)}`;
}

export function sc900SchemasForLedger(input: Sc900PublicationCaptureLedger) {
  const ledger = Sc900PublicationCaptureLedgerSchema.parse(input);
  const byNumber = new Map(ledger.occurrences.map((item) => [item.questionNumber, item]));
  const pages = new Map(ledger.pages.map((page) => [page.pageNumber, page]));
  const verifyQuestion = (question: Sc900Question, context: z.RefinementCtx) => {
    if (question.sources.some((source) =>
      byNumber.get(source.questionNumber)?.pageNumber !== source.pageNumber ||
      pages.get(source.pageNumber)?.url !== source.url)) {
      context.addIssue({ code: "custom", message: "SC900 source attribution is outside the verified capture ledger" });
    }
  };
  return {
    question: Sc900QuestionSchema.superRefine(verifyQuestion),
    document: Sc900DocumentSchema.superRefine((document, context) => verifyQuestion(document.question, context)),
    catalog: Sc900CatalogSchema.superRefine((catalog, context) => {
      const numbers = catalog.questions.flatMap((question) => question.sourceNumbers);
      if (numbers.length !== byNumber.size || numbers.some((number) => !byNumber.has(number))) {
        context.addIssue({ code: "custom", message: "SC900 catalog must cover the exact verified source numbers" });
      }
    }),
    manifest: Sc900ManifestSchema.superRefine((manifest, context) => {
      if (manifest.counts.sourceQuestions !== ledger.reported.questions ||
          manifest.counts.images !== ledger.assets.length ||
          manifest.counts.comments !== ledger.occurrences.reduce((total, item) => total + item.parsedCommentCount, 0) ||
          (ledger.schemaVersion === 2 ? manifest.discussionScope?.authorizationDigest !== ledger.authorizationDigest : Boolean(manifest.discussionScope))) {
        context.addIssue({ code: "custom", message: "SC900 manifest counts must match the complete verified capture ledger" });
      }
    }),
  };
}

export type Sc900Manifest = z.infer<typeof Sc900ManifestSchema>;
export type Sc900ReleasePointer = z.infer<typeof Sc900ReleasePointerSchema>;
export type Sc900Catalog = z.infer<typeof Sc900CatalogSchema>;
export type Sc900Document = z.infer<typeof Sc900DocumentSchema>;
export type Sc900Question = z.infer<typeof Sc900QuestionSchema>;
export type Sc900Answer = z.infer<typeof Sc900AnswerSchema>;
export type Sc900Discussion = z.infer<typeof Sc900DiscussionSchema>;
export type Sc900Comment = z.infer<typeof Sc900CommentSchema>;
export type Sc900Media = z.infer<typeof Sc900MediaSchema>;
