import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { Sc900DocumentSchema } from "../src/domain/sc900Bank.js";
import { selectOfflineFiles } from "../src/domain/offline.js";
import { Sc900CaptureLedgerSchema, sc900OccurrenceId } from "../src/domain/sc900Capture.js";
import { fullCourseInputs } from "./full-course-fixture.js";
import { digest } from "../tools/ingest/normalize-shared.js";
import { loadCoursePublication } from "../tools/course/publication.js";
import { sc900Hash, sc900QuestionId, sc900SourceRevision } from "../tools/sc900/canonical.js";
import {
  buildSc900StaticPlan, createSc900ApprovalReceipt, prepareSc900Release, sc900OriginalKeyDigest,
  stageSc900Publication, writeSc900FinalApproval, type Sc900PublicationInput,
} from "../tools/sc900/publication.js";
import { sc900BankFixture, sc900BankReview } from "./sc900-bank-fixture.js";
import { hash, json } from "../tools/web/bank.js";
import { buildOfflineManifest, exportOfflineManifest, selectedOfflineExamIds } from "../tools/web/offline-manifest.js";
import { loadSc900HostingPublication } from "../tools/web/sc900-publication.js";
import { publicationFileBytes } from "../tools/learning/publication.js";

const approvalNote = "Synthetic offline packaging test approval only. These original fictional fixtures never authorize any production publication or factual course review.";

async function write(root: string, path: string, bytes: string | Uint8Array) {
  await mkdir(dirname(resolve(root, path)), { recursive: true });
  await writeFile(resolve(root, path), bytes);
}

async function courseFixture(root: string) {
  const inputs = await fullCourseInputs("sc900");
  await write(root, "content/sc900/curriculum.json", json(inputs.curriculum));
  await write(root, "content/sc900/objectives.json", json(inputs.objectives));
  for (const module of inputs.modules) {
    await write(root, inputs.curriculum.modules.find((entry) => entry.id === module.id)!.sourcePath, json(module));
  }
  for (const domain of inputs.domains) {
    await write(root, `content/sc900/review-approvals/${domain.id}.json`, json(inputs.modules
      .filter((module) => domain.moduleIds.includes(module.id))
      .map((module) => ({ id: module.id, digest: digest(module), note: approvalNote }))));
  }
  for (const coverage of inputs.coverage) await write(root, `content/sc900/coverage/${coverage.domainId}.json`, json(coverage));
  await write(root, "content/sc900/review-approvals/metadata.json", json({
    schemaVersion: 1, reviewedAt: "2026-09-22", reviewer: "coordinator",
    curriculumDigest: digest(inputs.curriculum), objectivesDigest: digest(inputs.objectives),
    coverageDigest: digest(inputs.coverage), note: approvalNote,
  }));
  const draft = await loadCoursePublication(root, "sc900");
  await write(root, "content/sc900/review-approvals/activation.json", json({
    schemaVersion: 1, examId: "sc900", approved: true, reviewer: "coordinator", reviewedAt: "2026-09-22",
    releaseId: draft.pointer.releaseId, sha256: draft.pointer.sha256, note: approvalNote,
  }));
  const publication = await loadCoursePublication(root, "sc900", { activate: true });
  for (const [path, value] of publication.files) await write(root, `dist/${path}`, json(value));
  return publication;
}

