import { z } from "zod";
import { CleanCountsSchema } from "./cleanBank.js";
import { RetirementSchema } from "./eligibility.js";
import { QuestionIdSchema, Sha256Schema } from "./schemas.js";
import { SC900_BANK_VERSION, Sc900ReleaseIdSchema } from "./sc900Bank.js";
import { Sc900SourceNumberSchema } from "./sc900Capture.js";

const uniqueIds = z.array(QuestionIdSchema).refine((ids) => new Set(ids).size === ids.length,
"SC900 question IDs must be unique");
export const Sc900RetirementSchema = RetirementSchema.extend({
  examId: z.literal("sc900"),
  category: z.enum(["retired-feature", "changed-assumptions", "defective-question", "out-of-scope"]),
  number: Sc900SourceNumberSchema,
  sourceNumbers: z.array(Sc900SourceNumberSchema).nonempty(),
}).strict().refine((value) =>
  new Set(value.sourceNumbers).size === value.sourceNumbers.length && value.sourceNumbers.includes(value.number),
"Retired SC900 source numbers must be unique and include the representative number");

export const Sc900EligibilityPolicySchema = z.object({
  schemaVersion: z.literal(1),
  examId: z.literal("sc900"),
  bankVersion: z.literal(SC900_BANK_VERSION),
  policyId: z.string().regex(/^e_[a-f0-9]{64}$/),
  releaseId: Sc900ReleaseIdSchema,
  teachingReleaseId: Sc900ReleaseIdSchema,
  sourceRevision: Sha256Schema,
  reviewedAt: z.string().date(),
  reviewedQuestionIds: uniqueIds.nonempty(),
  activeQuestionIds: uniqueIds,
  activeCounts: CleanCountsSchema,
  retired: z.array(Sc900RetirementSchema),
}).strict().superRefine((policy, context) => {
  const reviewed = new Set(policy.reviewedQuestionIds);
  const active = new Set(policy.activeQuestionIds);
  const retired = new Set(policy.retired.map((item) => item.questionId));
  const retiredNumbers = policy.retired.flatMap((item) => item.sourceNumbers);
  if (retired.size !== policy.retired.length || active.size + retired.size !== reviewed.size ||
      [...active].some((id) => !reviewed.has(id) || retired.has(id)) ||
      [...retired].some((id) => !reviewed.has(id)) ||
      new Set(retiredNumbers).size !== retiredNumbers.length ||
      policy.activeCounts.questions !== active.size ||
      policy.activeCounts.sourceQuestions === undefined || policy.activeCounts.duplicatesGrouped === undefined) {
    context.addIssue({ code: "custom", message: "SC900 active and retired questions must partition the reviewed bank" });
  }
});

export type Sc900EligibilityPolicy = z.infer<typeof Sc900EligibilityPolicySchema>;
export type Sc900Retirement = z.infer<typeof Sc900RetirementSchema>;
