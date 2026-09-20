import assert from "node:assert/strict";
import { test } from "node:test";
import { PreparedAnswerSchema, PreparedQuestionSchema } from "../src/domain/index.js";
import {
  PracticeAttemptSchema,
  createAttempt,
  gradeResponse,
  optionOrder,
  reduceAttempt,
  remainingSeconds,
  sampleQuestionIds,
  scoreAttempt,
  validateAttemptDocuments,
  type PracticeAttempt,
} from "../src/web/engine.js";
import {
  STORAGE_KEY,
  emptyPractice,
  readPractice,
  storeAttempt,
  writePractice,
  type SavedPractice,
} from "../src/web/storage.js";
import type { QuestionSummary, StudyDocument } from "../src/web/types.js";
import { cleanDocument } from "../tools/cleanup/freeze-bank.js";

const rich = (text: string) => [{ type: "text" as const, spans: [
  { type: "text" as const, text, marks: [] },
] }];
const hex = (value: number): string => value.toString(16).padStart(64, "0");

function fixture(index: number, settings: {
  kind?: "single-select" | "multi-select" | "manual";
  grading?: "automatic" | "manual";
  status?: "source-default" | "unresolved" | "outdated-or-defective";
  shuffle?: boolean;
  legacyMapping?: boolean;
} = {}): StudyDocument {
  const fingerprint = hex(index + 1);
  const questionId = `q_${fingerprint}`;
  const sourceRevision = hex(index + 10_000);
  const occurrenceId = `examprepper-45-q${String(index + 1).padStart(6, "0")}`;
  const kind = settings.kind ?? "single-select";
  const grading = settings.grading ?? (kind === "manual" ? "manual" : "automatic");
  const hashes = [hex(index * 10 + 1), hex(index * 10 + 2), hex(index * 10 + 3)];
  const options = kind === "manual" ? [] : hashes.map((contentHash, optionIndex) => ({
    id: `opt_${contentHash}`,
    contentHash,
    content: rich(`option ${optionIndex + 1}`),
  }));
  const labels = ["A", "B", "C"];
  const sourceOptionOrder = settings.legacyMapping === false || kind === "manual" ? [] : labels;
  const sourceLabelToOptionId = settings.legacyMapping === false || kind === "manual"
    ? {}
    : Object.fromEntries(labels.map((label, optionIndex) => [label, options[optionIndex]?.id]));
  const shuffle = settings.shuffle ?? true;
  const question = PreparedQuestionSchema.parse({
    schemaVersion: 1,
    id: questionId,
    exam: "AZ-104",
    fingerprint,
    sourceRevision,
    kind,
    prompt: rich(`question ${index + 1}`),
    options,
    shuffle: { allowed: shuffle, reasons: shuffle ? [] : ["label-reference"] },
    sourceOccurrenceIds: [occurrenceId],
    assetIds: [],
    commentCount: 0,
    review: {
      status: "pending", basedOnSourceRevision: null, reviewer: null, reviewedAt: null,
    },
    conversion: { status: "not-required", reason: null },
    readiness: { content: "complete", grading, publication: "blocked-review" },
    published: false,
    sourcePresentation: {
      kind,
      prompt: rich(`question ${index + 1}`),
      options,
      shuffle: { allowed: shuffle, reasons: shuffle ? [] : ["label-reference"] },
    },
    media: [],
    sources: [{
      questionNumber: index + 1,
      pageNumber: Math.floor(index / 5) + 1,
      url: `https://example.test/questions/${index + 1}`,
      sourceLabelToOptionId,
      sourceOptionOrder,
    }],
  });
  const value = kind === "manual"
    ? {
      kind: "manual" as const,
      reason: "non-choice-format" as const,
      sourceAnswerAssetIds: [],
    }
    : {
      kind: "option-selection" as const,
      optionIds: kind === "multi-select"
        ? [options[0]?.id, options[2]?.id]
        : [options[0]?.id],
    };
  const status = settings.status ?? "source-default";
  const provisional = status === "unresolved" || status === "outdated-or-defective";
  const answers = PreparedAnswerSchema.parse({
    schemaVersion: 1,
    id: questionId,
    questionId,
    sourceRevision,
    originalAnswers: [{
      sourceOccurrenceId: occurrenceId,
      value,
      sourceLabels: kind === "manual" ? [] : kind === "multi-select" ? ["A", "C"] : ["A"],
      explanation: rich("explanation"),
      answerAssetIds: [],
      provenance: {
        kind: "source-default",
        source: "examprepper",
        url: `https://example.test/questions/${index + 1}`,
        capturedAt: "2026-09-10T00:00:00.000Z",
        evidence: kind === "manual" ? "no-readable-key" : "rendered-green-border",
        verification: "not-independently-verified",
      },
    }],
    originalKeysConflict: false,
    effectiveAnswer: {
      value,
      basis: kind === "manual" ? "manual-required" : "source-default",
      sourceOccurrenceIds: [occurrenceId],
      verification: "not-independently-verified",
    },
    review: {
      status: "pending", basedOnSourceRevision: null, reviewer: null, reviewedAt: null,
    },
    published: false,
    assessment: {
      status,
      provisional,
      summary: provisional ? "Needs review" : "Source answer",
      warnings: provisional ? ["Answer is provisional"] : [],
      citations: [],
      sourceQuestionNumbers: [index + 1],
      originalImageAnswers: [],
      effectiveImageAnswerSummary: null,
    },
  });
  return cleanDocument(`r_${hex(999)}`, question, answers, 0);
}