function bankFixture(seed = "current", withImage = false) {
  const template = sc900BankFixture();
  const ledger = Sc900CaptureLedgerSchema.parse({
    ...template.ledger, reported: { questions: 40, pages: 8 },
    pages: Array.from({ length: 8 }, (_, index) => ({
      pageNumber: index + 1, url: template.ledger.sourceUrl.replace(/\/1$/, `/${index + 1}`),
      rawSha256: hash(`synthetic ${seed} page ${index}`),
      questionNumbers: Array.from({ length: 5 }, (_, item) => index * 5 + item + 1),
    })),
    occurrences: Array.from({ length: 40 }, (_, index) => ({
      id: sc900OccurrenceId(index + 1), questionNumber: index + 1, pageNumber: Math.floor(index / 5) + 1,
      answerRevealed: true, discussionState: "loaded", expectedCommentCount: 0, parsedCommentCount: 0,
      commentIds: [], assetIds: withImage ? [...template.assets.keys()] : [],
    })),
    assets: withImage ? template.ledger.assets : [],
  });
  const sourceRevision = sc900SourceRevision(ledger);
  const documents = ledger.occurrences.map((occurrence) => {
    const document = structuredClone(template.documents[0]!);
    document.question.prompt.push({ type: "text", spans: [
      { type: "text", text: `Synthetic offline fixture ${seed} ${occurrence.questionNumber}.`, marks: [] },
    ] });
    if (!withImage) {
      document.question.prompt = document.question.prompt.filter((block) => block.type !== "image");
      document.question.assetIds = [];
      document.question.media = [];
    }
    document.question.id = sc900QuestionId(document.question);
    document.question.sourceRevision = sourceRevision;
    document.question.commentCount = 0;
    document.question.sourceOccurrenceIds = [occurrence.id];
    document.question.sources = [{ questionNumber: occurrence.questionNumber, pageNumber: occurrence.pageNumber,
      url: ledger.pages[occurrence.pageNumber - 1]!.url }];
    document.answers.id = document.question.id;
    document.answers.questionId = document.question.id;
    document.answers.sourceRevision = sourceRevision;
    document.answers.originalAnswers[0]!.sourceOccurrenceId = occurrence.id;
    document.answers.originalAnswers[0]!.provenance.url = document.question.sources[0]!.url;
    document.discussionEnabled = false;
    return Sc900DocumentSchema.parse(document);
  });
  const input: Sc900PublicationInput = {
    ...template, ledger, documents, assets: withImage ? template.assets : new Map(),
    expectedCapture: { questions: 40, pages: 8, receiptSha256: hash("Independent synthetic offline source-scope receipt: forty questions, eight pages") },
    discussions: documents.map((document) => ({
      schemaVersion: 1, examId: "sc900", releaseId: document.releaseId, questionId: document.question.id, comments: [],
    })),
    topics: { ...template.topics, sourceRevision,
      assignments: Object.fromEntries(documents.map((document) => [document.question.id, ["sc-security-concepts"]])) },
    learning: { ...template.learning, sourceRevision,
      explanations: documents.map((document) => ({
        ...template.learning.explanations[0]!, questionId: document.question.id, questionSourceRevision: sourceRevision,
        originalKeyDigest: sc900OriginalKeyDigest(document),
      })) },
    eligibility: { ...template.eligibility, sourceRevision,
      reviewedQuestionIds: documents.map((document) => document.question.id),
      activeQuestionIds: documents.map((document) => document.question.id),
      activeCounts: { questions: 40, comments: 0, images: withImage ? 1 : 0, automatic: 40, manual: 0,
        omittedComments: 0, sourceQuestions: 40, duplicatesGrouped: 0 }, retired: [] },
  };
  const plan = buildSc900StaticPlan(input, sc900BankReview(prepareSc900Release(input)));
  const receipt = createSc900ApprovalReceipt(plan, {
    schemaVersion: 1, examId: "sc900", releaseId: plan.release.manifest.releaseId, planDigest: plan.planDigest, reviewDigest: plan.reviewDigest,
    reviewer: "independent synthetic fixture reviewer", reviewedAt: "2026-09-22T00:00:00Z", independent: true, decision: "approve-activation",
  });
  const questionId = plan.release.documents[0]!.question.id;
  return { plan, manifest: plan.release.manifest, files: new Map(plan.files.map((file) => [file.path, Buffer.from(file.bytes)])),
    receipt, questionId, questionPath: `exams/sc900/content/${plan.release.manifest.releaseId}/questions/${questionId}.json` };
}

