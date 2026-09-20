import { z } from "zod";
import { EligibilityPolicySchema, RetirementSchema } from "../../src/domain/eligibility.js";
import { QuestionIdSchema } from "../../src/domain/schemas.js";
import { digest } from "../ingest/normalize-shared.js";
import { readData, writeData } from "../review/data.js";
import { readTopicMap } from "../topics/data.js";
import { loadStudyPublication } from "../learning/publication.js";
import { activeCounts, eligibilityIdentity } from "./policy.js";

const scopes = {
  identity: ["entra-users-groups", "access-rbac", "governance"],
  storage: ["storage-access", "storage-accounts", "files-blobs"],
  compute: ["arm-bicep", "virtual-machines", "containers", "app-service"],
  networking: ["virtual-networks", "network-security", "dns-load-balancing"],
  operations: ["monitoring", "backup-recovery"],
};
const ReviewSchema = z.object({
  scope: z.enum(["identity", "storage", "compute", "networking", "operations"]),
  reviewedQuestionIds: z.array(QuestionIdSchema),
  retirements: z.array(RetirementSchema.omit({ sourceNumbers: true })),
  retainedFlagged: z.array(z.object({
    questionId: QuestionIdSchema, number: z.number().int(), reason: z.string().min(20),
  }).strict()),
}).strict();
const publication = await loadStudyPublication();
const base = publication.releases.find((release) => release.catalog.releaseId === publication.learning.releaseId)!;
const topics = await readTopicMap();
const approvals = await readData(".data/eligibility/approved-review-digests.json", z.array(z.object({
  scope: ReviewSchema.shape.scope, digest: z.string().regex(/^[a-f0-9]{64}$/), note: z.string().min(20),
}).strict()).length(5));
if (new Set(approvals.map((approval) => approval.scope)).size !== 5) throw new Error("Each relevance review needs its own approval.");
const reviewedQuestionIds: string[] = [];
const retired: z.infer<typeof RetirementSchema>[] = [];
for (const [scope, assignedTopics] of Object.entries(scopes)) {
  const review = await readData(`.data/eligibility/reviews/${scope}.json`, ReviewSchema);
  if (review.scope !== scope || approvals.find((approval) => approval.scope === scope)?.digest !== digest(review)) {
    throw new Error(`${scope}: relevance decisions require parent approval of these exact bytes.`);
  }
  const expected = base.documents.filter((document) =>
    assignedTopics.includes(topics.assignments[document.question.id]![0]!));
  const reviewed = new Set(review.reviewedQuestionIds);
  if (reviewed.size !== review.reviewedQuestionIds.length || reviewed.size !== expected.length ||
      expected.some((document) => !reviewed.has(document.question.id))) throw new Error(`${scope}: incomplete review coverage.`);
  reviewedQuestionIds.push(...review.reviewedQuestionIds);
  for (const entry of [...review.retirements, ...review.retainedFlagged]) {
    const document = expected.find((document) => document.question.id === entry.questionId);
    if (!document || document.question.sources[0]!.questionNumber !== entry.number) throw new Error("Unknown review question.");
  }
  if (new Set(review.retirements.map((entry) => entry.questionId)).size !== review.retirements.length ||
      review.retainedFlagged.some((entry) => review.retirements.some((retirement) => retirement.questionId === entry.questionId))) {
    throw new Error("A question cannot be both retained and retired.");
  }
  retired.push(...review.retirements.map((entry) => ({
    ...entry, sourceNumbers: expected.find((document) => document.question.id === entry.questionId)!
      .question.sources.map((source) => source.questionNumber).sort((a, b) => a - b),
  })));
}
if (!retired.some((entry) => entry.number === 430)) throw new Error("The reported Container Apps question must be retired.");
const excluded = new Set(retired.map((entry) => entry.questionId));
const activeQuestionIds = base.documents.map((document) => document.question.id).filter((id) => !excluded.has(id)).sort();
const content = {
  schemaVersion: 1 as const, teachingReleaseId: base.catalog.releaseId, sourceRevision: base.catalog.sourceRevision,
  reviewedAt: new Date().toISOString().slice(0, 10),
  reviewedQuestionIds: reviewedQuestionIds.sort(), activeQuestionIds,
  activeCounts: activeCounts(base, new Set(activeQuestionIds)),
  retired: retired.sort((a, b) => a.number - b.number),
};
const policy = EligibilityPolicySchema.parse({ ...content, ...eligibilityIdentity(content) });
await writeData(`.data/eligibility/releases/${policy.policyId}.json`, policy);
await writeData(".data/eligibility/current.json", { policyId: policy.policyId });
console.log(JSON.stringify({ policyId: policy.policyId, releaseId: policy.releaseId,
  retired: policy.retired.length, active: policy.activeCounts }, null, 2));
