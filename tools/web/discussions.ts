import { PreparedCatalogSchema, PreparedQuestionSchema } from "../../src/domain/index.js";
import { collectionDigest } from "../ingest/normalize-core.js";
import { digest } from "../ingest/normalize-shared.js";
import { rebaseMedia } from "../review/deduplicate.js";
import type { PreparedSnapshot } from "../review/prepare.js";
import { readSourceReviews, type SourceReview } from "../review/source-review.js";
import { COMMENT_QUALITY_VERSION, retainSupportedComments, type CommentQualityDecision } from "../../src/domain/commentQuality.js";

export const DISCUSSION_POLICY_VERSION = "answer-disputes-only-v1";
export type DiscussionSnapshot = PreparedSnapshot & {
  discussionQuestionNumbers: number[];
  discussionPolicyVersion: typeof DISCUSSION_POLICY_VERSION;
  commentQualityVersion: typeof COMMENT_QUALITY_VERSION;
  discussionCountsBySource: Record<string, number>;
  commentQualityReport: {
    assessed: number; retained: number; removed: number; promotedReplies: number;
    reasons: Record<string, number>;
  };
  commentQualityDecisions: Array<CommentQualityDecision & { questionId: string; sourceOccurrenceId: string }>;
};

export function hasAnswerDispute(review: Pick<SourceReview, "commentVerdict" | "answerStatus">): boolean {
  return review.commentVerdict === "mixed" || review.commentVerdict === "disputes-source" ||
    ["unresolved", "outdated-or-defective", "corrected"].includes(review.answerStatus);
}