const documents = (count: number, offset = 0): StudyDocument[] =>
  Array.from({ length: count }, (_, index) => fixture(index + offset));

function summary(document: StudyDocument): QuestionSummary {
  return {
    id: document.question.id,
    number: document.question.sources[0]?.questionNumber ?? 1,
    kind: document.question.kind,
    grading: document.question.readiness.grading,
    provisional: document.answers.provisional,
    commentCount: 0,
    omittedCommentCount: 0,
    hasImages: false,
    preview: "",
    searchText: "",
    discussionEnabled: false,
  };
}

test("sampling and attempt creation use valid distinct counts without filtering content", () => {
  const catalog = documents(50).map(summary);
  const first = sampleQuestionIds(catalog, 40, "catalog-seed");
  assert.equal(first.length, 40);
  assert.equal(new Set(first).size, 40);
  assert.deepEqual(first, sampleQuestionIds(catalog, 40, "catalog-seed"));
  assert.notDeepEqual(first, sampleQuestionIds(catalog, 40, "another-seed"));
  assert.throws(() => sampleQuestionIds(catalog, 51, "seed"), /only 50/);

  const exam = createAttempt({
    mode: "exam", documents: documents(40), now: 1_000, id: "exam", seed: "seed",
  });
  assert.equal(exam.size, 40);
  assert.equal(exam.deadline, 3_601_000);
  assert.equal(new Set(exam.questionIds).size, 40);
  for (const count of [10, 20, 30, 40]) {
    assert.equal(createAttempt({
      mode: "free", documents: documents(count), id: `free-${count}`,
    }).size, count);
  }
  assert.throws(() => createAttempt({
    mode: "free", documents: documents(11), id: "bad",
  }), /10, 20, 30, or 40/);

  const mixed = documents(10);
  mixed[0] = fixture(0, { kind: "manual" });
  mixed[1] = fixture(1, { status: "unresolved" });
  const included = createAttempt({ mode: "free", documents: mixed, id: "mixed" });
  assert.ok(included.questionIds.includes(mixed[0].question.id));
  assert.ok(included.questionIds.includes(mixed[1].question.id));
});

test("option order is deterministic, serialization-stable, and respects fixed source order", () => {
  const shuffledDocument = fixture(0);
  const first = optionOrder(shuffledDocument, "one");
  assert.deepEqual(first, optionOrder(shuffledDocument, "one"));
  assert.notDeepEqual(first, optionOrder(shuffledDocument, "a substantially different seed"));

  const attempt = createAttempt({
    mode: "free", documents: documents(10), id: "stable", seed: "one",
  });
  const restored = PracticeAttemptSchema.parse(JSON.parse(JSON.stringify(attempt)));
  assert.deepEqual(restored.optionOrders, attempt.optionOrders);

  const fixed = fixture(50, { shuffle: false });
  assert.deepEqual(
    optionOrder(fixed, "ignored"),
    fixed.question.fixedOptionOrder,
  );
  const converted = fixture(51, { shuffle: false, legacyMapping: false });
  assert.deepEqual(optionOrder(converted, "ignored"), converted.question.options.map(({ id }) => id));
  const reordered = structuredClone(fixed);
  reordered.question.options.reverse();
  assert.deepEqual(optionOrder(reordered, "ignored"), fixed.question.fixedOptionOrder,
    "The immutable stored ID order must not depend on current option array order");
  const invalid = structuredClone(fixed);
  invalid.question.fixedOptionOrder[0] = invalid.question.fixedOptionOrder[1]!;
  assert.throws(() => optionOrder(invalid, "ignored"), /fixed option order/);
});

