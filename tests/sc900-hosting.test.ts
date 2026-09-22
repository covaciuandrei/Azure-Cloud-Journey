import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createSc900DemoBank } from "../tools/demo/sc900-fixtures.js";
import { Sc900CaptureLedgerSchema } from "../src/domain/sc900Capture.js";
import { Sc900DocumentSchema } from "../src/domain/sc900Bank.js";
import {
  buildSc900StaticPlan, prepareSc900Release, sc900OriginalKeyDigest, sc900ReviewTargets,
  type Sc900PublicationInput,
} from "../tools/sc900/publication.js";
import { sc900Hash, sc900QuestionId, sc900SourceRevision } from "../tools/sc900/canonical.js";
import { loadSc900HostingPublication, selectSc900HostingPublication } from "../tools/web/sc900-publication.js";
import { publicationFileBytes } from "../tools/learning/publication.js";
import { loadCoursePublication } from "../tools/course/publication.js";
import { buildOfflineManifest } from "../tools/web/offline-manifest.js";
import { fullCourseInputs } from "./full-course-fixture.js";
import { writeData } from "../tools/review/data.js";
import { digest } from "../tools/ingest/normalize-shared.js";

const at = "2026-09-22T00:00:00.000Z";
const note = "Synthetic approval used only by isolated original fixture tests. It does not authorize a factual production course or any real source bank.";

function publicationFixture(seed: string) {
  const demo = createSc900DemoBank();
  const ledger = Sc900CaptureLedgerSchema.parse({
    schemaVersion: 1, examId: "sc900", sourceExamId: "128", captureMethod: "rendered-browser-ui",
    verified: true, sourceUrl: "https://www.examprepper.co/exam/128/1", capturedAt: at,
    reported: { questions: 40, pages: 8 },
    pages: Array.from({ length: 8 }, (_, page) => ({
      pageNumber: page + 1, url: `https://www.examprepper.co/exam/128/${page + 1}`,
      rawSha256: sc900Hash("synthetic-page", { seed, page }),
      questionNumbers: Array.from({ length: 5 }, (_, index) => page * 5 + index + 1),
    })),
    occurrences: Array.from({ length: 40 }, (_, index) => ({
      id: `examprepper-128-q${String(index + 1).padStart(6, "0")}`, questionNumber: index + 1,
      pageNumber: Math.floor(index / 5) + 1, answerRevealed: true, discussionState: "loaded",
      expectedCommentCount: 0, parsedCommentCount: 0, commentIds: [], assetIds: [],
    })), assets: [],
  });
  const sourceRevision = sc900SourceRevision(ledger);
  const documents = Array.from({ length: 40 }, (_, index) => {
    const document = structuredClone(demo.documents[index % 10]!);
    const occurrence = ledger.occurrences[index]!;
    document.question.prompt.push({ type: "text", spans: [
      { type: "text", text: `Original synthetic integration fixture ${seed} ${index + 1}.`, marks: [] },
    ] });
    document.question.id = sc900QuestionId(document.question);
    document.question.sourceRevision = sourceRevision;
    document.question.sourceOccurrenceIds = [occurrence.id];
    document.question.sources = [{ questionNumber: index + 1, pageNumber: occurrence.pageNumber,
      url: `https://www.examprepper.co/exam/128/${occurrence.pageNumber}` }];
    document.answers.id = document.question.id;
    document.answers.questionId = document.question.id;
    document.answers.sourceRevision = sourceRevision;
    document.answers.originalAnswers[0]!.sourceOccurrenceId = occurrence.id;
    document.answers.originalAnswers[0]!.provenance.url = document.question.sources[0]!.url;
    return Sc900DocumentSchema.parse(document);
  });
  const input: Sc900PublicationInput & { expectedCapture: { questions: number; pages: number; receiptSha256: string } } = {
    ledger, documents, assets: new Map(),
    expectedCapture: { questions: 40, pages: 8, receiptSha256: sc900Hash("synthetic-source-scope", { questions: 40, pages: 8 }) },
    discussions: documents.map((document) => ({
      schemaVersion: 1, examId: "sc900", releaseId: document.releaseId, questionId: document.question.id, comments: [],
    })),
    topics: { ...demo.topics, sourceRevision,
      assignments: Object.fromEntries(documents.map((document) => [document.question.id, ["sc-security-concepts"]])) },
    learning: { schemaVersion: 1, examId: "sc900", bankVersion: "sc900-approved-v1",
      releaseId: demo.manifest.releaseId, baseReleaseId: demo.manifest.releaseId, sourceRevision,
      explanations: documents.map((document, index) => ({
        ...demo.explanations[index % 10]!, questionId: document.question.id,
        questionSourceRevision: sourceRevision, originalKeyDigest: sc900OriginalKeyDigest(document),
      })) },
    eligibility: {
      schemaVersion: 1, examId: "sc900", bankVersion: "sc900-approved-v1",
      policyId: `e_${"0".repeat(64)}`, releaseId: demo.manifest.releaseId, teachingReleaseId: demo.manifest.releaseId,
      sourceRevision, reviewedAt: "2026-09-22",
      reviewedQuestionIds: documents.map((item) => item.question.id), activeQuestionIds: documents.map((item) => item.question.id),
      activeCounts: { questions: 40, comments: 0, images: 0, automatic: 40, manual: 0,
        sourceQuestions: 40, duplicatesGrouped: 0, omittedComments: 0 }, retired: [],
    },
  };
  const release = prepareSc900Release(input);
  const plan = buildSc900StaticPlan(input, {
    schemaVersion: 1, examId: "sc900", releaseId: release.manifest.releaseId, sourceRevision,
    captureLedgerDigest: release.manifest.captureLedgerDigest, reviewer: "Synthetic content review", reviewedAt: at,
    decision: "approved", checks: { allPages: true, allAnswers: true, allComments: true,
      allAssets: true, topics: true, learning: true, relevance: true }, questions: sc900ReviewTargets(release),
  });
  return { plan, finalReview: {
    schemaVersion: 1 as const, examId: "sc900" as const, releaseId: plan.release.manifest.releaseId,
    planDigest: plan.planDigest, reviewDigest: plan.reviewDigest, reviewer: "Synthetic independent final reviewer",
    reviewedAt: at, independent: true as const, decision: "approve-activation" as const,
  } };
}

