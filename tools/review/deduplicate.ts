import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  AnswerValueSchema,
  CommentSchema,
  PreparedAnswerSchema,
  PreparedCatalogSchema,
  PreparedQuestionSchema,
  type AnswerValue,
  type Comment,
  type PreparedAnswer,
  type PreparedQuestion,
  type StudyAssessment,
} from "../../src/domain/index.js";
import {
  DuplicateDecisionsSchema,
  type DuplicateDecisions,
  type DuplicateGroup,
} from "../../src/domain/duplicates.js";
import { collectionDigest } from "../ingest/normalize-core.js";
import { assertNoSymlinks } from "../ingest/normalize.js";
import {
  canonicalJson,
  digest,
  plainText,
  workspacePath,
} from "../ingest/normalize-shared.js";
import type { PreparedSnapshot } from "./prepare.js";

export const DUPLICATE_CANDIDATE_VERSION = "conservative-semantic-candidates-1";

export interface DuplicateCandidate {
  leftQuestionId: string;
  rightQuestionId: string;
  leftSourceQuestionNumbers: number[];
  rightSourceQuestionNumbers: number[];
  promptShingleSimilarity: number;
  promptTokenSimilarity: number;
  optionTokenSimilarity: number;
  trigger: "same-normalized-prompt" | "high-similarity" | "minimal-difference";
}

export interface DuplicateCandidateResult {
  version: string;
  scannedQuestions: number;
  candidatePairs: DuplicateCandidate[];
  candidateGroups: string[][];
}

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];
const sortedUnique = <T extends string | number>(values: readonly T[]): T[] =>
  unique(values).sort((left, right) =>
    typeof left === "number" && typeof right === "number"
      ? left - right
      : String(left).localeCompare(String(right))) as T[];

function normalizedText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US")
    .match(/[\p{L}\p{N}]+/gu)?.join(" ") ?? "";
}

function tokens(value: string): Set<string> {
  return new Set(normalizedText(value).split(" ").filter(Boolean));
}

function shingles(value: string): Set<string> {
  const words = normalizedText(value).split(" ").filter(Boolean);
  return new Set(words.slice(0, -2).map((_, index) =>
    words.slice(index, index + 3).join(" ")));
}

function similarity(left: Set<string>, right: Set<string>): number {
  const union = new Set([...left, ...right]);
  if (!union.size) return 1;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection++;
  return intersection / union.size;
}

function optionTexts(question: PreparedQuestion): string[] {
  return question.options.map((option) => normalizedText(plainText(option.content))).sort();
}

function multisetEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function tokenEditCount(left: string, right: string): number {
  const a = normalizedText(left).split(" ").filter(Boolean);
  const b = normalizedText(right).split(" ").filter(Boolean);
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j]!;
      row[j] = Math.min(
        row[j]! + 1,
        row[j - 1]! + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return row[b.length]!;
}