test("single and multi selection are immutable and reject foreign IDs", () => {
  const docs = documents(10);
  docs[1] = fixture(1, { kind: "multi-select" });
  const original = createAttempt({ mode: "free", documents: docs, id: "selection" });
  const singleDocument = docs[0]!;
  const multiDocument = docs[1]!;
  const singleId = singleDocument.question.id;
  const [firstOption, secondOption] = singleDocument.question.options.map(({ id }) => id);
  const selected = reduceAttempt(original, {
    type: "select", questionId: singleId, optionId: firstOption!,
  }, docs);
  assert.deepEqual(original.responses[singleId]?.selectedIds, []);
  const replaced = reduceAttempt(selected, {
    type: "select", questionId: singleId, optionId: secondOption!,
  }, docs);
  assert.deepEqual(replaced.responses[singleId]?.selectedIds, [secondOption]);
  const toggledOff = reduceAttempt(replaced, {
    type: "select", questionId: singleId, optionId: secondOption!,
  }, docs);
  assert.deepEqual(toggledOff.responses[singleId]?.selectedIds, []);

  const multiId = multiDocument.question.id;
  const [multiA, multiB] = multiDocument.question.options.map(({ id }) => id);
  let multi = reduceAttempt(original, {
    type: "select", questionId: multiId, optionId: multiA!,
  }, docs);
  multi = reduceAttempt(multi, {
    type: "select", questionId: multiId, optionId: multiB!,
  }, docs);
  assert.deepEqual(multi.responses[multiId]?.selectedIds, [multiA, multiB]);
  multi = reduceAttempt(multi, {
    type: "select", questionId: multiId, optionId: multiA!,
  }, docs);
  assert.deepEqual(multi.responses[multiId]?.selectedIds, [multiB]);
  assert.throws(() => reduceAttempt(original, {
    type: "select", questionId: singleId, optionId: "foreign-option",
  }, docs), /no option/);
  assert.throws(() => reduceAttempt(original, {
    type: "note", questionId: "foreign-question", note: "",
  }, docs), /not part/);
  assert.throws(() => reduceAttempt(original, {
    type: "note", questionId: singleId, note: "x".repeat(4_001),
  }, docs), /4000/);
});

test("free reveal locks answers while exam selections remain private and editable", () => {
  const docs = documents(40);
  const freeDocs = docs.slice(0, 10);
  const firstDocument = freeDocs[0]!;
  const questionId = firstDocument.question.id;
  const optionId = firstDocument.question.options[0]!.id;
  let free = createAttempt({ mode: "free", documents: freeDocs, id: "free-lock" });
  assert.throws(() => reduceAttempt(free, { type: "submit", questionId }, freeDocs), /requires an answer/);
  free = reduceAttempt(free, { type: "select", questionId, optionId }, freeDocs);
  free = reduceAttempt(free, { type: "submit", questionId }, freeDocs);
  assert.equal(free.responses[questionId]?.submitted, true);
  assert.throws(() => reduceAttempt(free, { type: "select", questionId, optionId }, freeDocs), /locked/);
  assert.throws(() => reduceAttempt(free, { type: "note", questionId, note: "late" }, freeDocs), /locked/);
  assert.throws(() => reduceAttempt(free, { type: "skip", questionId }, freeDocs), /locked/);

  let exam = createAttempt({ mode: "exam", documents: docs, id: "exam-private" });
  exam = reduceAttempt(exam, { type: "select", questionId, optionId }, docs);
  assert.equal(exam.responses[questionId]?.submitted, false);
  exam = reduceAttempt(exam, { type: "submit", questionId }, docs);
  assert.equal(exam.responses[questionId]?.submitted, true);
  assert.doesNotThrow(() =>
    reduceAttempt(exam, { type: "select", questionId, optionId }, docs));
});

