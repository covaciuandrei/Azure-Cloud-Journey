import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Sc900DocumentSchema } from "../src/domain/sc900Bank.js";
import { CleanDocumentSchema } from "../src/domain/cleanBank.js";
import { createSc900DemoBank } from "../tools/demo/sc900-fixtures.js";
import { createDemoBank } from "../tools/demo/fixtures.js";
import { createStudyRepository } from "../src/web/data.js";
import { createDemoRepository } from "../src/web/demo-repository.js";
import { PracticeAttemptSchema, createAttempt, remainingSeconds, reduceAttempt, validateAttemptDocuments } from "../src/web/engine.js";
import { parseLearningRoute } from "../src/web/course/navigation.js";
import { emptyPractice, readPractice, storeAttempt, writePractice } from "../src/web/storage.js";
import { checkSc900Availability } from "../src/web/exam-availability.js";
import { SC900_INACTIVE } from "../src/domain/examAvailability.js";
import { Setup } from "../src/web/ui/Setup.js";
import { ExamSelection } from "../src/web/ui/ExamSelection.js";
import { approvedStudyPath } from "../src/web/firestore-source.js";
import { courseFixture } from "./course-fixture.js";
import type { StudyDocument } from "../src/web/types.js";

const bank = createSc900DemoBank();
const az = createDemoBank();
const azDocuments = az.release.documents;
const fetchSc900: typeof fetch = async (input) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const path = url.pathname.replace(/^\/app\/exams\/sc900\//, "");
  const value = bank.files.get(path);
  return value === undefined ? new Response("missing", { status: 404 }) : Response.json(value);
};

test("SC900 synthetic fixtures are explicitly isolated and never parse as AZ104", () => {
  assert.equal(bank.documents.length, 10);
  assert.equal(bank.metadata.kind, "original-synthetic-demo");
  for (const document of bank.documents) {
    assert.equal(Sc900DocumentSchema.parse(document).examId, "sc900");
    assert.equal(CleanDocumentSchema.safeParse(document).success, false);
    assert.equal(document.question.sourceOccurrenceIds[0]?.startsWith("examprepper-128-"), true);
  }
  assert.equal(Sc900DocumentSchema.safeParse(azDocuments[0]).success, false);
});

test("SC900 repository resolves immutable topics and teaching within its scoped app base", async () => {
  const repository = createDemoRepository("https://example.test/app/", fetchSc900, "sc900");
  const catalog = await repository.loadCatalog();
  assert.equal(catalog.examId, "sc900");
  const document = await repository.loadQuestion(catalog.questions[0]!.id, catalog.releaseId);
  assert.equal(document.topicIds?.[0], "sc-identity-concepts");
  const learning = await repository.loadExplanation!(document);
  assert.equal(learning.explanation.questionId, document.question.id);
  assert.equal((await repository.loadDiscussion(document.question.id)).comments.length, 0);
  const crossExam: typeof fetch = async () => Response.json(az.manifest);
  await assert.rejects(createStudyRepository("https://example.test/app/", crossExam, "sc900").loadCatalog());
});

function forty(): StudyDocument[] {
  return Array.from({ length: 40 }, (_, index) => {
    const document = structuredClone(bank.documents[index % 10]!);
    const id = `q_${(index + 1000).toString(16).padStart(64, "0")}`;
    document.question.id = id;
    document.answers.id = id;
    document.answers.questionId = id;
    return document;
  });
}

test("SC900 mock is 40 questions and 45 minutes, with wall-clock expiry after switching", () => {
  const documents = forty();
  const attempt = createAttempt({ examId: "sc900", mode: "exam", documents, now: 1000, id: "sc-test" });
  assert.equal(attempt.deadline, 2_701_000);
  assert.equal(remainingSeconds(attempt, 61_000), 2640);
  assert.equal(remainingSeconds(attempt, 2_701_100), 0);
  const completed = reduceAttempt(attempt, { type: "finish" }, documents, 2_701_100);
  assert.equal(completed.finishedAt, attempt.deadline);
  assert.equal(PracticeAttemptSchema.safeParse({ ...attempt, examId: undefined }).success, false);
  const azExam = { ...attempt, examId: "az104", deadline: attempt.startedAt + 3_600_000 };
  assert.equal(PracticeAttemptSchema.safeParse(azExam).success, true);
  assert.throws(() => validateAttemptDocuments(PracticeAttemptSchema.parse(azExam), documents), /different exam/);
  assert.throws(() => createAttempt({ mode: "free", documents: bank.documents }));
  assert.throws(() => createAttempt({ mode: "free", examId: "sc900", documents: azDocuments }));
});

