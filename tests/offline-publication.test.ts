import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { Sc900CatalogSchema, Sc900DocumentSchema, Sc900ManifestSchema } from "../src/domain/sc900Bank.js";
import { Sc900ApprovalReceiptSchema } from "../src/domain/sc900Publication.js";
import { sc900OccurrenceId } from "../src/domain/sc900Capture.js";
import { fullCourseInputs } from "./full-course-fixture.js";
import { createDemoBank } from "../tools/demo/fixtures.js";
import { digest } from "../tools/ingest/normalize-shared.js";
import { loadCoursePublication } from "../tools/course/publication.js";
import { sc900Hash } from "../tools/sc900/canonical.js";
import { hash, json } from "../tools/web/bank.js";
import { buildOfflineManifest, exportOfflineManifest } from "../tools/web/offline-manifest.js";

const approvalNote = "Synthetic offline packaging test approval only. These original fictional fixtures never authorize any production publication or factual course review.";
const bankVersion = "sc900-approved-v1" as const;

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

function bankFixture() {
  const demo = createDemoBank();
  const original = demo.release.documents[0]!;
  const releaseId = `r_${hash("synthetic offline SC900 release")}`;
  const occurrence = sc900OccurrenceId(original.question.sources[0]!.questionNumber);
  const document = Sc900DocumentSchema.parse({
    ...original, examId: "sc900", releaseId,
    question: { ...original.question, examId: "sc900", sourceOccurrenceIds: [occurrence] },
    answers: { ...original.answers, examId: "sc900",
      originalAnswers: original.answers.originalAnswers.map((answer) => ({ ...answer, sourceOccurrenceId: occurrence })) },
  });
  const counts = { questions: 1, comments: 0, images: 0, automatic: 1, manual: 0, omittedComments: 0, sourceQuestions: 1, duplicatesGrouped: 0 };
  const manifest = Sc900ManifestSchema.parse({
    ...demo.manifest, examId: "sc900", bankVersion, releaseId, counts,
    captureLedgerDigest: hash("synthetic capture"),
    catalogUrl: `content/${releaseId}/catalog.json`, questionBaseUrl: `content/${releaseId}/questions/`,
    discussionBaseUrl: `content/${releaseId}/discussions/`, mediaBaseUrl: `content/${releaseId}/media/`,
  });
  const catalog = Sc900CatalogSchema.parse({
    ...demo.release.catalog, examId: "sc900", bankVersion, releaseId, counts,
    questions: [{ ...demo.release.catalog.questions[0], sourceNumbers: [original.question.sources[0]!.questionNumber] }],
  });
  const prefix = `exams/sc900/content/${releaseId}`;
  const questionId = document.question.id;
  const values = new Map<string, unknown>([
    ["exams/sc900/manifest.json", manifest],
    [`${prefix}/catalog.json`, catalog], [`${prefix}/questions/${questionId}.json`, document],
    [`${prefix}/discussions/${questionId}.json`, { schemaVersion: 1, examId: "sc900", releaseId, questionId, comments: [] }],
    [`${prefix}/topics.json`, { fixture: "approved synthetic topics" }],
    [`${prefix}/eligibility.json`, { fixture: "approved synthetic eligibility" }],
    [`${prefix}/learning/manifest.json`, { fixture: "approved synthetic teaching manifest" }],
    [`${prefix}/learning/questions/${questionId}.json`, { ...demo.dataset.explanations[0], examId: "sc900" }],
  ]);
  const files = new Map([...values].map(([path, value]) => [path, Buffer.from(json(value))]));
  const inventory = [...files].map(([path, bytes]) => ({
    path, sha256: hash(bytes), byteLength: bytes.length, contentType: "application/json" as const,
  })).sort((a, b) => a.path.localeCompare(b.path));
  const reviewDigest = hash("synthetic complete review");
  const planDigest = sc900Hash("static-plan", {
    releaseId, captureLedgerDigest: manifest.captureLedgerDigest, reviewDigest, files: inventory,
  });
  const receipt = Sc900ApprovalReceiptSchema.parse({
    schemaVersion: 1, examId: "sc900", bankVersion, releaseId, sourceRevision: manifest.sourceRevision,
    captureLedgerDigest: manifest.captureLedgerDigest, planDigest, reviewDigest,
    fileCount: files.size, totalBytes: inventory.reduce((sum, file) => sum + file.byteLength, 0), activate: true,
    finalReview: { schemaVersion: 1, examId: "sc900", releaseId, planDigest, reviewDigest,
      reviewer: "independent synthetic fixture reviewer", reviewedAt: "2026-09-22T00:00:00Z", independent: true, decision: "approve-activation" },
  });
  return { manifest, files, inventory, receipt, questionPath: `${prefix}/questions/${questionId}.json` };
}