export function findDuplicateCandidates(snapshot: PreparedSnapshot): DuplicateCandidateResult {
  const answerById = new Map(snapshot.answers.map((answer) => [answer.id, answer]));
  const prepared = snapshot.questions.map((question) => {
    const prompt = plainText(question.prompt);
    const options = optionTexts(question);
    return {
      question,
      prompt,
      normalizedPrompt: normalizedText(prompt),
      promptTokens: tokens(prompt),
      promptShingles: shingles(prompt),
      options,
      optionTokens: tokens(options.join(" ")),
      answer: answerById.get(question.id)?.effectiveAnswer.value,
    };
  });
  const candidatePairs: DuplicateCandidate[] = [];
  for (let leftIndex = 0; leftIndex < prepared.length; leftIndex++) {
    const left = prepared[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < prepared.length; rightIndex++) {
      const right = prepared[rightIndex]!;
      const promptShingleSimilarity = similarity(left.promptShingles, right.promptShingles);
      const promptTokenSimilarity = similarity(left.promptTokens, right.promptTokens);
      const optionTokenSimilarity = similarity(left.optionTokens, right.optionTokens);
      const sameOptions = multisetEqual(left.options, right.options);
      const sameAssets = multisetEqual(
        [...left.question.assetIds].sort(),
        [...right.question.assetIds].sort(),
      );
      const sameAnswer = left.answer !== undefined && right.answer !== undefined &&
        canonicalJson(left.answer) === canonicalJson(right.answer);
      let trigger: DuplicateCandidate["trigger"] | undefined;
      if (left.normalizedPrompt === right.normalizedPrompt) {
        trigger = "same-normalized-prompt";
      } else if (promptShingleSimilarity >= 0.9 && (
        (sameOptions && sameAssets) ||
        (!left.question.options.length && !right.question.options.length)
      )) {
        trigger = "high-similarity";
      } else if (sameOptions && sameAssets && sameAnswer &&
          tokenEditCount(left.prompt, right.prompt) <= 4) {
        trigger = "minimal-difference";
      }
      if (!trigger) continue;
      candidatePairs.push({
        leftQuestionId: left.question.id,
        rightQuestionId: right.question.id,
        leftSourceQuestionNumbers: left.question.sources.map((source) => source.questionNumber),
        rightSourceQuestionNumbers: right.question.sources.map((source) => source.questionNumber),
        promptShingleSimilarity: Number(promptShingleSimilarity.toFixed(6)),
        promptTokenSimilarity: Number(promptTokenSimilarity.toFixed(6)),
        optionTokenSimilarity: Number(optionTokenSimilarity.toFixed(6)),
        trigger,
      });
    }
  }
  candidatePairs.sort((left, right) =>
    Math.min(...left.leftSourceQuestionNumbers) - Math.min(...right.leftSourceQuestionNumbers) ||
    Math.min(...left.rightSourceQuestionNumbers) - Math.min(...right.rightSourceQuestionNumbers) ||
    left.leftQuestionId.localeCompare(right.leftQuestionId));

  const parent = new Map<string, string>();
  const find = (id: string): string => {
    const current = parent.get(id);
    if (!current) {
      parent.set(id, id);
      return id;
    }
    if (current === id) return id;
    const root = find(current);
    parent.set(id, root);
    return root;
  };
  for (const pair of candidatePairs) {
    const left = find(pair.leftQuestionId);
    const right = find(pair.rightQuestionId);
    if (left !== right) parent.set(right, left);
  }
  const components = new Map<string, string[]>();
  for (const id of parent.keys()) {
    const root = find(id);
    components.set(root, [...(components.get(root) ?? []), id]);
  }
  const sourceNumber = new Map(snapshot.questions.map((question) => [
    question.id,
    Math.min(...question.sources.map((source) => source.questionNumber)),
  ]));
  const candidateGroups = [...components.values()].map((ids) =>
    ids.sort((left, right) => sourceNumber.get(left)! - sourceNumber.get(right)!))
    .sort((left, right) => sourceNumber.get(left[0]!)! - sourceNumber.get(right[0]!)!);
  return {
    version: DUPLICATE_CANDIDATE_VERSION,
    scannedQuestions: snapshot.questions.length,
    candidatePairs,
    candidateGroups,
  };
}

function validateDecisionTopology(decisions: DuplicateDecisions): void {
  const primaries = new Set<string>();
  const duplicates = new Set<string>();
  for (const group of decisions.groups) {
    const ids = [group.primaryCanonicalQuestionId, ...group.duplicateQuestionIds];
    if (new Set(ids).size !== ids.length) {
      throw new Error(`${group.primaryCanonicalQuestionId}: duplicate group repeats a question ID`);
    }
    if (primaries.has(group.primaryCanonicalQuestionId) ||
        duplicates.has(group.primaryCanonicalQuestionId)) {
      throw new Error(`${group.primaryCanonicalQuestionId}: duplicate groups overlap or form a chain`);
    }
    primaries.add(group.primaryCanonicalQuestionId);
    for (const id of group.duplicateQuestionIds) {
      if (primaries.has(id) || duplicates.has(id)) {
        throw new Error(`${id}: duplicate groups overlap or form a chain`);
      }
      duplicates.add(id);
    }
  }
}

function optionMap(
  group: DuplicateGroup,
  duplicate: PreparedQuestion,
  primary: PreparedQuestion,
): Map<string, string> {
  const records = group.optionMappings[duplicate.id];
  if (!records) throw new Error(`${duplicate.id}: verified option mapping is missing`);
  const mapping = new Map(records.map((record) => [
    record.duplicateOptionId,
    record.primaryOptionId,
  ]));
  const duplicateIds = new Set(duplicate.options.map((option) => option.id));
  const primaryIds = new Set(primary.options.map((option) => option.id));
  if (mapping.size !== duplicateIds.size || mapping.size !== primaryIds.size ||
      [...duplicateIds].some((id) => !mapping.has(id)) ||
      [...mapping.keys()].some((id) => !duplicateIds.has(id)) ||
      [...mapping.values()].some((id) => !primaryIds.has(id)) ||
      new Set(mapping.values()).size !== mapping.size) {
    throw new Error(`${duplicate.id}: option mapping must be complete, valid, and one-to-one`);
  }
  return mapping;
}