async function writeSyntheticCourse(root: string) {
  const input = await fullCourseInputs("sc900");
  await writeData("content/sc900/curriculum.json", input.curriculum, root);
  await writeData("content/sc900/objectives.json", input.objectives, root);
  for (const module of input.modules) {
    await writeData(input.curriculum.modules.find((entry) => entry.id === module.id)!.sourcePath, module, root);
  }
  for (const coverage of input.coverage) await writeData(`content/sc900/coverage/${coverage.domainId}.json`, coverage, root);
  for (const domain of input.domains) await writeData(`content/sc900/review-approvals/${domain.id}.json`,
    input.modules.filter((module) => domain.moduleIds.includes(module.id)).map((module) => ({
      id: module.id, digest: digest(module), note,
    })), root);
  await writeData("content/sc900/review-approvals/metadata.json", {
    schemaVersion: 1, reviewedAt: "2026-09-22", reviewer: "coordinator",
    curriculumDigest: digest(input.curriculum), objectivesDigest: digest(input.objectives), coverageDigest: digest(input.coverage), note,
  }, root);
  const course = await loadCoursePublication(root, "sc900");
  await writeData("content/sc900/review-approvals/activation.json", {
    schemaVersion: 1, examId: "sc900", approved: true, reviewer: "coordinator", reviewedAt: "2026-09-22",
    releaseId: course.course.releaseId, sha256: course.pointer.sha256, note,
  }, root);
}

test("SC900 Hosting selection is inactive until exact bank and course approvals and retains archived releases", async () => {
  const root = resolve(`.data/sc900-hosting-test-${randomUUID()}`);
  try {
    await mkdir(root, { recursive: true });
    const inactive = await loadSc900HostingPublication(root);
    assert.equal(inactive.active, false);
    assert.deepEqual([...inactive.files.keys()], ["exams/sc900/availability.json"]);
    const first = publicationFixture("one");
    await assert.rejects(selectSc900HostingPublication(first.plan, first.finalReview, root), /ENOENT/);
    assert.equal((await loadSc900HostingPublication(root)).active, false);
    await writeSyntheticCourse(root);
    const selected = await selectSc900HostingPublication(first.plan, first.finalReview, root);
    assert.equal(selected.active, true);
    assert.equal(JSON.parse((await readFile(resolve(root, `.data/sc900-publication/${first.plan.release.manifest.releaseId}/approval-receipt.json`))).toString()).activate, false);
    const second = publicationFixture("two");
    const updated = await selectSc900HostingPublication(second.plan, second.finalReview, root);
    for (const plan of [first.plan, second.plan]) {
      assert.ok(updated.files.has(`exams/sc900/content/${plan.release.manifest.releaseId}/catalog.json`));
    }
    for (const [path, file] of updated.files) {
      await mkdir(dirname(resolve(root, "dist", path)), { recursive: true });
      await writeFile(resolve(root, "dist", path), await publicationFileBytes(file));
    }
    for (const [path, bytes] of [["index.html", '<script src="/assets/app-abcdef12.js"></script>'],
      ["assets/app-abcdef12.js", "/* original synthetic application fixture */"],
      ["favicon.svg", "<svg/>"], ["offline-worker.js", "/* original synthetic worker fixture */"]] as const) {
      await mkdir(dirname(resolve(root, "dist", path)), { recursive: true });
      await writeFile(resolve(root, "dist", path), bytes);
    }
    const offline = await buildOfflineManifest(root, "dist", "sc900");
    assert.equal(offline.releaseId, second.plan.release.manifest.releaseId);
    assert.ok(offline.files.some((file) => file.url === "/exams/sc900/availability.json"));
    assert.ok(offline.files.some((file) => file.releaseId === first.plan.release.manifest.releaseId && file.part === "catalog"));
    const savedSelection = await readFile(resolve(root, ".data/sc900-publication/hosting.json"));
    const staged = resolve(root, `.data/sc900-publication/${first.plan.release.manifest.releaseId}/exams/sc900/content/${first.plan.release.manifest.releaseId}/catalog.json`);
    await writeFile(staged, "{}");
    await assert.rejects(loadSc900HostingPublication(root), /hash or length differs/);
    await assert.rejects(selectSc900HostingPublication(second.plan, second.finalReview, root), /hash or length differs/);
    assert.deepEqual(await readFile(resolve(root, ".data/sc900-publication/hosting.json")), savedSelection);
  } finally { await rm(root, { recursive: true, force: true }); }
});
