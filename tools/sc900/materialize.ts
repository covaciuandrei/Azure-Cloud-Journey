import assert from "node:assert/strict";
import { z } from "zod";
import { SC900_BANK_VERSION, Sc900DocumentSchema, Sc900DiscussionSchema, type Sc900Document } from "../../src/domain/sc900Bank.js";
import { Sc900ScopedCaptureLedgerSchema, Sc900QuestionsOnlyAuthorizationSchema } from "../../src/domain/sc900Scope.js";
import { Sc900LearningExplanationSchema } from "../../src/domain/sc900Learning.js";
import { Sc900TopicSelectionSchema, SC900_TOPIC_GUIDE_URL, SC900_TOPIC_VERSION } from "../../src/domain/sc900Topics.js";
import { Sc900EligibilityPolicySchema, type Sc900Retirement } from "../../src/domain/sc900Eligibility.js";
import { QuestionIdSchema, Sha256Schema } from "../../src/domain/schemas.js";
import { mediaExtension } from "../../src/domain/cleanBank.js";
import {
  assertSc900ScopedAuthorization, byteSha256, sc900DuplicateAdjudicationDigest,
  sc900Hash, sc900SourceRevision,
} from "./canonical.js";
import { prepareSc900Release, sc900OriginalKeyDigest, SC900_DRAFT_RELEASE_ID, type Sc900PublicationInput } from "./publication.js";
import { SourceScopeReceiptSchema } from "./cloud-plan.js";

export const Sc900ReviewedQuestionSchema = z.object({
  number: z.number().int().positive(),
  questionId: QuestionIdSchema,
  topicIds: Sc900TopicSelectionSchema,
  eligibilityRecommendation: z.enum(["keep", "hold", "retire"]),
  eligibilityReason: z.string().trim().min(1),
  relatedSourceNumbers: z.array(z.number().int().positive()),
  visualReview: z.enum(["not-needed", "complete", "unresolved"]),
  explanation: Sc900LearningExplanationSchema,
}).strict();
export type Sc900ReviewedQuestion = z.infer<typeof Sc900ReviewedQuestionSchema>;

export const Sc900ReviewedDuplicateSchema = z.object({
  questionId: QuestionIdSchema,
  duplicateOfQuestionId: QuestionIdSchema,
  reportSha256: Sha256Schema,
  reason: z.string().trim().min(40).max(4000),
  evidence: z.string().trim().min(80).max(7000),
}).strict();

const draftBoilerplate = [
  "Private draft reviewed on September 22, 2026. Source discussions remain pending after a rate-limit response; no discussion review, tenant test or final publication approval is claimed.",
  "Source discussions remain pending; the original key digest is preserved and no publication approval is claimed.",
  "Source discussions remain pending; no tenant test or publication approval is claimed.",
  "Private draft only. Source discussion retrieval remains pending after HTTP 429 responses; neither this explanation nor a keep recommendation approves publication.",
  "Draft review only. Source discussions were unavailable or not requested and remain pending, not confirmed empty. Final key and publication approval are blocked.",
  "Draft review only. Source discussions were not retrieved because of the reported 429 acquisition failure; they remain pending, not confirmed empty. This is not final key, eligibility, discussion or publication approval.",
  "Discussion review and final approval are still pending.",
  "Discussions remain pending and no publication approval is claimed.",
  "Discussions remain pending; this draft recommendation does not authorize publication.",
  "This is an independent draft correction from the visually inspected marked answer. The original source key digest is preserved; no bank key or publication approval is changed.",
];

export function removeSc900DraftBoilerplate(text: string): string {
  let result = text.replace(
      "Keep is only an item-level draft recommendation as of September 22, 2026, not product adoption advice.",
      "This explanation is not product adoption advice.",
    );
  for (const phrase of draftBoilerplate) result = result.replaceAll(phrase, "");
  result = result.trim();
  if (/\bprivate draft\b|\bdraft (?:review only|recommendation|correction)\b|discussions? (?:review |retrieval )?(?:remains? |are |is )?pending|publication approval/i.test(result)) {
    throw new Error("Unrecognized draft-only wording requires explicit review before publication.");
  }
  return result;
}