test("exam timer is wall-clock based, freezes at deadline, and discards late answers", () => {
  const docs = documents(40);
  const attempt = createAttempt({
    mode: "exam", documents: docs, now: 10_000, id: "timer",
  });
  assert.equal(remainingSeconds(attempt, 10_000), 3_600);
  assert.equal(remainingSeconds(attempt, 3_609_500), 1);
  assert.equal(remainingSeconds(attempt, 3_610_000), 0);
  const firstDocument = docs[0]!;
  const questionId = firstDocument.question.id;
  const optionId = firstDocument.question.options[0]!.id;
  const expired = reduceAttempt(attempt, {
    type: "select", questionId, optionId,
  }, docs, 3_610_001);
  assert.equal(expired.status, "completed");
  assert.equal(expired.finishedAt, attempt.deadline);
  assert.deepEqual(expired.responses[questionId]?.selectedIds, []);
  assert.equal(expired.score?.automatic.unanswered, 40);
  assert.equal(remainingSeconds(expired, 99_999_999), 0);

  const serialized = PracticeAttemptSchema.parse(JSON.parse(JSON.stringify(attempt)));
  assert.equal(serialized.deadline, attempt.deadline);
});

test("automatic, provisional, and manual scoring remain separate", () => {
  const docs = documents(10);
  docs[1] = fixture(1, { status: "unresolved" });
  docs[2] = fixture(2, { kind: "manual" });
  let attempt = createAttempt({ mode: "free", documents: docs, id: "score", now: 10_000 });
  const autoDocument = docs[0]!;
  const provisionalDocument = docs[1]!;
  const manualDocument = docs[2]!;
  const autoId = autoDocument.question.id;
  const provisionalId = provisionalDocument.question.id;
  const manualId = manualDocument.question.id;
  attempt = reduceAttempt(attempt, {
    type: "select", questionId: autoId, optionId: autoDocument.question.options[0]!.id,
  }, docs);
  attempt = reduceAttempt(attempt, {
    type: "select", questionId: provisionalId,
    optionId: provisionalDocument.question.options[1]!.id,
  }, docs);
  attempt = reduceAttempt(attempt, { type: "submit", questionId: manualId }, docs);
  assert.throws(() => reduceAttempt(
    createAttempt({ mode: "free", documents: docs, id: "too-soon" }),
    { type: "self-assess", questionId: manualId, value: "correct" },
    docs,
  ), /before answer reveal/);
  attempt = reduceAttempt(attempt, {
    type: "self-assess", questionId: manualId, value: "correct",
  }, docs);

  assert.deepEqual(gradeResponse(autoDocument, attempt.responses[autoId]!), {
    bucket: "automatic", outcome: "correct", answered: true,
  });
  assert.deepEqual(gradeResponse(provisionalDocument, attempt.responses[provisionalId]!), {
    bucket: "provisional", outcome: "incorrect", answered: true,
  });
  assert.deepEqual(gradeResponse(manualDocument, attempt.responses[manualId]!), {
    bucket: "manual", outcome: "correct", answered: true,
  });
  assert.deepEqual(gradeResponse(manualDocument, {
    ...attempt.responses[manualId]!, selfAssessment: "skip",
  }), {
    bucket: "manual", outcome: "unanswered", answered: false,
  });
  const multiDocument = fixture(50, { kind: "multi-select" });
  const multiKey = multiDocument.answers.effectiveAnswer.value;
  assert.equal(multiKey.kind, "option-selection");
  if (multiKey.kind === "option-selection") {
    assert.equal(gradeResponse(multiDocument, {
      selectedIds: [...multiKey.optionIds].reverse(),
      note: "",
      submitted: true,
      flagged: false,
      selfAssessment: null,
    }).outcome, "correct");
    assert.equal(gradeResponse(multiDocument, {
      selectedIds: multiKey.optionIds.slice(0, 1),
      note: "",
      submitted: true,
      flagged: false,
      selfAssessment: null,
    }).outcome, "incorrect");
  }
  const activeScore = scoreAttempt(attempt, docs);
  assert.equal(activeScore.automatic.correct, 0, "unsubmitted free answers are not graded while active");
  attempt = reduceAttempt(attempt, { type: "finish" }, docs, 20_000);
  assert.equal(attempt.score?.automatic.correct, 1);
  assert.equal(attempt.score?.provisional.incorrect, 1);
  assert.equal(attempt.score?.manual.correct, 1);
  assert.equal(
    (attempt.score?.automatic.total ?? 0) +
      (attempt.score?.provisional.total ?? 0) +
      (attempt.score?.manual.total ?? 0),
    10,
  );
  const reassessed = reduceAttempt(attempt, {
    type: "self-assess", questionId: manualId, value: "incorrect",
  }, docs, 30_000);
  assert.equal(reassessed.finishedAt, 20_000);
  assert.equal(reassessed.score?.manual.incorrect, 1);
  assert.equal(reassessed.score?.automatic.correct, 1);
  assert.throws(() => reduceAttempt(reassessed, {
    type: "select", questionId: autoId, optionId: autoDocument.question.options[0]!.id,
  }, docs), /cannot change answers/);
});

