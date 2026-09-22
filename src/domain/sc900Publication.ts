import { z } from "zod";
import { QuestionIdSchema, Sha256Schema, TimestampSchema } from "./schemas.js";
import { SC900_BANK_VERSION, Sc900ReleaseIdSchema } from "./sc900Bank.js";
import { Sc900CaptureLedgerSchema, Sc900PageNumberSchema, Sc900SourceNumberSchema } from "./sc900Capture.js";

export const Sc900ExpectedCaptureSchema = z.object({
  questions: Sc900SourceNumberSchema,
  pages: Sc900PageNumberSchema,
  receiptSha256: Sha256Schema,
}).strict();

export const Sc900ReviewTargetSchema = z.object({
  questionId: QuestionIdSchema,
  documentHash: Sha256Schema,
  discussionHash: Sha256Schema,
  learningHash: Sha256Schema,
  topicsHash: Sha256Schema,
  relevanceHash: Sha256Schema,
}).strict();

export const Sc900PublicationReviewSchema = z.object({
  schemaVersion: z.literal(1),
  examId: z.literal("sc900"),
  releaseId: Sc900ReleaseIdSchema,
  sourceRevision: Sha256Schema,
  captureLedgerDigest: Sha256Schema,
  reviewer: z.string().trim().min(1).max(200),
  reviewedAt: TimestampSchema,
  decision: z.literal("approved"),
  checks: z.object({
    allPages: z.literal(true),
    allAnswers: z.literal(true),
    allComments: z.literal(true),
    allAssets: z.literal(true),
    topics: z.literal(true),
    learning: z.literal(true),
    relevance: z.literal(true),
  }).strict(),
  questions: z.array(Sc900ReviewTargetSchema).nonempty(),
}).strict().refine((value) =>
  new Set(value.questions.map((question) => question.questionId)).size === value.questions.length,
"Every SC900 canonical question requires exactly one complete review");

export const Sc900FinalReviewSchema = z.object({
  schemaVersion: z.literal(1),
  examId: z.literal("sc900"),
  releaseId: Sc900ReleaseIdSchema,
  planDigest: Sha256Schema,
  reviewDigest: Sha256Schema,
  reviewer: z.string().trim().min(1).max(200),
  reviewedAt: TimestampSchema,
  independent: z.literal(true),
  decision: z.literal("approve-activation"),
}).strict();

export const Sc900PublicationProofSchema = z.object({
  schemaVersion: z.literal(1),
  examId: z.literal("sc900"),
  expectedCapture: Sc900ExpectedCaptureSchema,
  ledger: Sc900CaptureLedgerSchema,
  review: Sc900PublicationReviewSchema,
}).strict();

export const Sc900ApprovalReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  examId: z.literal("sc900"),
  bankVersion: z.literal(SC900_BANK_VERSION),
  releaseId: Sc900ReleaseIdSchema,
  sourceRevision: Sha256Schema,
  captureLedgerDigest: Sha256Schema,
  planDigest: Sha256Schema,
  reviewDigest: Sha256Schema,
  fileCount: z.number().int().positive(),
  totalBytes: z.number().int().positive(),
  activate: z.boolean(),
  finalReview: Sc900FinalReviewSchema.nullable(),
}).strict().superRefine((receipt, context) => {
  if (receipt.activate !== (receipt.finalReview !== null) ||
      (receipt.finalReview && (receipt.finalReview.releaseId !== receipt.releaseId ||
        receipt.finalReview.planDigest !== receipt.planDigest ||
        receipt.finalReview.reviewDigest !== receipt.reviewDigest))) {
    context.addIssue({ code: "custom", message: "Activation requires independent final review of these exact bytes and full review" });
  }
});

export type Sc900ReviewTarget = z.infer<typeof Sc900ReviewTargetSchema>;
export type Sc900ExpectedCapture = z.infer<typeof Sc900ExpectedCaptureSchema>;
export type Sc900PublicationReview = z.infer<typeof Sc900PublicationReviewSchema>;
export type Sc900FinalReview = z.infer<typeof Sc900FinalReviewSchema>;
export type Sc900ApprovalReceipt = z.infer<typeof Sc900ApprovalReceiptSchema>;
