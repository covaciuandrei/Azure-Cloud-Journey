import { z } from "zod";
import { CommentIdSchema, Sha256Schema, TimestampSchema } from "./schemas.js";

export const SC900_EXAM_ID = "sc900" as const;
export const SC900_SOURCE_EXAM_ID = "128" as const;
export const SC900_SOURCE_BASE_URL = "https://www.examprepper.co/exam/128/" as const;
export const SC900_SOURCE_URL = "https://www.examprepper.co/exam/128/1" as const;
export const SC900_SOURCE_PAGE_SIZE = 5;
export const SC900_MAX_SOURCE_NUMBER = 999999;
export const SC900_MAX_SOURCE_PAGE = Math.ceil(SC900_MAX_SOURCE_NUMBER / SC900_SOURCE_PAGE_SIZE);
export const Sc900OccurrenceIdSchema = z.string().regex(/^examprepper-128-q\d{6}$/)
  .refine((value) => Number(value.slice(-6)) > 0, "SC900 source occurrence numbers must be positive");
export const Sc900SourceNumberSchema = z.number().int().min(1).max(SC900_MAX_SOURCE_NUMBER);
export const Sc900PageNumberSchema = z.number().int().min(1).max(SC900_MAX_SOURCE_PAGE);
export const Sc900SourcePageUrlSchema = z.string().refine((value) => {
  const page = value.slice(SC900_SOURCE_BASE_URL.length);
  return value.startsWith(SC900_SOURCE_BASE_URL) && /^[1-9]\d*$/.test(page) &&
    Sc900PageNumberSchema.safeParse(Number(page)).success;
}, "Expected the exact SC900 HTTPS source URL with a bounded positive page number");
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
  sourceUrl: z.literal(SC900_SOURCE_URL),
  capturedAt: TimestampSchema,
  reported: z.object({
    questions: Sc900SourceNumberSchema,
    pages: Sc900PageNumberSchema,
  }).strict(),
  pages: z.array(z.object({
    pageNumber: Sc900PageNumberSchema,
    url: Sc900SourcePageUrlSchema,
    rawSha256: Sha256Schema,
    questionNumbers: ids(Sc900SourceNumberSchema).nonempty().max(SC900_SOURCE_PAGE_SIZE),
  }).strict()).nonempty(),
  occurrences: z.array(z.object({
    id: Sc900OccurrenceIdSchema,
    questionNumber: Sc900SourceNumberSchema,
    pageNumber: Sc900PageNumberSchema,
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
  if (ledger.pages.some((page) => page.url !== `${SC900_SOURCE_BASE_URL}${page.pageNumber}` ||
      page.questionNumbers.some((number) => Math.floor((number - 1) / SC900_SOURCE_PAGE_SIZE) + 1 !== page.pageNumber))) {
    issue("SC900 capture pages must match the exact source URL and five-question page attribution");
  }
  if (!unique(numbers) || numbers.length !== ledger.reported.questions ||
      numbers.some((number) => number > ledger.reported.questions) ||
      ledger.reported.pages !== Math.ceil(ledger.reported.questions / SC900_SOURCE_PAGE_SIZE) ||
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
    if (occurrence.id !== `examprepper-128-q${String(occurrence.questionNumber).padStart(6, "0")}` ||
        occurrence.pageNumber !== Math.floor((occurrence.questionNumber - 1) / SC900_SOURCE_PAGE_SIZE) + 1 ||
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

export function sc900SourcePageUrl(pageNumber: number): string {
  Sc900PageNumberSchema.parse(pageNumber);
  return `${SC900_SOURCE_BASE_URL}${pageNumber}`;
}

export function assertSc900SourceNumber(number: number, ledger: Sc900CaptureLedger): void {
  if (!ledger.occurrences.some((item) => item.questionNumber === number)) {
    throw new Error(`SC900 source question ${number} is outside the verified capture ledger`);
  }
}
