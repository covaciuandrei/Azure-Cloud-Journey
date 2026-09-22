import { z } from "zod";
import { Sha256Schema, TimestampSchema } from "./schemas.js";
import {
  Sc900CaptureLedgerSchema, Sc900CaptureAssetSchema, Sc900OccurrenceIdSchema,
  Sc900PageNumberSchema, Sc900SourceNumberSchema, SC900_SOURCE_PAGE_SIZE, sc900SourcePageUrl,
} from "./sc900Capture.js";

export const SC900_UNAVAILABLE_DISCUSSIONS_NOTICE =
  "Source discussions unavailable; answers reviewed against Microsoft documentation";

export const Sc900QuestionsOnlyAuthorizationSchema = z.object({
  schemaVersion: z.literal(1), examId: z.literal("sc900"),
  scope: z.literal("questions-answers-media"),
  decision: z.literal("authorize-publication-without-source-discussions"),
  authorizedBy: z.literal("owner"), authorizedAt: TimestampSchema,
  authorizationText: z.string().trim().min(20).max(8000),
  sourceScopeReceiptSha256: Sha256Schema, rawPageInventoryDigest: Sha256Schema,
  assetInventoryDigest: Sha256Schema,
  questions: Sc900SourceNumberSchema, pages: Sc900PageNumberSchema,
  images: z.number().int().nonnegative(),
}).strict().refine((value) => value.pages === Math.ceil(value.questions / SC900_SOURCE_PAGE_SIZE),
"Authorized scope must use the verified source page allocation");

export const Sc900ScopedCaptureLedgerSchema = z.object({
  ...Sc900CaptureLedgerSchema.shape,
  schemaVersion: z.literal(2), scope: z.literal("questions-answers-media"),
  authorizationDigest: Sha256Schema, sourceScopeReceiptSha256: Sha256Schema,
  rawPageInventoryDigest: Sha256Schema, assetInventoryDigest: Sha256Schema,
  sourceCommentCount: z.null(),
  occurrences: z.array(z.object({
    id: Sc900OccurrenceIdSchema, questionNumber: Sc900SourceNumberSchema, pageNumber: Sc900PageNumberSchema,
    answerRevealed: z.literal(true), discussionState: z.literal("unavailable"),
    discussionDisposition: z.literal("omitted-owner-authorized"), sourceCommentCount: z.null(),
    parsedCommentCount: z.literal(0), commentIds: z.array(z.never()).length(0),
    assetIds: z.array(Sha256Schema).refine((ids) => new Set(ids).size === ids.length),
  }).strict()).nonempty(),
  assets: z.array(Sc900CaptureAssetSchema),
}).strict().superRefine((ledger, context) => {
  const issue = (message: string) => context.addIssue({ code: "custom", message });
  const pages = new Map(ledger.pages.map((page) => [page.pageNumber, page]));
  const numbers = new Set(ledger.occurrences.map((item) => item.questionNumber));
  const pageNumbers = ledger.pages.flatMap((page) => page.questionNumbers);
  if (numbers.size !== ledger.occurrences.length || numbers.size !== ledger.reported.questions ||
      [...numbers].some((number) => number > ledger.reported.questions) ||
      pages.size !== ledger.pages.length || pages.size !== ledger.reported.pages ||
      ledger.reported.pages !== Math.ceil(ledger.reported.questions / SC900_SOURCE_PAGE_SIZE) ||
      [...pages.keys()].some((number) => number > ledger.reported.pages) ||
      new Set(pageNumbers).size !== pageNumbers.length || pageNumbers.length !== numbers.size ||
      pageNumbers.some((number) => !numbers.has(number))) {
    issue("Scoped capture must retain every reported source question and page exactly once");
  }
  for (const page of ledger.pages) {
    if (page.url !== sc900SourcePageUrl(page.pageNumber) ||
        page.questionNumbers.some((number) => Math.floor((number - 1) / SC900_SOURCE_PAGE_SIZE) + 1 !== page.pageNumber)) {
      issue("Scoped source page URL or question attribution is invalid");
    }
  }
  for (const occurrence of ledger.occurrences) {
    if (occurrence.id !== `examprepper-128-q${String(occurrence.questionNumber).padStart(6, "0")}` ||
        occurrence.pageNumber !== Math.floor((occurrence.questionNumber - 1) / SC900_SOURCE_PAGE_SIZE) + 1 ||
        !pages.get(occurrence.pageNumber)?.questionNumbers.includes(occurrence.questionNumber)) {
      issue("Scoped source occurrence attribution is incomplete");
    }
  }
  const assets = new Set(ledger.assets.map((asset) => asset.id));
  const references = new Set(ledger.occurrences.flatMap((item) => item.assetIds));
  if (assets.size !== ledger.assets.length || assets.size !== references.size ||
      [...references].some((id) => !assets.has(id))) issue("Scoped capture must conserve every original asset");
});

export const Sc900PublicationCaptureLedgerSchema = z.union([Sc900CaptureLedgerSchema, Sc900ScopedCaptureLedgerSchema]);
export const Sc900DiscussionScopeSchema = z.object({
  scope: z.literal("questions-answers-media"), authorizationDigest: Sha256Schema,
  sourceCommentCount: z.null(), storedCommentCount: z.literal(0),
  discussionState: z.literal("unavailable"), discussionDisposition: z.literal("omitted-owner-authorized"),
}).strict();
export type Sc900QuestionsOnlyAuthorization = z.infer<typeof Sc900QuestionsOnlyAuthorizationSchema>;
export type Sc900ScopedCaptureLedger = z.infer<typeof Sc900ScopedCaptureLedgerSchema>;
export type Sc900PublicationCaptureLedger = z.infer<typeof Sc900PublicationCaptureLedgerSchema>;
export type Sc900DiscussionScope = z.infer<typeof Sc900DiscussionScopeSchema>;
