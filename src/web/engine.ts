import { z } from "zod";
import { assertExam, ExamIdSchema, examConfig, examIdOf, type ExamId } from "../domain/exams.js";
import { bankContract } from "./bank-contract.js";
import type { QuestionSummary, StudyDocument } from "./types.js";

export type PracticeMode = "exam" | "free";
export type SelfAssessment = "correct" | "incorrect" | "skip" | null;

export interface PracticeResponse {
  selectedIds: string[];
  note: string;
  submitted: boolean;
  flagged: boolean;
  selfAssessment: SelfAssessment;
}

export interface PracticeScoreBucket {
  correct: number;
  incorrect: number;
  unanswered: number;
  total: number;
}

export interface PracticeScore {
  automatic: PracticeScoreBucket;
  provisional: PracticeScoreBucket;
  manual: PracticeScoreBucket;
  totalQuestions: number;
}

export interface PracticeAttempt {
  schemaVersion: 1;
  examId?: ExamId | undefined;
  id: string;
  releaseId: string;
  dataSource?: "firebase" | "snapshot" | undefined;
  mode: PracticeMode;
  size: number;
  questionIds: string[];
  optionOrders: Record<string, string[]>;
  responses: Record<string, PracticeResponse>;
  currentIndex: number;
  startedAt: number;
  deadline: number | null;
  finishedAt: number | null;
  status: "active" | "completed";
  score: PracticeScore | null;
}

export type PracticeAction =
  | { type: "select"; questionId: string; optionId: string }
  | { type: "note"; questionId: string; note: string }
  | { type: "flag"; questionId: string }
  | { type: "submit"; questionId: string }
  | { type: "skip"; questionId: string }
  | { type: "self-assess"; questionId: string; value: SelfAssessment }
  | { type: "navigate"; index: number }
  | { type: "finish" };

const unique = (values: readonly string[]): boolean => new Set(values).size === values.length;
const sameSet = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value) => right.includes(value));

const PracticeResponseSchema = z.object({
  selectedIds: z.array(z.string().min(1)).refine(unique, "Selected option IDs must be unique"),
  note: z.string().max(4_000),
  submitted: z.boolean(),
  flagged: z.boolean(),
  selfAssessment: z.enum(["correct", "incorrect", "skip"]).nullable(),
}).strict();

const PracticeScoreBucketSchema = z.object({
  correct: z.number().int().nonnegative(),
  incorrect: z.number().int().nonnegative(),
  unanswered: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
}).strict().refine(
  (bucket) => bucket.correct + bucket.incorrect + bucket.unanswered === bucket.total,
  "Score bucket outcomes must add up to its total",
);

const PracticeScoreSchema = z.object({
  automatic: PracticeScoreBucketSchema,
  provisional: PracticeScoreBucketSchema,
  manual: PracticeScoreBucketSchema,
  totalQuestions: z.number().int().positive(),
}).strict().refine(
  (score) => score.automatic.total + score.provisional.total + score.manual.total ===
    score.totalQuestions,
  "Score buckets must account for every question",
);

const timestamp = z.number().int().nonnegative().finite();