async function approvedStage(root: string, bank: ReturnType<typeof bankFixture>) {
  const stage = `.data/sc900-publication/${bank.manifest.releaseId}`;
  await stageSc900Publication(bank.plan, { workspaceRoot: root });
  await writeSc900FinalApproval(bank.plan, bank.receipt.finalReview!, root);
  const finalApprovalPath = `.data/sc900-publication/approvals/${bank.manifest.releaseId}/${bank.receipt.planDigest}-${sc900Hash("activation-receipt", bank.receipt)}.json`;
  return {
    releaseId: bank.manifest.releaseId, receiptSha256: hash(await readFile(resolve(root, stage, "approval-receipt.json"))),
    inventorySha256: hash(await readFile(resolve(root, stage, "inventory.json"))),
    finalApprovalPath, finalApprovalSha256: hash(await readFile(resolve(root, finalApprovalPath))),
  };
}

test("SC-900 offline publication includes only exact activated exports and never changes AZ-104's descriptor", async () => {
  const root = resolve(`.offline-publication-test-${randomUUID()}`);
  try {
    await mkdir(root, { recursive: true });
    const bank = bankFixture();
    const stage = `.data/sc900-publication/${bank.manifest.releaseId}`;
    assert.deepEqual(await selectedOfflineExamIds(root), ["az104"]);
    await assert.rejects(buildOfflineManifest(root, "dist", "sc900"), /explicitly selected approved publication/);
    for (const [path, bytes] of bank.files) await write(root, `dist/${path}`, bytes);
    await assert.rejects(buildOfflineManifest(root, "dist", "sc900"), /explicitly selected approved publication/);
    const release = await approvedStage(root, bank);
    const inventoryBytes = await readFile(resolve(root, stage, "inventory.json"));
    const archived = bankFixture("archive", true);
    const archiveRelease = await approvedStage(root, archived);
    assert.deepEqual(await selectedOfflineExamIds(root), ["az104"], "Staged banks cannot enable SC900 or require a course.");
    const course = await courseFixture(root);
    await write(root, `.data/sc900-publication/courses/${course.course.releaseId}.json`, json(course.course));
    await assert.rejects(buildOfflineManifest(root, "dist", "sc900"), /explicitly selected approved publication/);
    await write(root, ".data/sc900-publication/hosting.json", json({
      schemaVersion: 1, examId: "sc900", activeReleaseId: release.releaseId,
      activeCourseReleaseId: course.course.releaseId, releases: [release, archiveRelease],
      courses: [{ releaseId: course.course.releaseId, sha256: course.pointer.sha256 }],
    }));
    assert.deepEqual(await selectedOfflineExamIds(root), ["az104", "sc900"]);
    const approved = await loadSc900HostingPublication(root);
    for (const [path, file] of approved.files) await write(root, `dist/${path}`, await publicationFileBytes(file));
    const availabilityBytes = await publicationFileBytes(approved.files.get("exams/sc900/availability.json")!);
    const availability = JSON.parse(availabilityBytes.toString("utf8")) as Record<string, unknown>;
    await write(root, "dist/index.html", '<html><script src="/assets/index-fixture.js"></script></html>');
    await write(root, "dist/assets/index-fixture.js", 'console.log("synthetic");');
    await write(root, "dist/favicon.svg", "<svg/>");
    await write(root, "dist/offline-worker.js", "// synthetic offline shell");
    await write(root, "dist/data/offline-manifest.json", "untouched AZ104 offline descriptor");
    await write(root, "dist/exams/sc900/unapproved-review.json", "not for offline publication");
    const manifest = await exportOfflineManifest(root, "dist", "sc900");
    assert.equal(manifest.examId, "sc900");
    assert.equal(manifest.counts.questions, 40);
    assert.equal(manifest.counts.images, 1);
    assert.equal(selectOfflineFiles(manifest).filter((file) => file.kind === "image").length, 0);
    const saved = selectOfflineFiles(manifest, [{ releaseId: archived.manifest.releaseId, questionIds: [archived.questionId] }]);
    assert.equal(saved.filter((file) => file.kind === "image").length, 1);
    assert.ok(saved.some((file) => file.releaseId === archived.manifest.releaseId && file.part === "topics"));
    assert.ok(saved.some((file) => file.releaseId === archived.manifest.releaseId && file.part === "explanation"));
    assert.equal(manifest.files.filter((file) => file.part === "discussion").length, 0);
    assert.ok(manifest.files.some((file) => file.part === "learning-manifest"));
    assert.ok(manifest.files.some((file) => file.part === "explanation"));
    assert.ok(manifest.files.some((file) => file.url === "/exams/sc900/availability.json"));
    for (const path of ["topics.json", "learning/manifest.json", "eligibility.json"]) {
      assert.ok(manifest.files.some((file) => file.url === `/exams/sc900/content/${bank.manifest.releaseId}/${path}`));
    }
    assert.ok(manifest.files.some((file) => file.url.startsWith(`/exams/sc900/content/${bank.manifest.releaseId}/learning/questions/`)));
    assert.ok(manifest.files.some((file) => file.url === `/${course.pointer.url}`));
    assert.equal(manifest.files.some((file) => /receipt|inventory|unapproved/.test(file.url)), false);
    assert.equal(await readFile(resolve(root, "dist/data/offline-manifest.json"), "utf8"), "untouched AZ104 offline descriptor");
    assert.deepEqual(JSON.parse(await readFile(resolve(root, "dist/exams/sc900/offline-manifest.json"), "utf8")), manifest);
    for (const invalid of [
      { schemaVersion: 1, examId: "sc900", activated: false },
      { ...availability, kind: "original-synthetic-demo" },
      { ...availability, bankReleaseId: `r_${hash("other-bank")}` },
      { ...availability, courseReleaseId: `c_${hash("other-course")}` },
      { ...availability, sourceCaptureDigest: hash("other-capture") },
    ]) {
      await write(root, "dist/exams/sc900/availability.json", json(invalid));
      await assert.rejects(buildOfflineManifest(root, "dist", "sc900"), /approved publication/);
    }
    await write(root, "dist/exams/sc900/availability.json", Buffer.alloc(8_001));
    await assert.rejects(buildOfflineManifest(root, "dist", "sc900"), /limit/);
    await write(root, "dist/exams/sc900/availability.json", availabilityBytes);
    await write(root, `dist/${bank.questionPath}`, Buffer.concat([bank.files.get(bank.questionPath)!, Buffer.from(" ")]));
    await assert.rejects(buildOfflineManifest(root, "dist", "sc900"), /approved publication/);
    await write(root, `dist/${bank.questionPath}`, bank.files.get(bank.questionPath)!);
    await write(root, `dist/${course.pointer.url}`, json(course.course) + " ");
    await assert.rejects(buildOfflineManifest(root, "dist", "sc900"), /approved publication/);
    await write(root, `dist/${course.pointer.url}`, json(course.course));
    await write(root, `${stage}/inventory.json`, json([...JSON.parse(inventoryBytes.toString("utf8")), {
      path: "/etc/passwd", sha256: hash("bad"), byteLength: 3, contentType: "application/json",
    }]));
    await assert.rejects(buildOfflineManifest(root, "dist", "sc900"), /stage metadata changed/);
    await assert.rejects(selectedOfflineExamIds(root), /stage metadata changed/);
    await write(root, `${stage}/inventory.json`, inventoryBytes);
    await write(root, "dist/exams/sc900/manifest.json", Buffer.alloc(4 * 1024 * 1024 + 1));
    await assert.rejects(buildOfflineManifest(root, "dist", "sc900"), /limit/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
