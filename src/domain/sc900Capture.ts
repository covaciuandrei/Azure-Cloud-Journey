import { z } from "zod";
import { CommentIdSchema, SafeUrlSchema, Sha256Schema, TimestampSchema } from "./schemas.js";

export const SC900_EXAM_ID = "sc900" as const;
export const SC900_SOURCE_EXAM_ID = "128" as const;
export const Sc900OccurrenceIdSchema = z.string().regex(/^examprepper-128-q\d{6}$/);
export const Sc900SourceNumberSchema = z.number().int().min(1).max(999999);
const unique = <T>(items: T[]) => new Set(items).size === items.length;
const ids = <T extends z.ZodType>(schema: T) => z.array(schema).refine(unique, "IDs must be unique");

export const Sc900CaptureAssetSchema = z.object({
  id: Sha256Schema,
  contentType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  byteLength: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
}).strict();

export const Sc900CaptureLedgerSchema = z.object({
  schemaVersion: z.literal(1),
  examId: z.literal(SC900_EXAM_ID),
  sourceExamId: z.literal(SC900_SOURCE_EXAM_ID),
  captureMethod: z.literal("rendered-browser-ui"),
  verified: z.literal(true),
  sourceUrl: SafeUrlSchema,
  capturedAt: TimestampSchema,
  reported: z.object({
    questions: Sc900SourceNumberSchema,
    pages: z.number().int().positive().max(999999),
  }).strict(),
  pages: z.array(z.object({
    pageNumber: z.number().int().positive(),
    url: SafeUrlSchema,
    rawSha256: Sha256Schema,
    questionNumbers: ids(Sc900SourceNumberSchema).nonempty(),
  }).strict()).nonempty(),
  occurrences: z.array(z.object({
    id: Sc900OccurrenceIdSchema,
    questionNumber: Sc900SourceNumberSchema,
    pageNumber: z.number().int().positive(),
    answerRevealed: z.literal(true),
    discussionState: z.literal("loaded"),
    expectedCommentCount: z.number().int().nonnegative(),
    parsedCommentCount: z.number().int().nonnegative(),
    commentIds: ids(CommentIdSchema),
    assetIds: ids(Sha256Schema),
  }).strict()).nonempty(),
  assets: z.array(Sc900CaptureAssetSchema),
}).strict().superRefine((ledger, context) => {
  const issue = (message: string) => context.addIssue({ code: "custom", message });
  const numbers = ledger.occurrences.map((item) => item.questionNumber);
  const pages = ledger.pages.map((page) => page.pageNumber);
  const pageNumbers = ledger.pages.flatMap((page) => page.questionNumbers);
  if (!unique(numbers) || numbers.length !== ledger.reported.questions ||
      numbers.some((number) => number > ledger.reported.questions) ||
      !unique(pages) || pages.length !== ledger.reported.pages ||
      pages.some((page) => page > ledger.reported.pages) ||
      !unique(pageNumbers) || pageNumbers.length !== numbers.length ||
      pageNumbers.some((number) => !numbers.includes(number))) {
    issue("Verified capture must cover every reported question and page exactly once");
  }
  const assets = new Set(ledger.assets.map((asset) => asset.id));
  const referencedAssets = new Set(ledger.occurrences.flatMap((item) => item.assetIds));
  if (assets.size !== ledger.assets.length || assets.size !== referencedAssets.size ||
      [...referencedAssets].some((id) => !assets.has(id))) {
    issue("Capture asset inventory must match every captured asset reference");
  }
  const comments = ledger.occurrences.flatMap((item) => item.commentIds);
  if (!unique(comments)) issue("Captured comment IDs must be globally unique");
  for (const occurrence of ledger.occurrences) {
    if (occurrence.id !== sc900OccurrenceId(occurrence.questionNumber) ||
        !ledger.pages.find((page) => page.pageNumber === occurrence.pageNumber)
          ?.questionNumbers.includes(occurrence.questionNumber) ||
        occurrence.expectedCommentCount !== occurrence.parsedCommentCount ||
        occurrence.commentIds.length !== occurrence.parsedCommentCount) {
      issue("Capture occurrence attribution, answer or loaded discussion evidence is incomplete");
    }
  }
});

export type Sc900CaptureLedger = z.infer<typeof Sc900CaptureLedgerSchema>;
export type Sc900CaptureAsset = z.infer<typeof Sc900CaptureAssetSchema>;

export function sc900OccurrenceId(questionNumber: number): string {
  Sc900SourceNumberSchema.parse(questionNumber);
  return `examprepper-128-q${String(questionNumber).padStart(6, "0")}`;
}

export function assertSc900SourceNumber(number: number, ledger: Sc900CaptureLedger): void {
  if (!ledger.occurrences.some((item) => item.questionNumber === number)) {
    throw new Error(`SC900 source question ${number} is outside the verified capture ledger`);
  }
}