function mapAnswer(value: AnswerValue, mapping: ReadonlyMap<string, string>): AnswerValue {
  if (value.kind === "manual") return structuredClone(value);
  return AnswerValueSchema.parse({
    kind: "option-selection",
    optionIds: sortedUnique(value.optionIds.map((id) => {
      const mapped = mapping.get(id);
      if (!mapped) throw new Error(`Answer option ${id} is absent from the verified mapping`);
      return mapped;
    })),
  });
}

function mergedAssessment(
  primary: PreparedAnswer,
  duplicates: readonly PreparedAnswer[],
): StudyAssessment {
  const assessments = [primary, ...duplicates].map((answer) => answer.assessment);
  const statuses = unique(assessments.map((assessment) => assessment.status));
  const summaries = assessments.map((assessment) => assessment.summary);
  const warnings = sortedUnique(assessments.flatMap((assessment) => assessment.warnings));
  const citations = [...new Map(assessments.flatMap((assessment) =>
    assessment.citations).map((citation) => [canonicalJson(citation), citation])).values()];
  const imageSummaries = [...new Map(assessments.flatMap((assessment) =>
    assessment.originalImageAnswers).map((summary) => [
      `${summary.sourceQuestionNumber}:${summary.summary}`,
      summary,
    ])).values()].sort((left, right) => left.sourceQuestionNumber - right.sourceQuestionNumber);
  const effectiveImageSummaries = unique(assessments.map((assessment) =>
    assessment.effectiveImageAnswerSummary).filter((value): value is string => value !== null));
  let status = primary.assessment.status;
  let provisional = assessments.some((assessment) => assessment.provisional);
  if (statuses.includes("outdated-or-defective")) {
    status = "outdated-or-defective";
    provisional = true;
  } else if (statuses.includes("unresolved") || statuses.length > 1) {
    status = "unresolved";
    provisional = true;
  }
  if (provisional && warnings.length === 0) {
    warnings.push("Merged source assessments require conservative review.");
  }
  if (statuses.length > 1) {
    warnings.push(`Merged source assessments differed: ${statuses.sort().join(", ")}.`);
  }
  return {
    status,
    provisional,
    summary: summaries.join("\n\n"),
    warnings: sortedUnique(warnings),
    citations,
    sourceQuestionNumbers: sortedUnique(assessments.flatMap((assessment) =>
      assessment.sourceQuestionNumbers)),
    originalImageAnswers: imageSummaries,
    effectiveImageAnswerSummary: effectiveImageSummaries.length === 1
      ? effectiveImageSummaries[0]!
      : null,
  };
}

function derivedReleaseId(decisions: DuplicateDecisions): string {
  return `r_${digest({
    transform: "logical-duplicate-grouping-1",
    baseReleaseId: decisions.baseReleaseId,
    sourceRevision: decisions.sourceRevision,
    groups: decisions.groups,
  })}`;
}

export function rebaseMedia(question: PreparedQuestion, releaseId: string): PreparedQuestion {
  return {
    ...question,
    media: question.media.map((media) => ({
      ...media,
      objectPath: media.objectPath.replace(
        /^published\/az104\/r_[a-f0-9]{64}\//,
        `published/az104/${releaseId}/`,
      ),
    })),
  };
}

function validateSnapshot(snapshot: PreparedSnapshot): void {
  PreparedCatalogSchema.parse(snapshot.catalog);
  const questionIds = new Set(snapshot.questions.map((question) => question.id));
  const answerIds = new Set(snapshot.answers.map((answer) => answer.id));
  if (questionIds.size !== snapshot.questions.length ||
      answerIds.size !== snapshot.answers.length ||
      snapshot.catalog.entries.length !== snapshot.questions.length) {
    throw new Error("Prepared snapshot has duplicate or incomplete records");
  }
  const commentsPerQuestion = new Map<string, number>();
  snapshot.questions.forEach((question) => PreparedQuestionSchema.parse(question));
  snapshot.answers.forEach((answer) => PreparedAnswerSchema.parse(answer));
  for (const comment of snapshot.comments) {
    CommentSchema.parse(comment);
    commentsPerQuestion.set(comment.questionId, (commentsPerQuestion.get(comment.questionId) ?? 0) + 1);
  }
  for (const question of snapshot.questions) {
    if ((commentsPerQuestion.get(question.id) ?? 0) !== question.commentCount) {
      throw new Error(`${question.id}: retained comments do not reconcile`);
    }
  }
}