export const PracticeAttemptSchema = z.object({
  schemaVersion: z.literal(1),
  examId: ExamIdSchema.optional(),
  id: z.string().min(1),
  releaseId: z.string().min(1),
  dataSource: z.enum(["firebase", "snapshot"]).optional(),
  mode: z.enum(["exam", "free"]),
  size: z.number().int().positive(),
  questionIds: z.array(z.string().min(1)),
  optionOrders: z.record(z.string(), z.array(z.string().min(1))),
  responses: z.record(z.string(), PracticeResponseSchema),
  currentIndex: z.number().int().nonnegative(),
  startedAt: timestamp,
  deadline: timestamp.nullable(),
  finishedAt: timestamp.nullable(),
  status: z.enum(["active", "completed"]),
  score: PracticeScoreSchema.nullable(),
}).strict().superRefine((attempt, context) => {
  const freeSize = [10, 20, 30, 40].includes(attempt.size);
  if ((attempt.mode === "exam" && attempt.size !== 40) ||
      (attempt.mode === "free" && !freeSize)) {
    context.addIssue({ code: "custom", path: ["size"], message: "Invalid practice size" });
  }
  if (attempt.questionIds.length !== attempt.size || !unique(attempt.questionIds)) {
    context.addIssue({
      code: "custom", path: ["questionIds"],
      message: "Question IDs must be unique and match the attempt size",
    });
  }
  if (attempt.currentIndex >= attempt.size) {
    context.addIssue({ code: "custom", path: ["currentIndex"], message: "Index is outside the attempt" });
  }
  const questionIds = new Set(attempt.questionIds);
  for (const recordName of ["optionOrders", "responses"] as const) {
    const keys = Object.keys(attempt[recordName]);
    if (keys.length !== questionIds.size || keys.some((key) => !questionIds.has(key))) {
      context.addIssue({
        code: "custom", path: [recordName],
        message: `${recordName} must contain exactly one entry for every question`,
      });
    }
  }
  for (const [questionId, order] of Object.entries(attempt.optionOrders)) {
    if (!unique(order)) {
      context.addIssue({
        code: "custom", path: ["optionOrders", questionId],
        message: "Option order IDs must be unique",
      });
    }
  }
  if (attempt.mode === "exam") {
    const duration = examConfig(examIdOf(attempt)).mockDurationMinutes * 60_000;
    if (attempt.deadline !== attempt.startedAt + duration) {
      context.addIssue({
        code: "custom", path: ["deadline"], message: "Exam deadline must match this exam's practice duration",
      });
    }
  } else if (attempt.deadline !== null) {
    context.addIssue({ code: "custom", path: ["deadline"], message: "Free practice has no deadline" });
  }
  if (attempt.status === "active" && (attempt.finishedAt !== null || attempt.score !== null)) {
    context.addIssue({
      code: "custom", message: "An active attempt cannot have a finish time or score",
    });
  }
  if (attempt.status === "completed" && (attempt.finishedAt === null || attempt.score === null)) {
    context.addIssue({
      code: "custom", message: "A completed attempt requires a finish time and score",
    });
  }
  if (attempt.finishedAt !== null && attempt.finishedAt < attempt.startedAt) {
    context.addIssue({
      code: "custom", path: ["finishedAt"], message: "Finish time cannot precede start time",
    });
  }
  if (attempt.finishedAt !== null && attempt.deadline !== null &&
      attempt.finishedAt > attempt.deadline) {
    context.addIssue({
      code: "custom", path: ["finishedAt"], message: "Exam finish time cannot exceed its deadline",
    });
  }
  if (attempt.score !== null && attempt.score.totalQuestions !== attempt.size) {
    context.addIssue({
      code: "custom", path: ["score", "totalQuestions"],
      message: "Score question count must match attempt size",
    });
  }
});

