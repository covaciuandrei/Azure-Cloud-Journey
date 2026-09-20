import { z } from "zod";
import {
  OptionIdSchema,
  QuestionIdSchema,
  Sha256Schema,
} from "./schemas.js";
import { ReleaseIdSchema } from "./study.js";

export const DuplicateOptionMappingSchema = z.object({
  duplicateOptionId: OptionIdSchema,
  primaryOptionId: OptionIdSchema,
}).strict();

export const DuplicateEvidenceSchema = z.object({
  kind: z.enum([
    "normalized-text",
    "option-equivalence",
    "answer-equivalence",
    "image-equivalence",
    "manual-review",
  ]),
  detail: z.string().min(1),
}).strict();

export const DuplicateGroupSchema = z.object({
  primaryCanonicalQuestionId: QuestionIdSchema,
  duplicateQuestionIds: z.array(QuestionIdSchema).min(1),
  sourceQuestionNumbers: z.array(z.object({
    questionId: QuestionIdSchema,
    numbers: z.array(z.number().int().min(1).max(606)).min(1),
  }).strict()).min(2),
  questionRevisions: z.record(QuestionIdSchema, Sha256Schema),
  optionMappings: z.record(
    QuestionIdSchema,
    z.array(DuplicateOptionMappingSchema),
  ),
  evidence: z.array(DuplicateEvidenceSchema).min(1),
  reason: z.string().min(1),
}).strict();

export const DuplicateDecisionsSchema = z.object({
  schemaVersion: z.literal(1),
  sourceRevision: Sha256Schema,
  baseReleaseId: ReleaseIdSchema,
  reviewedAt: z.iso.datetime({ offset: true }),
  reviewedBy: z.string().min(1),
  candidateGenerationVersion: z.string().min(1),
  groups: z.array(DuplicateGroupSchema),
}).strict();

export type DuplicateGroup = z.infer<typeof DuplicateGroupSchema>;
export type DuplicateDecisions = z.infer<typeof DuplicateDecisionsSchema>;