export function applyDuplicateGroups(
  input: PreparedSnapshot,
  rawDecisions: DuplicateDecisions,
): PreparedSnapshot {
  const decisions = DuplicateDecisionsSchema.parse(rawDecisions);
  validateDecisionTopology(decisions);
  if (input.catalog.sourceRevision !== decisions.sourceRevision) {
    throw new Error("Duplicate decisions source revision does not match the prepared snapshot");
  }
  const releaseId = derivedReleaseId(decisions);
  const duplicateIds = new Set(decisions.groups.flatMap((group) => group.duplicateQuestionIds));
  if (input.catalog.releaseId === releaseId &&
      [...duplicateIds].every((id) => !input.questions.some((question) => question.id === id))) {
    validateSnapshot(input);
    return input;
  }
  if (input.catalog.releaseId !== decisions.baseReleaseId) {
    throw new Error("Duplicate decisions base release does not match the prepared snapshot");
  }
  if (decisions.groups.length === 0) {
    validateSnapshot(input);
    return input;
  }

  const snapshot = structuredClone(input);
  const questionById = new Map(snapshot.questions.map((question) => [question.id, question]));
  const answerById = new Map(snapshot.answers.map((answer) => [answer.id, answer]));
  const entryById = new Map(snapshot.catalog.entries.map((entry) => [entry.id, entry]));
  const aliasToPrimary = new Map<string, string>();

  for (const group of decisions.groups) {
    const primary = questionById.get(group.primaryCanonicalQuestionId);
    const primaryAnswer = answerById.get(group.primaryCanonicalQuestionId);
    const primaryEntry = entryById.get(group.primaryCanonicalQuestionId);
    if (!primary || !primaryAnswer || !primaryEntry) {
      throw new Error(`${group.primaryCanonicalQuestionId}: primary record is missing`);
    }
    const allIds = [primary.id, ...group.duplicateQuestionIds];
    if (Object.keys(group.questionRevisions).length !== allIds.length ||
        allIds.some((id) => group.questionRevisions[id] === undefined)) {
      throw new Error(`${primary.id}: decision revisions must cover every grouped question`);
    }
    const sourceNumbersById = new Map(group.sourceQuestionNumbers.map((record) => [
      record.questionId,
      record.numbers,
    ]));
    if (sourceNumbersById.size !== allIds.length ||
        allIds.some((id) => !sourceNumbersById.has(id))) {
      throw new Error(`${primary.id}: decision source numbers must cover every grouped question`);
    }

    const duplicateQuestions: PreparedQuestion[] = [];
    const duplicateAnswers: PreparedAnswer[] = [];
    const mappings = new Map<string, Map<string, string>>();
    for (const id of group.duplicateQuestionIds) {
      const duplicate = questionById.get(id);
      const answer = answerById.get(id);
      if (!duplicate || !answer || !entryById.has(id)) {
        throw new Error(`${id}: duplicate record is missing`);
      }
      if (group.questionRevisions[id] !== duplicate.sourceRevision ||
          group.questionRevisions[primary.id] !== primary.sourceRevision) {
        throw new Error(`${id}: duplicate decision is stale for the question revision`);
      }
      const actualNumbers = duplicate.sources.map((source) => source.questionNumber).sort((a, b) => a - b);
      const reviewedNumbers = [...sourceNumbersById.get(id)!].sort((a, b) => a - b);
      if (canonicalJson(actualNumbers) !== canonicalJson(reviewedNumbers)) {
        throw new Error(`${id}: duplicate decision source-number evidence is stale`);
      }
      if (duplicate.kind !== primary.kind ||
          duplicate.sourcePresentation.kind !== primary.sourcePresentation.kind) {
        throw new Error(`${id}: question kinds differ`);
      }
      const mapping = optionMap(group, duplicate, primary);
      const mappedEffective = mapAnswer(answer.effectiveAnswer.value, mapping);
      if (canonicalJson(mappedEffective) !== canonicalJson(primaryAnswer.effectiveAnswer.value)) {
        throw new Error(`${id}: effective answers conflict after verified option mapping`);
      }
      mappings.set(id, mapping);
      duplicateQuestions.push(duplicate);
      duplicateAnswers.push(answer);
      aliasToPrimary.set(id, primary.id);
    }
    const primaryNumbers = primary.sources.map((source) => source.questionNumber).sort((a, b) => a - b);
    if (group.questionRevisions[primary.id] !== primary.sourceRevision ||
        canonicalJson(primaryNumbers) !==
          canonicalJson([...sourceNumbersById.get(primary.id)!].sort((a, b) => a - b))) {
      throw new Error(`${primary.id}: primary decision evidence is stale`);
    }

    const derivedRevision = digest({
      transform: "logical-duplicate-record-1",
      primaryQuestionId: primary.id,
      questionRevisions: group.questionRevisions,
      optionMappings: group.optionMappings,
    });
    const allQuestions = [primary, ...duplicateQuestions];
    const allAnswers = [primaryAnswer, ...duplicateAnswers];
    const mappedOriginalAnswers = allAnswers.flatMap((answer) =>
      answer.originalAnswers.map((original) => {
        const mapping = answer.id === primary.id
          ? new Map(primary.options.map((option) => [option.id, option.id]))
          : mappings.get(answer.id)!;
        return { ...original, value: mapAnswer(original.value, mapping) };
      }));
    const mappedOriginalValues = unique(mappedOriginalAnswers.map((answer) =>
      canonicalJson(answer.value)));
    const effectiveSourceOccurrenceIds = sortedUnique(allAnswers.flatMap((answer) =>
      answer.effectiveAnswer.sourceOccurrenceIds));
    const verificationOrder = {
      "not-independently-verified": 0,
      "community-reviewed": 1,
      documented: 2,
    } as const;
    const verification = allAnswers.map((answer) => answer.effectiveAnswer.verification)
      .sort((left, right) => verificationOrder[left] - verificationOrder[right])[0]!;
    const combinedMedia = [...new Map(allQuestions.flatMap((question) =>
      question.media).map((media) => [media.id, media])).values()];
    const combinedSources = allQuestions.flatMap((question) => {
      const mapping = question.id === primary.id
        ? new Map(primary.options.map((option) => [option.id, option.id]))
        : mappings.get(question.id)!;
      return question.sources.map((source) => ({
        ...source,
        sourceLabelToOptionId: Object.fromEntries(Object.entries(source.sourceLabelToOptionId)
          .map(([label, optionId]) => {
            const mapped = mapping.get(optionId);
            if (!mapped) throw new Error(`${question.id}: source label ${label} has no verified option mapping`);
            return [label, mapped];
          })),
      }));
    }).sort((left, right) => left.questionNumber - right.questionNumber);
    const retainedComments = allQuestions.reduce((sum, question) => sum + question.commentCount, 0);
    const sourceComments = allQuestions.reduce((sum, question) =>
      sum + (question.sourceCommentCount ?? question.commentCount), 0);

    const mergedQuestion = PreparedQuestionSchema.parse({
      ...primary,
      sourceRevision: derivedRevision,
      sourceOccurrenceIds: sortedUnique(allQuestions.flatMap((question) =>
        question.sourceOccurrenceIds)),
      assetIds: sortedUnique(allQuestions.flatMap((question) => question.assetIds)),
      commentCount: retainedComments,
      sourceCommentCount: sourceComments,
      omittedCommentCount: sourceComments - retainedComments,
      media: combinedMedia,
      sources: combinedSources,
      review: {
        ...primary.review,
        basedOnSourceRevision: derivedRevision,
      },
    });
    const mergedAnswer = PreparedAnswerSchema.parse({
      ...primaryAnswer,
      sourceRevision: derivedRevision,
      originalAnswers: mappedOriginalAnswers,
      originalKeysConflict: allAnswers.some((answer) => answer.originalKeysConflict) ||
        mappedOriginalValues.length > 1,
      effectiveAnswer: {
        ...primaryAnswer.effectiveAnswer,
        sourceOccurrenceIds: effectiveSourceOccurrenceIds,
        verification,
      },
      review: {
        ...primaryAnswer.review,
        basedOnSourceRevision: derivedRevision,
      },
      published: allAnswers.every((answer) => answer.published),
      assessment: mergedAssessment(primaryAnswer, duplicateAnswers),
    });
    questionById.set(primary.id, mergedQuestion);
    answerById.set(primary.id, mergedAnswer);
    entryById.set(primary.id, {
      ...primaryEntry,
      sourceRevision: derivedRevision,
      sourceOccurrenceIds: mergedQuestion.sourceOccurrenceIds,
      sourceQuestionNumbers: mergedQuestion.sources.map((source) => source.questionNumber),
      commentCount: mergedQuestion.commentCount,
      published: mergedQuestion.published && mergedAnswer.published,
    });
    for (const id of group.duplicateQuestionIds) {
      questionById.delete(id);
      answerById.delete(id);
      entryById.delete(id);
    }
  }

  const questions = [...questionById.values()]
    .map((question) => rebaseMedia(question, releaseId));
  const answers = [...answerById.values()];
  const comments: Comment[] = snapshot.comments.map((comment) => {
    const primaryId = aliasToPrimary.get(comment.questionId);
    return primaryId ? CommentSchema.parse({ ...comment, questionId: primaryId }) : comment;
  });
  const retarget = <T extends Record<string, unknown>>(value: T): T => {
    const questionId = typeof value.questionId === "string"
      ? aliasToPrimary.get(value.questionId)
      : undefined;
    return questionId
      ? { ...value, questionId, deduplicationOriginalQuestionId: value.questionId } as T
      : value;
  };
  const filterDecisions = snapshot.commentFilterReport.decisions.map(retarget);
  const questionsWithoutRetainedComments =
    snapshot.commentFilterReport.questionsWithoutRetainedComments.map(retarget);
  const decisionDigest = digest(filterDecisions);
  const commentFilter = {
    ...snapshot.catalog.commentFilter!,
    decisionDigest,
  };
  const reviewCounts: Record<StudyAssessment["status"], number> = {
    "source-default": 0,
    confirmed: 0,
    corrected: 0,
    unresolved: 0,
    "outdated-or-defective": 0,
  };
  answers.forEach((answer) => reviewCounts[answer.assessment.status]++);
  const gradingCounts = {
    automatic: questions.filter((question) => question.readiness.grading === "automatic").length,
    manual: questions.filter((question) => question.readiness.grading === "manual").length,
  };
  const records = {
    ...snapshot.catalog.records,
    questions: questions.length,
    answers: answers.length,
    comments: comments.length,
  };
  const catalog = PreparedCatalogSchema.parse({
    ...snapshot.catalog,
    releaseId,
    entries: [...entryById.values()],
    records,
    commentFilter,
    reviewCounts,
    gradingCounts,
  });
  const deduplication = {
    version: "logical-duplicate-grouping-1",
    baseReleaseId: decisions.baseReleaseId,
    decisionsDigest: digest(decisions),
    confirmedGroups: decisions.groups.length,
    duplicatesRemoved: duplicateIds.size,
    aliases: Object.fromEntries([...aliasToPrimary.entries()].sort()),
  };
  const commentFilterReport = {
    ...snapshot.commentFilterReport,
    releaseId,
    decisionDigest,
    decisions: filterDecisions,
    questionsWithoutRetainedComments,
    deduplication,
  };
  const report = {
    ...snapshot.report,
    releaseId,
    preparerVersion: `${snapshot.report.preparerVersion}+logical-duplicate-grouping-1`,
    records,
    commentFilter,
    reviewCounts,
    gradingCounts,
    catalogDigest: digest(catalog),
    recordDigests: {
      questions: collectionDigest(questions),
      answers: collectionDigest(answers),
      comments: collectionDigest(comments),
    },
    deduplication,
    uploaded: false,
  };
  const result: PreparedSnapshot = {
    catalog,
    questions,
    answers,
    comments,
    commentFilterReport,
    report,
  };
  validateSnapshot(result);
  return result;
}

export async function loadDuplicateDecisions(
  workspaceRoot = process.cwd(),
): Promise<DuplicateDecisions> {
  const workspace = resolve(workspaceRoot);
  await assertNoSymlinks(workspace, ".data/deduplication/decisions.json");
  const path = workspacePath(workspace, ".data/deduplication/decisions.json");
  return DuplicateDecisionsSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

export async function buildDeduplicatedSnapshot(
  snapshot: PreparedSnapshot,
  options: { workspaceRoot?: string } = {},
): Promise<PreparedSnapshot> {
  const decisions = await loadDuplicateDecisions(options.workspaceRoot);
  return applyDuplicateGroups(snapshot, decisions);
}

export const deduplicationInternals = {
  derivedReleaseId,
  normalizedText,
  tokenEditCount,
};