function seedGenerator(seed: string): () => number {
  let hash = 2_166_136_261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return () => {
    hash += 0x6d2b79f5;
    let value = hash;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function shuffled<T>(values: readonly T[], seed: string): T[] {
  const result = [...values];
  const random = seedGenerator(seed);
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    const held = result[index]!;
    result[index] = result[swapIndex]!;
    result[swapIndex] = held;
  }
  return result;
}

function answerOptionIds(document: StudyDocument): string[] {
  const ids: string[] = [];
  const effective = document.answers.effectiveAnswer.value;
  if (effective.kind === "option-selection") ids.push(...effective.optionIds);
  for (const answer of document.answers.originalAnswers) {
    if (answer.value.kind === "option-selection") ids.push(...answer.value.optionIds);
  }
  return ids;
}

function sourceOrderedOptionIds(document: StudyDocument): string[] {
  const questionId = document.question.id;
  const options = document.question.options.map((option) => option.id);
  if (!unique(options)) throw new Error(`Question ${questionId} has duplicate option IDs`);
  if (document.question.kind !== "manual" && options.length < 2) {
    throw new Error(`Question ${questionId} does not have enough selectable options`);
  }

  const answerIds = answerOptionIds(document);
  const answerValues = [
    document.answers.effectiveAnswer.value,
    ...document.answers.originalAnswers.map((answer) => answer.value),
  ];
  if (answerValues.some((value) =>
    value.kind === "option-selection" && !unique(value.optionIds))) {
    throw new Error(`Question ${questionId} has duplicate answer option IDs`);
  }
  const invalidAnswerId = answerIds.find((id) => !options.includes(id));
  if (invalidAnswerId !== undefined) {
    throw new Error(`Question ${questionId} answer references unknown option ${invalidAnswerId}`);
  }
  const effective = document.answers.effectiveAnswer.value;
  if (effective.kind === "option-selection" && document.question.kind === "single-select" &&
      effective.optionIds.length !== 1) {
    throw new Error(`Question ${questionId} has an invalid single-select answer key`);
  }

  const ordered = document.question.fixedOptionOrder;
  if (!Array.isArray(ordered) || !unique(ordered) || !sameSet(ordered, options)) {
    throw new Error(`Question ${questionId} fixed option order does not match its options`);
  }
  return ordered;
}

function validateDocument(document: StudyDocument): void {
  const questionId = document.question.id;
  if (document.schemaVersion !== 1) throw new Error(`Question ${questionId} has an unsupported schema`);
  if (document.question.schemaVersion !== 1 || document.answers.schemaVersion !== 1) {
    throw new Error(`Question ${questionId} has an unsupported document schema`);
  }
  if (!document.releaseId) throw new Error(`Question ${questionId} has no release ID`);
  if (document.answers.id !== questionId || document.answers.questionId !== questionId) {
    throw new Error(`Question ${questionId} does not match its answer record`);
  }
  if (document.answers.sourceRevision !== document.question.sourceRevision) {
    throw new Error(`Question ${questionId} and its answer use different source revisions`);
  }
  sourceOrderedOptionIds(document);
  const examId = examIdOf(document);
  bankContract(examId).document.parse({
    schemaVersion: document.schemaVersion,
    ...(examId === "sc900" ? { examId } : {}),
    releaseId: document.releaseId, question: document.question, answers: document.answers,
    discussionEnabled: document.discussionEnabled,
  });
}

export function optionOrder(document: StudyDocument, seed: string): string[] {
  validateDocument(document);
  const sourceOrder = sourceOrderedOptionIds(document);
  return document.question.shuffle.allowed
    ? shuffled(sourceOrder, `${seed}\u0000${document.question.id}`)
    : sourceOrder;
}

export function sampleQuestionIds(
  catalogQuestions: QuestionSummary[],
  count: number,
  seed: string,
): string[] {
  if (!Number.isInteger(count) || count < 0) throw new Error("Question count must be a non-negative integer");
  const ids = catalogQuestions.map((question) => question.id);
  if (!unique(ids)) throw new Error("Catalog contains duplicate question IDs");
  if (count > ids.length) {
    throw new Error(`Requested ${count} questions, but only ${ids.length} are available`);
  }
  return shuffled(ids, seed).slice(0, count);
}

function defaultResponse(): PracticeResponse {
  return {
    selectedIds: [],
    note: "",
    submitted: false,
    flagged: false,
    selfAssessment: null,
  };
}

function generatedId(now: number): string {
  if (globalThis.crypto !== undefined && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `attempt-${now}-${Math.random().toString(36).slice(2)}`;
}

export function createAttempt(input: {
  examId?: ExamId;
  mode: PracticeMode;
  documents: StudyDocument[];
  now?: number;
  id?: string;
  seed?: string;
  dataSource?: "firebase" | "snapshot";
}): PracticeAttempt {
  const examId = ExamIdSchema.parse(input.examId ?? "az104");
  const now = input.now ?? Date.now();
  if (!Number.isInteger(now) || now < 0) throw new Error("Attempt start time must be a non-negative integer");
  const expectedSizes = input.mode === "exam" ? [40] : [10, 20, 30, 40];
  if (!expectedSizes.includes(input.documents.length)) {
    throw new Error(
      `${input.mode === "exam" ? "Exam" : "Free practice"} requires ${
        input.mode === "exam" ? "40" : "10, 20, 30, or 40"
      } questions`,
    );
  }
  input.documents.forEach(validateDocument);
  input.documents.forEach((document) => assertExam(document, examId));
  const questionIds = input.documents.map((document) => document.question.id);
  if (!unique(questionIds)) throw new Error("Practice documents contain duplicate question IDs");
  const releaseId = input.documents[0]?.releaseId;
  if (releaseId === undefined ||
      input.documents.some((document) => document.releaseId !== releaseId)) {
    throw new Error("Practice documents must belong to one release");
  }

  const id = input.id ?? generatedId(now);
  if (!id) throw new Error("Attempt ID cannot be empty");
  const seed = input.seed ?? id;
  const optionOrders: Record<string, string[]> = {};
  const responses: Record<string, PracticeResponse> = {};
  for (const document of input.documents) {
    optionOrders[document.question.id] = optionOrder(document, seed);
    responses[document.question.id] = defaultResponse();
  }

  const attempt: PracticeAttempt = {
    schemaVersion: 1,
    ...(input.examId ? { examId } : {}),
    id,
    releaseId,
    ...(input.dataSource ? { dataSource: input.dataSource } : {}),
    mode: input.mode,
    size: input.documents.length,
    questionIds,
    optionOrders,
    responses,
    currentIndex: 0,
    startedAt: now,
    deadline: input.mode === "exam" ? now + examConfig(examId).mockDurationMinutes * 60_000 : null,
    finishedAt: null,
    status: "active",
    score: null,
  };
  return PracticeAttemptSchema.parse(attempt);
}

function documentMap(documents: StudyDocument[]): Map<string, StudyDocument> {
  const result = new Map<string, StudyDocument>();
  for (const document of documents) {
    validateDocument(document);
    if (result.has(document.question.id)) {
      throw new Error(`Duplicate document for question ${document.question.id}`);
    }
    result.set(document.question.id, document);
  }
  return result;
}

export function validateAttemptDocuments(
  attempt: PracticeAttempt,
  documents: StudyDocument[],
): void {
  PracticeAttemptSchema.parse(attempt);
  const byId = documentMap(documents);
  if (byId.size !== attempt.questionIds.length) {
    throw new Error("Restored attempt document count does not match its snapshot");
  }
  for (const questionId of attempt.questionIds) {
    const document = byId.get(questionId);
    if (document === undefined) throw new Error(`Restored attempt is missing question ${questionId}`);
    assertExam(document, examIdOf(attempt));
    if (document.releaseId !== attempt.releaseId) {
      throw new Error(`Question ${questionId} belongs to a different release`);
    }
    const validOptions = document.question.options.map((option) => option.id);
    const restoredOrder = attempt.optionOrders[questionId];
    if (restoredOrder === undefined || !unique(restoredOrder) ||
        !sameSet(restoredOrder, validOptions)) {
      throw new Error(`Question ${questionId} has an invalid restored option order`);
    }
    if (!document.question.shuffle.allowed &&
        !restoredOrder.every((value, index) => sourceOrderedOptionIds(document)[index] === value)) {
      throw new Error(`Question ${questionId} changed its fixed option order`);
    }
    const response = attempt.responses[questionId];
    if (response === undefined) throw new Error(`Question ${questionId} has no restored response`);
    const invalidSelection = response.selectedIds.find((id) => !validOptions.includes(id));
    if (invalidSelection !== undefined) {
      throw new Error(`Question ${questionId} response references unknown option ${invalidSelection}`);
    }
    if (document.question.kind === "single-select" && response.selectedIds.length > 1) {
      throw new Error(`Question ${questionId} has multiple restored single-select answers`);
    }
  }
  if (attempt.status === "completed") {
    const expected = computeScore(attempt, documents);
    if (JSON.stringify(expected) !== JSON.stringify(attempt.score)) {
      throw new Error(`Completed attempt ${attempt.id} has a score that does not match its responses`);
    }
  }
}

type Grade = {
  bucket: "automatic" | "provisional" | "manual";
  outcome: "correct" | "incorrect" | "unanswered";
  answered: boolean;
};

function gradeBucket(document: StudyDocument): Grade["bucket"] {
  if (document.question.readiness.grading === "manual" ||
      document.answers.effectiveAnswer.value.kind !== "option-selection") {
    return "manual";
  }
  if (document.answers.provisional) {
    return "provisional";
  }
  return "automatic";
}

export function gradeResponse(document: StudyDocument, response: PracticeResponse): Grade {
  validateDocument(document);
  const parsed = PracticeResponseSchema.parse(response);
  const validOptions = document.question.options.map((option) => option.id);
  const invalidSelection = parsed.selectedIds.find((id) => !validOptions.includes(id));
  if (invalidSelection !== undefined) {
    throw new Error(`Question ${document.question.id} response references unknown option ${invalidSelection}`);
  }
  const bucket = gradeBucket(document);
  if (bucket === "manual") {
    const outcome = parsed.selfAssessment === "correct" ? "correct"
      : parsed.selfAssessment === "incorrect" ? "incorrect"
      : "unanswered";
    return {
      bucket,
      outcome,
      answered: parsed.selfAssessment === "correct" || parsed.selfAssessment === "incorrect",
    };
  }
  if (parsed.selectedIds.length === 0) return { bucket, outcome: "unanswered", answered: false };
  const answer = document.answers.effectiveAnswer.value;
  if (answer.kind !== "option-selection") {
    throw new Error(`Question ${document.question.id} has no option answer key`);
  }
  return {
    bucket,
    outcome: sameSet(parsed.selectedIds, answer.optionIds) ? "correct" : "incorrect",
    answered: true,
  };
}

function emptyScore(totalQuestions: number): PracticeScore {
  const bucket = (): PracticeScoreBucket => ({ correct: 0, incorrect: 0, unanswered: 0, total: 0 });
  return { automatic: bucket(), provisional: bucket(), manual: bucket(), totalQuestions };
}

function computeScore(attempt: PracticeAttempt, documents: StudyDocument[]): PracticeScore {
  const byId = new Map(documents.map((document) => [document.question.id, document]));
  const score = emptyScore(attempt.size);
  for (const questionId of attempt.questionIds) {
    const document = byId.get(questionId);
    const response = attempt.responses[questionId];
    if (document === undefined || response === undefined) {
      throw new Error(`Cannot score missing question ${questionId}`);
    }
    const visibleResponse = attempt.mode === "free" && attempt.status === "active" && !response.submitted
      ? { ...response, selectedIds: [], selfAssessment: null }
      : response;
    const grade = gradeResponse(document, visibleResponse);
    const bucket = score[grade.bucket];
    bucket.total += 1;
    bucket[grade.outcome] += 1;
  }
  return score;
}

export function scoreAttempt(
  attempt: PracticeAttempt,
  documents: StudyDocument[],
): PracticeScore {
  validateAttemptDocuments(attempt, documents);
  return computeScore(attempt, documents);
}

function completedAttempt(
  attempt: PracticeAttempt,
  documents: StudyDocument[],
  finishedAt: number,
): PracticeAttempt {
  const completed: PracticeAttempt = {
    ...attempt,
    status: "completed",
    finishedAt,
    score: null,
  };
  completed.score = computeScore(completed, documents);
  return PracticeAttemptSchema.parse(completed);
}

function requireQuestion(
  attempt: PracticeAttempt,
  byId: Map<string, StudyDocument>,
  questionId: string,
): { document: StudyDocument; response: PracticeResponse } {
  if (!attempt.questionIds.includes(questionId)) {
    throw new Error(`Question ${questionId} is not part of this attempt`);
  }
  const document = byId.get(questionId);
  const response = attempt.responses[questionId];
  if (document === undefined || response === undefined) {
    throw new Error(`Question ${questionId} is missing from the attempt snapshot`);
  }
  return { document, response };
}

export function reduceAttempt(
  attempt: PracticeAttempt,
  action: PracticeAction,
  documents: StudyDocument[],
  now: number = Date.now(),
): PracticeAttempt {
  validateAttemptDocuments(attempt, documents);
  if (!Number.isInteger(now) || now < 0) throw new Error("Action time must be a non-negative integer");
  if (attempt.status === "active" && attempt.deadline !== null && now >= attempt.deadline) {
    const expired = completedAttempt(attempt, documents, attempt.deadline);
    if (action.type === "navigate" || action.type === "flag" || action.type === "self-assess") {
      return reduceAttempt(expired, action, documents, now);
    }
    return expired;
  }

  const byId = documentMap(documents);
  if (action.type === "navigate") {
    if (!Number.isInteger(action.index) || action.index < 0 || action.index >= attempt.size) {
      throw new Error(`Navigation index ${action.index} is outside the attempt`);
    }
    return { ...attempt, currentIndex: action.index };
  }
  if (action.type === "finish") {
    return attempt.status === "completed" ? attempt : completedAttempt(attempt, documents, now);
  }

  const { document, response } = requireQuestion(attempt, byId, action.questionId);
  if (action.type === "flag") {
    return {
      ...attempt,
      responses: {
        ...attempt.responses,
        [action.questionId]: { ...response, flagged: !response.flagged },
      },
    };
  }
  if (action.type === "self-assess") {
    if (gradeBucket(document) !== "manual") {
      throw new Error(`Question ${action.questionId} is automatically graded`);
    }
    if (attempt.status === "active" && (attempt.mode === "exam" || !response.submitted)) {
      throw new Error(`Question ${action.questionId} cannot be self-assessed before answer reveal`);
    }
    const updated: PracticeAttempt = {
      ...attempt,
      responses: {
        ...attempt.responses,
        [action.questionId]: { ...response, selfAssessment: action.value },
      },
    };
    if (updated.status === "completed") updated.score = computeScore(updated, documents);
    return PracticeAttemptSchema.parse(updated);
  }
  if (attempt.status === "completed") {
    throw new Error(`Completed attempt ${attempt.id} cannot change answers`);
  }
  if (attempt.mode === "free" && response.submitted &&
      (action.type === "select" || action.type === "note" || action.type === "skip")) {
    throw new Error(`Question ${action.questionId} is locked after answer reveal`);
  }

  let updatedResponse: PracticeResponse;
  switch (action.type) {
    case "select": {
      const validOptions = attempt.optionOrders[action.questionId];
      if (validOptions === undefined || !validOptions.includes(action.optionId)) {
        throw new Error(`Question ${action.questionId} has no option ${action.optionId}`);
      }
      if (document.question.kind === "manual") {
        throw new Error(`Manual question ${action.questionId} has no selectable options`);
      }
      if (document.question.kind === "single-select") {
        updatedResponse = {
          ...response,
          selectedIds: response.selectedIds[0] === action.optionId ? [] : [action.optionId],
        };
      } else {
        updatedResponse = {
          ...response,
          selectedIds: response.selectedIds.includes(action.optionId)
            ? response.selectedIds.filter((id) => id !== action.optionId)
            : [...response.selectedIds, action.optionId],
        };
      }
      break;
    }
    case "note":
      if (action.note.length > 4_000) {
        throw new Error(`Question ${action.questionId} note exceeds 4000 characters`);
      }
      updatedResponse = { ...response, note: action.note };
      break;
    case "submit":
      if (attempt.mode === "free" && gradeBucket(document) !== "manual" &&
          response.selectedIds.length === 0) {
        throw new Error(`Question ${action.questionId} requires an answer before submit`);
      }
      updatedResponse = { ...response, submitted: true };
      break;
    case "skip":
      updatedResponse = {
        ...response,
        selectedIds: [],
        submitted: true,
        selfAssessment: gradeBucket(document) === "manual" ? "skip" : response.selfAssessment,
      };
      break;
  }
  return {
    ...attempt,
    responses: { ...attempt.responses, [action.questionId]: updatedResponse },
  };
}

export function remainingSeconds(
  attempt: PracticeAttempt,
  now: number = Date.now(),
): number | null {
  if (attempt.deadline === null) return null;
  if (attempt.status === "completed") return 0;
  return Math.max(0, Math.ceil((attempt.deadline - now) / 1_000));
}