test("SC-900 offline publication includes only exact activated exports and never changes AZ-104's descriptor", async () => {
  const root = resolve(`.offline-publication-test-${randomUUID()}`);
  try {
    await mkdir(root, { recursive: true });
    const bank = bankFixture();
    const stage = `.data/sc900-publication/${bank.manifest.releaseId}`;
    await assert.rejects(buildOfflineManifest(root, "dist", "sc900"), /ENOENT/);
    for (const [path, bytes] of bank.files) await write(root, `dist/${path}`, bytes);
    await assert.rejects(buildOfflineManifest(root, "dist", "sc900"), /approval-receipt/);
    await write(root, `${stage}/inventory.json`, json(bank.inventory));
    await write(root, `${stage}/approval-receipt.json`, json({ ...bank.receipt, activate: false, finalReview: null }));
    await assert.rejects(buildOfflineManifest(root, "dist", "sc900"), /activated, independently approved/);
    await write(root, `${stage}/approval-receipt.json`, json(bank.receipt));
    await assert.rejects(buildOfflineManifest(root, "dist", "sc900"), /ENOENT/);
    const course = await courseFixture(root);
    await assert.rejects(buildOfflineManifest(root, "dist", "sc900"), /availability/);
    const availability = {
      schemaVersion: 1, examId: "sc900", activated: true, kind: "approved-source",
      bankReleaseId: bank.manifest.releaseId, courseReleaseId: course.course.releaseId,
      sourceCaptureDigest: bank.manifest.captureLedgerDigest,
      approvedBy: "synthetic offline test coordinator", approvedAt: "2026-09-22T00:00:00Z",
    };
    await write(root, "dist/exams/sc900/availability.json", json(availability));
    await write(root, "dist/index.html", '<html><script src="/assets/index-fixture.js"></script></html>');
    await write(root, "dist/assets/index-fixture.js", 'console.log("synthetic");');
    await write(root, "dist/favicon.svg", "<svg/>");
    await write(root, "dist/offline-worker.js", "// synthetic offline shell");
    await write(root, "dist/data/offline-manifest.json", "untouched AZ104 offline descriptor");
    await write(root, "dist/exams/sc900/unapproved-review.json", "not for offline publication");
    const manifest = await exportOfflineManifest(root, "dist", "sc900");
    assert.equal(manifest.examId, "sc900");
    assert.equal(manifest.counts.questions, 1);
    assert.equal(manifest.counts.images, 0);
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
      await assert.rejects(buildOfflineManifest(root, "dist", "sc900"), /does not activate/);
    }
    await write(root, "dist/exams/sc900/availability.json", Buffer.alloc(8_001));
    await assert.rejects(buildOfflineManifest(root, "dist", "sc900"), /oversized/);
    await write(root, "dist/exams/sc900/availability.json", json(availability));
    await write(root, `dist/${bank.questionPath}`, Buffer.concat([bank.files.get(bank.questionPath)!, Buffer.from(" ")]));
    await assert.rejects(buildOfflineManifest(root, "dist", "sc900"), /approved inventory/);
    await write(root, `dist/${bank.questionPath}`, bank.files.get(bank.questionPath)!);
    await write(root, `dist/${course.pointer.url}`, json(course.course) + " ");
    await assert.rejects(buildOfflineManifest(root, "dist", "sc900"), /approved publication/);
    await write(root, `dist/${course.pointer.url}`, json(course.course));
    await write(root, `${stage}/inventory.json`, json([...bank.inventory, {
      path: "/etc/passwd", sha256: hash("bad"), byteLength: 3, contentType: "application/json",
    }]));
    await assert.rejects(buildOfflineManifest(root, "dist", "sc900"), /approved exact static export/);
    await write(root, "dist/exams/sc900/manifest.json", Buffer.alloc(4 * 1024 * 1024 + 1));
    await assert.rejects(buildOfflineManifest(root, "dist", "sc900"), /oversized/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
