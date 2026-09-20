import { z } from "zod";
import { CleanCountsSchema, CleanReleaseIdSchema } from "./cleanBank.js";
import { QuestionIdSchema, Sha256Schema } from "./schemas.js";

export const EligibilityIdSchema = z.string().regex(/^e_[a-f0-9]{64}$/);
export const RetirementSchema = z.object({
  questionId: QuestionIdSchema,
  number: z.number().int().min(1).max(606),
  sourceNumbers: z.array(z.number().int().min(1).max(606)).nonempty(),
  category: z.enum(["retired-feature", "changed-assumptions", "defective-question"]),
  reason: z.string().min(40).max(4000),
  sources: z.array(z.object({
    url: z.string().url().refine((value) => {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password &&
        (url.hostname === "microsoft.com" || url.hostname.endsWith(".microsoft.com"));
    }),
    title: z.string().min(5),
    supports: z.string().min(20),
  }).strict()).min(1).max(8),
}).strict();
export type Retirement = z.infer<typeof RetirementSchema>;

export const EligibilityPolicySchema = z.object({
  schemaVersion: z.literal(1),
  policyId: EligibilityIdSchema,
  releaseId: CleanReleaseIdSchema,
  teachingReleaseId: CleanReleaseIdSchema,
  sourceRevision: Sha256Schema,
  reviewedAt: z.string().date(),
  reviewedQuestionIds: z.array(QuestionIdSchema).length(604),
  activeQuestionIds: z.array(QuestionIdSchema).min(40).max(604),
  activeCounts: CleanCountsSchema,
  retired: z.array(RetirementSchema).max(564),
}).strict().superRefine((policy, context) => {
  const reviewed = new Set(policy.reviewedQuestionIds);
  const active = new Set(policy.activeQuestionIds);
  const retired = new Set(policy.retired.map((item) => item.questionId));
  const retiredNumbers = policy.retired.flatMap((item) => item.sourceNumbers);
  if (reviewed.size !== 604 || active.size !== policy.activeQuestionIds.length ||
      retired.size !== policy.retired.length || active.size + retired.size !== reviewed.size ||
      [...active].some((id) => !reviewed.has(id) || retired.has(id)) ||
      [...retired].some((id) => !reviewed.has(id)) ||
      new Set(retiredNumbers).size !== retiredNumbers.length ||
      policy.retired.some((item) => !item.sourceNumbers.includes(item.number)) ||
      policy.activeCounts.questions !== active.size ||
      policy.activeCounts.sourceQuestions !== 606 - retiredNumbers.length) {
    context.addIssue({ code: "custom", message: "Active and retired identities must partition the complete reviewed bank." });
  }
});
export type EligibilityPolicy = z.infer<typeof EligibilityPolicySchema>;

export function retirementFor(
  policy: EligibilityPolicy,
  question: { id: string; sources: Array<{ questionNumber: number }> },
): Retirement | undefined {
  return policy.retired.find((item) => item.questionId === question.id ||
    question.sources.some((source) => item.sourceNumbers.includes(source.questionNumber)));
}
