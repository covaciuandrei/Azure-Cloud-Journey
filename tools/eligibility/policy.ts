import {
  CleanCatalogSchema, CleanDiscussionSchema, CleanDocumentSchema, type CleanCountsSchema,
} from "../../src/domain/cleanBank.js";
import type { z } from "zod";
import type { EligibilityPolicy } from "../../src/domain/eligibility.js";
import type { CleanRelease } from "../web/bank.js";
import { digest } from "../ingest/normalize-shared.js";

export function activeCounts(base: CleanRelease, activeIds: ReadonlySet<string>): z.infer<typeof CleanCountsSchema> {
  const documents = base.documents.filter((document) => activeIds.has(document.question.id));
  const summaries = base.catalog.questions.filter((question) => activeIds.has(question.id));
  const sourceQuestions = documents.reduce((sum, document) => sum + document.question.sources.length, 0);
  const automatic = documents.filter((document) => document.question.readiness.grading === "automatic").length;
  return {
    questions: documents.length,
    comments: documents.reduce((sum, document) => sum + document.question.commentCount, 0),
    images: new Set(documents.flatMap((document) => document.question.media.map((media) => media.id))).size,
    automatic, manual: documents.length - automatic,
    omittedComments: summaries.reduce((sum, summary) => sum + summary.omittedCommentCount, 0),
    sourceQuestions, duplicatesGrouped: sourceQuestions - documents.length,
  };
}

export function eligibilityIdentity(policy: Omit<EligibilityPolicy, "policyId" | "releaseId">) {
  const policyId = `e_${digest(policy)}`;
  return { policyId, releaseId: `r_${digest({ teachingReleaseId: policy.teachingReleaseId, policyId })}` };
}

export function materializeEligibleRelease(base: CleanRelease, policy: EligibilityPolicy): CleanRelease {
  const { policyId, releaseId, ...content } = policy;
  const expectedIdentity = eligibilityIdentity(content);
  if (policyId !== expectedIdentity.policyId || releaseId !== expectedIdentity.releaseId ||
      base.catalog.releaseId !== policy.teachingReleaseId || base.catalog.sourceRevision !== policy.sourceRevision) {
    throw new Error("Eligibility decisions do not match this teaching release.");
  }
  const reviewed = new Set(policy.reviewedQuestionIds);
  if (base.documents.length !== reviewed.size || base.documents.some((document) => !reviewed.has(document.question.id))) {
    throw new Error("Eligibility review does not cover the complete source bank.");
  }
  for (const retired of policy.retired) {
    const document = base.documents.find((entry) => entry.question.id === retired.questionId)!;
    const numbers = document.question.sources.map((source) => source.questionNumber).sort((a, b) => a - b);
    if (JSON.stringify(numbers) !== JSON.stringify([...retired.sourceNumbers].sort((a, b) => a - b))) {
      throw new Error("A retirement decision references different source occurrences.");
    }
  }
  const active = new Set(policy.activeQuestionIds);
  const counts = activeCounts(base, active);
  if (digest(counts) !== digest(policy.activeCounts)) throw new Error("Active eligibility counts are stale.");
  const documents = base.documents.filter((document) => active.has(document.question.id)).map((original) => {
    const value = structuredClone(original);
    value.releaseId = releaseId;
    value.question.media = value.question.media.map((media) => ({
      ...media, objectPath: media.objectPath.replace(base.catalog.releaseId, releaseId),
    }));
    return CleanDocumentSchema.parse(value);
  });
  return {
    catalog: CleanCatalogSchema.parse({
      ...base.catalog, releaseId, counts, questions: base.catalog.questions.filter((question) => active.has(question.id)),
    }),
    documents,
    discussions: base.discussions.filter((discussion) => active.has(discussion.questionId))
      .map((discussion) => CleanDiscussionSchema.parse({ ...discussion, releaseId })),
  };
}