export function filterDiscussions(
  input: PreparedSnapshot,
  reviews: readonly SourceReview[],
): DiscussionSnapshot {
  const byNumber = new Map(reviews.map((review) => [review.sourceQuestionNumber, review]));
  const retainedIds = new Set<string>();
  const retainedNumbers = new Set<number>();
  for (const question of input.questions) {
    const decisions = question.sources.map((source) => {
      const review = byNumber.get(source.questionNumber);
      if (!review) throw new Error(`Question ${source.questionNumber}: discussion review is missing.`);
      return review;
    });
    if (decisions.some(hasAnswerDispute)) {
      retainedIds.add(question.id);
      question.sources.forEach((source) => retainedNumbers.add(source.questionNumber));
    }
  }
  const eligibleComments = input.comments.filter((comment) => retainedIds.has(comment.questionId));
  const eligibleById = new Map(eligibleComments.map((comment) => [comment.id, comment]));
  const comments: PreparedSnapshot["comments"] = [];
  const supportedIds = new Set<string>();
  const qualityReasons: Record<string, number> = {};
  const commentQualityDecisions: DiscussionSnapshot["commentQualityDecisions"] = [];
  let promotedReplies = 0;
  for (const question of input.questions) {
    if (!retainedIds.has(question.id)) continue;
    const answer = input.answers.find((record) => record.questionId === question.id);
    if (!answer) throw new Error(`${question.id}: answer context is missing.`);
    const result = retainSupportedComments(
      eligibleComments.filter((comment) => comment.questionId === question.id), question, answer,
    );
    comments.push(...result.comments);
    promotedReplies += result.promoted;
    for (const decision of result.decisions) {
      const original = eligibleById.get(decision.id);
      if (!original) throw new Error(`${decision.id}: missing comment provenance.`);
      commentQualityDecisions.push({
        ...decision, questionId: question.id, sourceOccurrenceId: original.sourceOccurrenceId,
      });
      if (decision.retained) supportedIds.add(decision.id);
      else qualityReasons[decision.reason] = (qualityReasons[decision.reason] ?? 0) + 1;
    }
  }
  const discussionCountsBySource: Record<string, number> = {};
  input.questions.forEach((question) => question.sources.forEach((source) => {
    discussionCountsBySource[String(source.questionNumber)] = 0;
  }));
  for (const comment of comments) {
    const source = String(Number(comment.sourceOccurrenceId.slice(-6)));
    if (!(source in discussionCountsBySource)) throw new Error(`${comment.id}: unknown source question.`);
    discussionCountsBySource[source] = (discussionCountsBySource[source] ?? 0) + 1;
  }
  const releaseId = `r_${digest({
    policy: DISCUSSION_POLICY_VERSION,
    quality: COMMENT_QUALITY_VERSION,
    baseReleaseId: input.catalog.releaseId,
    retainedQuestions: [...retainedIds].sort(),
    comments: collectionDigest(comments),
  })}`;
  const questions = input.questions.map((question) => {
    const sourceCount = question.sourceCommentCount ?? question.commentCount + (question.omittedCommentCount ?? 0);
    const count = comments.filter((comment) => comment.questionId === question.id).length;
    return PreparedQuestionSchema.parse(rebaseMedia({
      ...question, commentCount: count, sourceCommentCount: sourceCount, omittedCommentCount: sourceCount - count,
    }, releaseId));
  });
  const counts = new Map(questions.map((question) => [question.id, question.commentCount]));
  const decisions = input.commentFilterReport.decisions.map((decision) => {
    if (!decision.retained) return decision;
    if (!retainedIds.has(decision.questionId)) return { ...decision, retained: false, reason: "not-disputed-question" as const };
    if (!supportedIds.has(decision.id)) return { ...decision, retained: false, reason: "unsupported-comment" as const };
    return decision;
  });
  const commentFilter = {
    version: `${input.commentFilterReport.version}+${DISCUSSION_POLICY_VERSION}+${COMMENT_QUALITY_VERSION}`,
    original: input.commentFilterReport.original,
    retained: comments.length,
    omitted: input.commentFilterReport.original - comments.length,
    decisionDigest: digest(decisions),
  };
  const omissionReasons: Record<string, number> = {};
  for (const decision of decisions) {
    if (!decision.retained) omissionReasons[decision.reason] = (omissionReasons[decision.reason] ?? 0) + 1;
  }
  const records = { ...input.catalog.records, comments: comments.length };
  const catalog = PreparedCatalogSchema.parse({
    ...input.catalog, releaseId, records, commentFilter,
    entries: input.catalog.entries.map((entry) => ({ ...entry, commentCount: counts.get(entry.id) ?? 0 })),
  });
  return {
    ...input,
    catalog,
    questions,
    comments,
    discussionQuestionNumbers: [...retainedNumbers].sort((left, right) => left - right),
    discussionPolicyVersion: DISCUSSION_POLICY_VERSION,
    commentQualityVersion: COMMENT_QUALITY_VERSION,
    discussionCountsBySource,
    commentQualityReport: {
      assessed: eligibleComments.length, retained: comments.length,
      removed: eligibleComments.length - comments.length, promotedReplies,
      reasons: qualityReasons,
    },
    commentQualityDecisions,
    commentFilterReport: {
      ...input.commentFilterReport, ...commentFilter, releaseId, decisions, omissionReasons,
      questionsWithoutRetainedComments: questions.filter((question) => question.commentCount === 0).map((question) => ({
        id: question.id, sourceQuestionNumbers: question.sources.map((source) => source.questionNumber),
        omitted: question.omittedCommentCount,
      })),
    },
    report: {
      ...input.report, releaseId, records, commentFilter,
      preparerVersion: `${input.report.preparerVersion}+${DISCUSSION_POLICY_VERSION}`,
      catalogDigest: digest(catalog),
      recordDigests: {
        questions: collectionDigest(questions), answers: collectionDigest(input.answers),
        comments: collectionDigest(comments),
      },
      uploaded: false,
    },
  };
}

export async function buildDiscussionSnapshot(
  input: PreparedSnapshot,
  workspaceRoot = process.cwd(),
): Promise<DiscussionSnapshot> {
  const reviews = await readSourceReviews(".data/curation/source-reviews", ".data/raw/pages", workspaceRoot);
  return filterDiscussions(input, reviews);
}
