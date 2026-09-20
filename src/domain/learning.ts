import { z } from "zod";
import { OptionIdSchema, QuestionIdSchema, Sha256Schema } from "./schemas.js";

export const LearningStatusSchema = z.enum(["supported", "corrected", "conditional", "outdated", "incomplete"]);
const paragraph = z.string().trim().min(30).max(6000);
const officialUrl = z.string().url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password &&
    (url.hostname === "microsoft.com" || url.hostname.endsWith(".microsoft.com"));
}, "Use an actually consulted official Microsoft documentation URL.");

export const LearningExplanationSchema = z.object({
  schemaVersion: z.literal(1),
  questionId: QuestionIdSchema,
  questionSourceRevision: Sha256Schema,
  originalKeyDigest: Sha256Schema,
  status: LearningStatusSchema,
  concept: z.string().trim().min(5).max(160),
  summary: paragraph,
  reasoning: z.array(paragraph).min(2).max(12),
  correctOptionIds: z.array(OptionIdSchema).nullable(),
  options: z.array(z.object({
    optionId: OptionIdSchema,
    verdict: z.enum(["correct", "incorrect", "conditional", "unresolved"]),
    explanation: paragraph,
  }).strict()),
  answerParts: z.array(z.object({
    label: z.string().trim().min(1).max(500),
    answer: z.string().trim().min(1).max(1500),
    explanation: paragraph,
    alternatives: z.array(z.object({
      text: z.string().trim().min(1).max(1500),
      explanation: paragraph,
    }).strict()).max(30),
  }).strict()).max(30),
  takeaway: paragraph,
  caveat: paragraph.nullable(),
  sources: z.array(z.object({
    url: officialUrl,
    title: z.string().trim().min(5).max(250),
    supports: z.string().trim().min(20).max(600),
  }).strict()).min(1).max(8),
}).strict().superRefine((value, context) => {
  if (new Set(value.options.map((option) => option.optionId)).size !== value.options.length ||
      (value.correctOptionIds && new Set(value.correctOptionIds).size !== value.correctOptionIds.length)) {
    context.addIssue({ code: "custom", message: "Option IDs must be unique." });
  }
  if (["corrected", "conditional", "outdated", "incomplete"].includes(value.status) && !value.caveat) {
    context.addIssue({ code: "custom", message: "Uncertain and historical items need an explicit caveat." });
  }
  if (value.options.length && ["supported", "corrected"].includes(value.status) &&
      (!value.correctOptionIds?.length || value.options.some((option) =>
        (option.verdict === "correct") !== value.correctOptionIds!.includes(option.optionId)))) {
    context.addIssue({ code: "custom", message: "The explanation verdicts must match the verified choice IDs." });
  }
  if (!value.options.length && !value.answerParts.length) {
    context.addIssue({ code: "custom", message: "Image/manual items need step-by-step answer parts." });
  }
  if (new Set(value.sources.map((source) => source.url)).size !== value.sources.length) {
    context.addIssue({ code: "custom", message: "Use unique documentation sources." });
  }
});

export type LearningExplanation = z.infer<typeof LearningExplanationSchema>;

export const LearningManifestSchema = z.object({
  schemaVersion: z.literal(1),
  releaseId: z.string().regex(/^r_[a-f0-9]{64}$/),
  baseReleaseId: z.string().regex(/^r_[a-f0-9]{64}$/),
  sourceRevision: Sha256Schema,
  records: z.record(QuestionIdSchema, z.object({
    sha256: Sha256Schema,
    sourceRevisions: z.array(Sha256Schema).min(1),
  }).strict()),
}).strict().refine((value) => Object.keys(value.records).length === 606, "All question identities need explanations.");
export type LearningManifest = z.infer<typeof LearningManifestSchema>;

export const LearningDatasetSchema = z.object({
  schemaVersion: z.literal(1),
  releaseId: z.string().regex(/^r_[a-f0-9]{64}$/),
  baseReleaseId: z.string().regex(/^r_[a-f0-9]{64}$/),
  sourceRevision: Sha256Schema,
  explanations: z.array(LearningExplanationSchema).length(606),
}).strict().refine((value) => new Set(value.explanations.map((item) => item.questionId)).size === 606);
export type LearningDataset = z.infer<typeof LearningDatasetSchema>;

export const StudyReleasePointerSchema = z.object({
  schemaVersion: z.literal(1),
  releaseId: z.string().regex(/^r_[a-f0-9]{64}$/),
  sourceRevision: Sha256Schema,
}).strict();