test("restore validation rejects release, ordering, and selected-option mismatches", () => {
  const docs = documents(10);
  const attempt = createAttempt({ mode: "free", documents: docs, id: "restore" });
  const wrongRelease = structuredClone(docs);
  wrongRelease[0] = { ...wrongRelease[0]!, releaseId: `r_${hex(123)}` };
  assert.throws(() => validateAttemptDocuments(attempt, wrongRelease), /different release/);

  const questionId = docs[0]!.question.id;
  const badOrder: PracticeAttempt = structuredClone(attempt);
  badOrder.optionOrders[questionId] = ["not-an-option"];
  assert.throws(() => validateAttemptDocuments(badOrder, docs), /invalid restored option order/);

  const badAnswer: PracticeAttempt = structuredClone(attempt);
  badAnswer.responses[questionId]!.selectedIds = ["not-an-option"];
  assert.throws(() => validateAttemptDocuments(badAnswer, docs), /unknown option|invalid_type/);
});

test("storage warns without deleting malformed data or hiding persistence failures", () => {
  let raw = "{not-json";
  let removals = 0;
  const storage = {
    getItem: (key: string) => key === STORAGE_KEY ? raw : null,
    setItem: (_key: string, value: string) => { raw = value; },
    removeItem: () => { removals += 1; },
  };
  const malformed = readPractice(storage);
  assert.deepEqual(malformed.state, emptyPractice());
  assert.match(malformed.warning ?? "", /unavailable/);
  assert.equal(raw, "{not-json");
  assert.equal(removals, 0);
  raw = JSON.stringify({ schemaVersion: 1, activeAttempt: { broken: true }, history: [] });
  assert.match(readPractice(storage).warning ?? "", /invalid/);
  assert.equal(removals, 0);

  assert.match(readPractice({
    getItem: () => { throw new Error("denied"); },
  }).warning ?? "", /unavailable/);
  assert.match(writePractice({
    setItem: () => { throw new Error("quota"); },
  }, emptyPractice()) ?? "", /remain in memory/);
  assert.equal(writePractice(storage, emptyPractice()), null);
  assert.deepEqual(readPractice(storage).state, emptyPractice());
});

test("history is capped, upserts by ID, and preserves an unrelated active attempt", () => {
  const docs = documents(10);
  const completed = (index: number): PracticeAttempt => reduceAttempt(
    createAttempt({ mode: "free", documents: docs, id: `history-${index}`, now: index }),
    { type: "finish" },
    docs,
    index + 1,
  );
  let state: SavedPractice = emptyPractice();
  for (let index = 0; index < 25; index += 1) state = storeAttempt(state, completed(index));
  assert.equal(state.history.length, 20);
  assert.equal(state.history[0]?.id, "history-24");

  const updated = structuredClone(state.history[5]!);
  const questionId = updated.questionIds[0]!;
  updated.responses[questionId]!.flagged = true;
  state = storeAttempt(state, updated);
  assert.equal(state.history[0]?.id, updated.id);
  assert.equal(state.history.filter(({ id }) => id === updated.id).length, 1);

  const active = createAttempt({ mode: "free", documents: docs, id: "other-active" });
  state = storeAttempt(state, active);
  state = storeAttempt(state, completed(100));
  assert.equal(state.activeAttempt?.id, "other-active");
  assert.equal(state.history.length, 20);
});
