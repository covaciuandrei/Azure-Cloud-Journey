import { z } from "zod";
import { LearningExplanationSchema } from "./learning.js";
import { QuestionIdSchema, Sha256Schema } from "./schemas.js";
import { SC900_BANK_VERSION, Sc900ReleaseIdSchema } from "./sc900Bank.js";

export const Sc900LearningExplanationSchema = LearningExplanationSchema.safeExtend({
  examId: z.literal("sc900"),
});
export const Sc900LearningManifestSchema = z.object({
  schemaVersion: z.literal(1),
  examId: z.literal("sc900"),
  bankVersion: z.literal(SC900_BANK_VERSION),
  releaseId: Sc900ReleaseIdSchema,
  baseReleaseId: Sc900ReleaseIdSchema,
  sourceRevision: Sha256Schema,
  questionCount: z.number().int().positive(),
  records: z.record(QuestionIdSchema, z.object({
    sha256: Sha256Schema,
    sourceRevisions: z.array(Sha256Schema).nonempty()
      .refine((items) => new Set(items).size === items.length, "Source revisions must be unique"),
  }).strict()),
}).strict().refine((value) => Object.keys(value.records).length === value.questionCount,
"SC900 learning manifest must cover its declared canonical question count");

export const Sc900LearningDatasetSchema = z.object({
  schemaVersion: z.literal(1),
  examId: z.literal("sc900"),
  bankVersion: z.literal(SC900_BANK_VERSION),
  releaseId: Sc900ReleaseIdSchema,
  baseReleaseId: Sc900ReleaseIdSchema,
  sourceRevision: Sha256Schema,
  explanations: z.array(Sc900LearningExplanationSchema).nonempty(),
}).strict().refine((value) =>
  new Set(value.explanations.map((item) => item.questionId)).size === value.explanations.length,
"SC900 learning explanations require unique question identities");

export { Sc900ReleasePointerSchema as Sc900StudyReleasePointerSchema } from "./sc900Bank.js";

export type Sc900LearningExplanation = z.infer<typeof Sc900LearningExplanationSchema>;
export type Sc900LearningManifest = z.infer<typeof Sc900LearningManifestSchema>;
export type Sc900LearningDataset = z.infer<typeof Sc900LearningDatasetSchema>;