test("legacy AZ104 guest state and namespaced SC900 active attempts survive independent writes", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); } };
  const legacy = createAttempt({ mode: "free", documents: azDocuments, id: "same-local-id" });
  const sc900 = createAttempt({ examId: "sc900", mode: "free", documents: bank.documents, id: "same-local-id" });
  assert.equal(legacy.examId, undefined);
  assert.equal(writePractice(storage, storeAttempt(emptyPractice(), legacy)), null);
  const prior = [...values.entries()];
  assert.equal(writePractice(storage, storeAttempt(emptyPractice("sc900"), sc900, "sc900"), undefined, "sc900"), null);
  assert.equal(readPractice(storage).state.activeAttempt?.examId, undefined);
  assert.equal(readPractice(storage, undefined, "sc900").state.activeAttempt?.examId, "sc900");
  assert.equal(values.get(prior[0]![0]), prior[0]![1]);
  assert.throws(() => storeAttempt(emptyPractice("sc900"), legacy, "sc900"), /exam/i);
});

test("legacy hashes retain their route shape and SC900 hashes carry explicit exam context", () => {
  assert.deepEqual(parseLearningRoute("#home"), { section: "welcome", lessonId: null, error: null });
  assert.deepEqual(parseLearningRoute("#learn/virtual-networks"), { section: "learn", lessonId: "virtual-networks", error: null });
  assert.deepEqual(parseLearningRoute("#/sc900/practice"), { examId: "sc900", section: "practice", lessonId: null, error: null });
  assert.equal(parseLearningRoute("#/sc900/learn/sc-zero-trust-crypto-and-grc").lessonId, "sc-zero-trust-crypto-and-grc");
  assert.ok(parseLearningRoute("#/sc900/learn/../../home").error);
});

test("SC900 activation defaults off without fetching draft course or bank", async () => {
  let loaded = false;
  const unavailable = await checkSc900Availability("https://example.test/app/", async () => {
    loaded = true; return courseFixture();
  }, async () => { loaded = true; return bank.catalog; }, false, async () => Response.json(SC900_INACTIVE));
  assert.equal(unavailable.status, "unavailable");
  assert.equal(loaded, false);
  const demoRecord = { schemaVersion: 1, examId: "sc900", activated: true, kind: "original-synthetic-demo",
    bankReleaseId: bank.manifest.releaseId, courseReleaseId: "c_" + "a".repeat(64),
    sourceCaptureDigest: bank.manifest.captureLedgerDigest, approvedBy: "synthetic-test", approvedAt: "2026-09-22T00:00:00.000Z" };
  await assert.rejects(checkSc900Availability("https://example.test/app/", async () => courseFixture(),
    async () => bank.catalog, false, async () => Response.json(demoRecord)), /different application mode/);
});

test("SC900 controls show 45 minutes and remain disabled without approved availability", () => {
  const catalog = { ...bank.catalog, questions: bank.catalog.questions.map((question) => ({
    ...question, topicIds: bank.topics.assignments[question.id]!,
  })) };
  const setup = renderToStaticMarkup(createElement(Setup, { mode: "exam", catalog, onStart() {} }));
  assert.match(setup, /45 minutes/);
  assert.doesNotMatch(setup, /60 minutes/);
  const chooser = renderToStaticMarkup(createElement(ExamSelection, { onSelect() {} }));
  assert.match(chooser, /disabled=""[^>]*>Select SC-900/);
});

test("Firestore paths cannot cross exam boundaries", () => {
  const release = "r_" + "a".repeat(64);
  const id = "q_" + "b".repeat(64);
  assert.equal(approvedStudyPath(`studyBanks/sc900/releases/${release}/questions/${id}`, "sc900"), true);
  assert.equal(approvedStudyPath(`studyBanks/sc900/releases/${release}/questions/${id}`, "az104"), false);
  assert.equal(approvedStudyPath(`studyReleases/${release}/questions/${id}`, "sc900"), false);
  assert.equal(approvedStudyPath("studyMetadata/az104Bank", "sc900"), false);
  assert.equal(approvedStudyPath("users/foreign/state/active", "sc900"), false);
});