function questionCore(document: Sc900Document) {
  const { releaseId: _release, question, answers, ...rest } = document;
  const { sourceRevision: _questionRevision, discussionScope: _discussionScope, media, ...body } = question;
  const { sourceRevision: _answerRevision, ...answerBody } = answers;
  return {
    ...rest,
    question: { ...body, media: media.map(({ objectPath: _path, ...asset }) => asset) },
    answers: answerBody,
  };
}

function hasDefiniteChoiceKey(record: Sc900ReviewedQuestion): boolean {
  const ids = record.explanation.correctOptionIds;
  return Boolean(ids?.length && record.explanation.options.every((option) =>
    option.verdict === (ids.includes(option.optionId) ? "correct" : "incorrect")));
}

export interface Sc900MaterializationInput {
  ledger: unknown;
  ownerAuthorization: unknown;
  sourceScopeReceipt: Uint8Array;
  documents: unknown[];
  reviewedDocuments: unknown[];
  reviews: unknown[];
  reviewedAt: string;
  duplicates: unknown[];
  assets: ReadonlyMap<string, Uint8Array>;
}

/** Applies reviewed content decisions; it neither approves a release nor contacts cloud services. */
export function materializeSc900ReviewedBank(input: Sc900MaterializationInput) {
  const ledger = Sc900ScopedCaptureLedgerSchema.parse(input.ledger);
  const ownerAuthorization = Sc900QuestionsOnlyAuthorizationSchema.parse(input.ownerAuthorization);
  assertSc900ScopedAuthorization(ledger, ownerAuthorization);
  assert.equal(byteSha256(input.sourceScopeReceipt), ownerAuthorization.sourceScopeReceiptSha256,
    "The original source-scope receipt bytes differ from the owner's authorization.");
  const sourceScope = SourceScopeReceiptSchema.parse(JSON.parse(Buffer.from(input.sourceScopeReceipt).toString("utf8")));
  assert.equal(sourceScope.observedPageCount, ownerAuthorization.pages);
  assert.equal(sourceScope.observedSourceQuestionCount, ownerAuthorization.questions);
  const reviewedAt = z.string().date().parse(input.reviewedAt);
  const documents = input.documents.map((value) => Sc900DocumentSchema.parse(value));
  const reviewed = input.reviewedDocuments.map((value) => Sc900DocumentSchema.parse(value));
  const reviews = input.reviews.map((value) => Sc900ReviewedQuestionSchema.parse(value));
  const duplicates = input.duplicates.map((value) => Sc900ReviewedDuplicateSchema.parse(value));
  const documentById = new Map(documents.map((document) => [document.question.id, document]));
  const oldById = new Map(reviewed.map((document) => [document.question.id, document]));
  const reviewById = new Map(reviews.map((record) => [record.questionId, record]));
  const duplicateById = new Map(duplicates.map((record) => [record.questionId, record]));
  const ids = [...documentById.keys()].sort();
  assert.equal(documentById.size, documents.length, "Captured questions must be unique.");
  assert.equal(oldById.size, reviewed.length, "Reviewed source questions must be unique.");
  assert.equal(reviewById.size, reviews.length, "Question reviews must be unique.");
  assert.equal(duplicateById.size, duplicates.length, "Duplicate exclusions must be unique.");
  assert.deepEqual([...oldById.keys()].sort(), ids, "Every captured question needs its unchanged reviewed source.");
  assert.deepEqual([...reviewById.keys()].sort(), ids, "Every captured question requires a complete factual review.");
  const sourceRevision = sc900SourceRevision(ledger);
  const active = new Set<string>();
  const holds = new Set<string>();
  const lineage: Array<{ questionId: string; reviewedSourceRevision: string; publishedSourceRevision: string; originalKeyDigest: string }> = [];
  for (const document of documents) {
    const question = document.question;
    const previous = oldById.get(question.id)!;
    const record = reviewById.get(question.id)!;
    assert.deepEqual(questionCore(document), questionCore(previous),
      "Captured question content or original answers changed after independent review.");
    assert.equal(question.sourceRevision, sourceRevision, "Question is not bound to the scoped capture.");
    assert.equal(record.number, Math.min(...question.sources.map((source) => source.questionNumber)));
    assert.equal(record.explanation.questionId, question.id);
    assert.equal(record.explanation.questionSourceRevision, previous.question.sourceRevision);
    assert.equal(record.explanation.originalKeyDigest, sc900OriginalKeyDigest(previous));
    assert.equal(record.explanation.originalKeyDigest, sc900OriginalKeyDigest(document));
    assert.deepEqual(new Set(record.explanation.options.map((option) => option.optionId)),
      new Set(question.options.map((option) => option.id)));
    const canGrade = question.readiness.grading === "automatic" ? hasDefiniteChoiceKey(record) :
      record.visualReview === "complete" && record.explanation.options.length === 0 &&
        record.explanation.answerParts.length > 0;
    if (record.eligibilityRecommendation === "keep" &&
        !["incomplete", "outdated"].includes(record.explanation.status) && canGrade) active.add(question.id);
    else if (record.eligibilityRecommendation !== "retire") holds.add(question.id);
    lineage.push({
      questionId: question.id, reviewedSourceRevision: previous.question.sourceRevision,
      publishedSourceRevision: sourceRevision, originalKeyDigest: sc900OriginalKeyDigest(document),
    });
  }
  for (const duplicate of duplicates) {
    const source = documentById.get(duplicate.questionId);
    const target = documentById.get(duplicate.duplicateOfQuestionId);
    assert(source && target && source !== target, "Duplicate decisions must name distinct captured questions.");
    assert.equal(source.question.kind, target.question.kind, "Duplicate question kinds must agree.");
    assert(active.has(source.question.id) && active.has(target.question.id),
      "Only otherwise eligible duplicate copies can be suppressed.");
    assert(!duplicateById.has(target.question.id), "Duplicate exclusions cannot form chains or cycles.");
    active.delete(source.question.id);
  }
  const exclusions: Sc900Retirement[] = [];
  const explanations = [];
  const assignments: Record<string, z.infer<typeof Sc900TopicSelectionSchema>> = {};
  const boilerplateChanges: Array<{ questionId: string; before: string | null; after: string | null }> = [];
  for (const document of documents) {
    const question = document.question;
    const record = reviewById.get(question.id)!;
    const explanation = structuredClone(record.explanation);
    explanation.questionSourceRevision = sourceRevision;
    const oldCaveat = explanation.caveat;
    if (explanation.caveat !== null) {
      explanation.caveat = removeSc900DraftBoilerplate(explanation.caveat) || null;
    }
    if (explanation.status === "corrected" && explanation.caveat === null) {
      explanation.caveat = `Correction to the original source: ${explanation.summary}`;
    }
    Sc900LearningExplanationSchema.parse(explanation);
    if (oldCaveat !== explanation.caveat) boilerplateChanges.push({
      questionId: question.id, before: oldCaveat, after: explanation.caveat,
    });
    if (question.readiness.grading === "automatic" && hasDefiniteChoiceKey(record)) {
      document.answers.effectiveAnswer.value = { kind: "option-selection", optionIds: [...explanation.correctOptionIds!] };
    }
    document.answers.provisional = !active.has(question.id);
    document.releaseId = SC900_DRAFT_RELEASE_ID;
    question.media.forEach((media) => {
      media.objectPath = `published/sc900/${SC900_DRAFT_RELEASE_ID}/assets/${media.id}.${mediaExtension(media.contentType)}`;
    });
    assignments[question.id] = record.topicIds;
    explanations.push(explanation);
    if (active.has(question.id)) continue;
    const base = {
      examId: "sc900" as const, questionId: question.id, number: record.number,
      sourceNumbers: question.sources.map((source) => source.questionNumber).sort((a, b) => a - b),
    };
    const duplicate = duplicateById.get(question.id);
    if (duplicate) {
      const exclusion = {
        ...base, category: "duplicate" as const, reason: duplicate.reason, sources: [],
        duplicateOfQuestionId: duplicate.duplicateOfQuestionId,
        evidence: `${duplicate.evidence} Independent comparison report SHA-256: ${duplicate.reportSha256}.`,
      };
      exclusions.push({ ...exclusion, adjudicationDigest: sc900DuplicateAdjudicationDigest(exclusion) });
    } else {
      const strictScoringHold = record.eligibilityRecommendation === "keep" && holds.has(question.id);
      const reason = strictScoringHold
        ? `Excluded from automatic practice because the reviewed option verdict remains condition-dependent rather than a definite scored choice. ${explanation.caveat ?? explanation.summary}`
        : removeSc900DraftBoilerplate(record.eligibilityReason);
      exclusions.push({
        ...base,
        category: record.eligibilityRecommendation === "retire"
          ? explanation.status === "outdated" && /retir|deprecat/i.test(reason) ? "retired-feature" : "changed-assumptions"
          : "defective-question",
        reason, sources: explanation.sources,
      });
    }
  }
  const selected = documents.filter((document) => active.has(document.question.id));
  const sourceQuestions = selected.reduce((total, document) => total + document.question.sources.length, 0);
  const automatic = selected.filter((document) => document.question.readiness.grading === "automatic").length;
  const eligibility = Sc900EligibilityPolicySchema.parse({
    schemaVersion: 1, examId: "sc900", bankVersion: SC900_BANK_VERSION,
    policyId: `e_${"0".repeat(64)}`, releaseId: SC900_DRAFT_RELEASE_ID,
    teachingReleaseId: SC900_DRAFT_RELEASE_ID, sourceRevision, reviewedAt,
    reviewedQuestionIds: ids, activeQuestionIds: [...active].sort(),
    activeCounts: {
      questions: selected.length, comments: 0,
      images: new Set(selected.flatMap((document) => document.question.media.map((image) => image.id))).size,
      automatic, manual: selected.length - automatic, omittedComments: 0,
      sourceQuestions, duplicatesGrouped: sourceQuestions - selected.length,
    },
    retired: exclusions,
  });
  const publicationInput: Sc900PublicationInput = {
    expectedCapture: { questions: ownerAuthorization.questions, pages: ownerAuthorization.pages,
      receiptSha256: ownerAuthorization.sourceScopeReceiptSha256 },
    ledger, ownerAuthorization, documents,
    discussions: documents.map((document) => Sc900DiscussionSchema.parse({
      schemaVersion: 1, examId: "sc900", releaseId: SC900_DRAFT_RELEASE_ID,
      questionId: document.question.id, comments: [],
    })),
    topics: {
      schemaVersion: 1, examId: "sc900", bankVersion: SC900_BANK_VERSION,
      releaseId: SC900_DRAFT_RELEASE_ID, sourceRevision,
      taxonomyVersion: SC900_TOPIC_VERSION, guideUrl: SC900_TOPIC_GUIDE_URL, assignments,
    },
    learning: {
      schemaVersion: 1, examId: "sc900", bankVersion: SC900_BANK_VERSION,
      releaseId: SC900_DRAFT_RELEASE_ID, baseReleaseId: SC900_DRAFT_RELEASE_ID,
      sourceRevision, explanations,
    },
    eligibility, assets: input.assets,
  };
  const prepared = prepareSc900Release(publicationInput);
  return {
    input: publicationInput,
    prepared,
    report: {
      schemaVersion: 1, examId: "sc900", reviewedAt,
      sourceReviewDigest: sc900Hash("materialization-reviews", reviews),
      sourceScopeReceiptSha256: byteSha256(input.sourceScopeReceipt),
      active: prepared.eligibility.activeCounts,
      exclusions: exclusions.map((record) => ({ questionId: record.questionId, number: record.number, category: record.category, reason: record.reason })),
      originalSourceRecordsPreserved: documents.length,
      originalAssetBytesPreserved: input.assets.size,
      lineage, boilerplateChanges,
      publicationApproved: false,
    },
  };
}
