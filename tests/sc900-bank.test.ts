import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { CleanDocumentSchema } from "../src/domain/cleanBank.js";
import { OccurrenceIdSchema } from "../src/domain/schemas.js";
import { LearningManifestSchema } from "../src/domain/learning.js";
import { TopicMapSchema } from "../src/domain/topics.js";
import { SC900_INACTIVE, Sc900AvailabilitySchema } from "../src/domain/examAvailability.js";
import {
  Sc900DocumentSchema, Sc900ManifestSchema, sc900FirestoreRoot, sc900SchemasForLedger,
} from "../src/domain/sc900Bank.js";
import {
  Sc900CaptureLedgerSchema, assertSc900SourceNumber, sc900OccurrenceId, sc900SourcePageUrl,
  type Sc900CaptureLedger,
} from "../src/domain/sc900Capture.js";
import { byteSha256, canonicalJson, sc900Hash, sc900SourceRevision } from "../tools/sc900/canonical.js";
import {
  SC900_DRAFT_RELEASE_ID, SC900_EXPORT_LIMITS, buildSc900StaticPlan, createSc900ApprovalReceipt,
  isSc900ExportPath, prepareSc900Release, reserveSc900CloudHeadroom, sc900CloudRequirements,
  stageSc900Publication, validateSc900StagedExport,
  validateSc900StaticPlan, writeSc900FinalApproval, loadSc900Publication,
  type Sc900PublicationInput,
} from "../tools/sc900/publication.js";
import { pacificQuotaDay } from "../tools/publish/quota.js";
import {
  SC900_FIXTURE_TIMESTAMP as timestamp, sc900FixtureText as text,
  sc900BankFixture as fixture, sc900BankReview as review, sc900BankPlanFixture as planFixture,
} from "./sc900-bank-fixture.js";

test("SC900 hashes are exam-scoped, canonical and reject non-JSON input", () => {
  assert.equal(sc900Hash("content", { b: 2, a: 1 }), sc900Hash("content", { a: 1, b: 2 }));
  assert.notEqual(sc900Hash("content", { a: 1 }), byteSha256(canonicalJson({ a: 1 })));
  assert.notEqual(sc900Hash("source", { a: 1 }), sc900Hash("content", { a: 1 }));
  for (const value of [undefined, Number.NaN, Infinity, new Date(), [undefined], { x: undefined }, Array(2)]) {
    assert.throws(() => canonicalJson(value));
  }
  assert.throws(() => sc900Hash("../az104", {}));
});

test("SC900 capture coverage is derived from verified page and occurrence evidence, not AZ104 counts", () => {
  const ledger = fixture().ledger;
  assert.equal(Sc900CaptureLedgerSchema.parse(ledger).reported.questions, 2);
  const large: Sc900CaptureLedger = {
    ...ledger, reported: { questions: 607, pages: 1 }, assets: [],
    pages: [{ ...ledger.pages[0]!, questionNumbers: Array.from({ length: 607 }, (_, index) => index + 1) }],
    occurrences: Array.from({ length: 607 }, (_, index) => ({
      id: sc900OccurrenceId(index + 1), questionNumber: index + 1, pageNumber: 1,
      answerRevealed: true, discussionState: "loaded", expectedCommentCount: 0, parsedCommentCount: 0, commentIds: [], assetIds: [],
    })),
  };
  Sc900CaptureLedgerSchema.parse(large);
  assertSc900SourceNumber(607, large);
  assert.throws(() => assertSc900SourceNumber(608, large), /outside the verified capture/);
  for (const mutate of [
    (value: Sc900CaptureLedger) => { value.reported.questions++; },
    (value: Sc900CaptureLedger) => { value.reported.pages++; },
    (value: Sc900CaptureLedger) => { value.pages[0]!.questionNumbers.pop(); },
    (value: Sc900CaptureLedger) => { value.occurrences[0]!.parsedCommentCount--; },
    (value: Sc900CaptureLedger) => { value.occurrences[0]!.id = "examprepper-45-q000001"; },
    (value: Sc900CaptureLedger) => { value.occurrences[0]!.pageNumber = 2; },
    (value: Sc900CaptureLedger) => { value.assets = []; },
  ]) {
    const changed = structuredClone(ledger);
    mutate(changed);
    assert.equal(Sc900CaptureLedgerSchema.safeParse(changed).success, false);
  }
  assert.equal(Sc900CaptureLedgerSchema.safeParse({ ...ledger, verified: false }).success, false);
  assert.equal(Sc900CaptureLedgerSchema.safeParse({
    ...ledger, occurrences: ledger.occurrences.map((item) => ({ ...item, answerRevealed: false })),
  }).success, false);
});

test("SC900 document boundaries preserve rich/manual/image shapes without weakening AZ104", () => {
  const input = fixture();
  input.documents.forEach((document) => {
    Sc900DocumentSchema.parse(document);
    assert.equal(CleanDocumentSchema.safeParse(document).success, false);
  });

  assert.equal(OccurrenceIdSchema.safeParse(sc900OccurrenceId(1)).success, false);
  assert.equal(TopicMapSchema.safeParse(input.topics).success, false);
  const release = prepareSc900Release(input);
  const bounded = sc900SchemasForLedger(input.ledger);
  bounded.document.parse(input.documents[0]!);
  bounded.catalog.parse(release.catalog);
  bounded.manifest.parse(release.manifest);
  const outsideLedger = structuredClone(input.documents[0]!);
  outsideLedger.question.sources[0]!.questionNumber = 607;
  outsideLedger.question.sourceOccurrenceIds = [sc900OccurrenceId(607)];
  outsideLedger.answers.originalAnswers[0]!.sourceOccurrenceId = sc900OccurrenceId(607);
  assert.equal(Sc900DocumentSchema.safeParse(outsideLedger).success, true);
  assert.equal(bounded.document.safeParse(outsideLedger).success, false);
  assert.equal(LearningManifestSchema.safeParse(release.learningManifest).success, false);
  const wrong = structuredClone(input.documents[0]!);
  wrong.question.sourceOccurrenceIds = ["examprepper-45-q000001"];
  assert.equal(Sc900DocumentSchema.safeParse(wrong).success, false);
  assert.equal(Sc900DocumentSchema.safeParse({ ...input.documents[0], examId: "az104" }).success, false);
  assert.equal(Sc900DocumentSchema.safeParse({ ...input.documents[0], examId: undefined }).success, false);
});

test("SC900 capture pins the exact approved source origin, exam and each numbered page", () => {
  const ledger = fixture().ledger;
  assert.equal(ledger.sourceUrl, "https://www.examprepper.co/exam/128/1");
  assert.equal(sc900SourcePageUrl(2), "https://www.examprepper.co/exam/128/2");
  for (const number of [0, -1, 1.5, 1000000, Number.NaN]) {
    assert.throws(() => sc900SourcePageUrl(number));
  }
  const invalidUrls = [
    "https://www.examprepper.co/exam/45/1",
    "https://www.examprepper.co/exam/128/2",
    "https://examprepper.co/exam/128/1",
    "http://www.examprepper.co/exam/128/1",
    "https://www.examprepper.co/exam/128/1/",
    "https://www.examprepper.co/exam/128/01",
    "https://www.examprepper.co/exam/128/1?exam=45",
    "https://www.examprepper.co/exam/128/1#answer",
    "https://www.examprepper.co.example.test/exam/128/1",
    "https://user@www.examprepper.co/exam/128/1",
  ];
  for (const url of invalidUrls) {
    assert.equal(Sc900CaptureLedgerSchema.safeParse({ ...ledger, sourceUrl: url }).success, false, url);
    assert.equal(Sc900CaptureLedgerSchema.safeParse({
      ...ledger, pages: [{ ...ledger.pages[0], url }],
    }).success, false, url);
  }
  const twoPages: Sc900CaptureLedger = {
    ...ledger, reported: { questions: 2, pages: 2 },
    pages: [1, 2].map((number) => ({
      pageNumber: number, url: sc900SourcePageUrl(number), rawSha256: byteSha256(`Synthetic page ${number}`),
      questionNumbers: [number],
    })),
    occurrences: ledger.occurrences.map((occurrence) => ({ ...occurrence, pageNumber: occurrence.questionNumber })),
  };
  Sc900CaptureLedgerSchema.parse(twoPages);
  twoPages.pages[1]!.url = sc900SourcePageUrl(1);
  assert.equal(Sc900CaptureLedgerSchema.safeParse(twoPages).success, false);
});

test("SC900 loaded empty discussions stay valid and are not mistaken for unverified empty captures", () => {
  const input = fixture();
  const empty = input.ledger.occurrences[1]!;
  assert.equal(empty.discussionState, "loaded");
  assert.equal(empty.expectedCommentCount, 0);
  assert.equal(empty.parsedCommentCount, 0);
  assert.deepEqual(empty.commentIds, []);
  Sc900CaptureLedgerSchema.parse(input.ledger);
  assert.equal(prepareSc900Release(input).discussions.find((item) =>
    item.questionId === input.documents[1]!.question.id)?.comments.length, 0);
  for (const discussionState of ["loading", "failed", "rendered-only", "unknown"]) {
    assert.equal(Sc900CaptureLedgerSchema.safeParse({
      ...input.ledger, occurrences: [input.ledger.occurrences[0], { ...empty, discussionState }],
    }).success, false);
  }
  assert.equal(Sc900CaptureLedgerSchema.safeParse({
    ...input.ledger, occurrences: [input.ledger.occurrences[0], { ...empty, expectedCommentCount: 1 }],
  }).success, false);
  const manifest = prepareSc900Release(input).manifest;
  assert.equal(Sc900ManifestSchema.safeParse({
    ...manifest, counts: { ...manifest.counts, omittedComments: 1 },
  }).success, false);
});

test("SC900 release and static files are deterministic and scoped, including learning and relevance", () => {
  const plan = planFixture();
  assert.equal(plan.activate, false);
  assert.deepEqual(plan.release.manifest.counts, fixture().eligibility.activeCounts);
  assert.equal(plan.release.manifest.sourceRevision, sc900SourceRevision(fixture().ledger));
  assert.equal(plan.release.manifest.catalogUrl, `content/${plan.release.manifest.releaseId}/catalog.json`);
  assert.equal(sc900FirestoreRoot(plan.release.manifest.releaseId), `studyBanks/sc900/releases/${plan.release.manifest.releaseId}`);
  assert.ok(plan.files.every((file) => isSc900ExportPath(file.path, plan.release.manifest.releaseId)));
  assert.ok(plan.files.some((file) => file.path.endsWith("/learning/manifest.json")));
  assert.ok(plan.files.some((file) => file.path.endsWith("/eligibility.json")));
  const availability = plan.files.find((file) => file.path === "exams/sc900/availability.json")!;
  assert.deepEqual(Sc900AvailabilitySchema.parse(JSON.parse(Buffer.from(availability.bytes).toString("utf8"))), SC900_INACTIVE);
  assert.equal(plan.planDigest, planFixture().planDigest);
  assert.equal(validateSc900StaticPlan(plan).planDigest, plan.planDigest);
  const replay = prepareSc900Release(plan.release);
  assert.deepEqual(replay.manifest, plan.release.manifest);
  for (const path of [
    "data/manifest.json", "exams/az104/manifest.json", "exams/sc900/../manifest.json",
    `exams/sc900/content/${plan.release.manifest.releaseId}/raw/capture.html`,
    `exams/sc900/content/${plan.release.manifest.releaseId}/media/a.svg`,
  ]) assert.equal(isSc900ExportPath(path, plan.release.manifest.releaseId), false);
  assert.equal(Sc900ManifestSchema.safeParse({
    ...plan.release.manifest, catalogUrl: `exams/sc900/${plan.release.manifest.catalogUrl}`,
  }).success, false);
});

test("SC900 publication refuses source, answer, comment, metadata and asset omissions or substitutions", () => {
  const mutations: Array<(input: Sc900PublicationInput) => void> = [
    (input) => { input.documents.pop(); },
    (input) => { input.documents[0]!.answers.originalAnswers = []; },
    (input) => { input.discussions[0]!.comments.pop(); },
    (input) => { input.discussions[0]!.comments[0]!.childIds = []; },
    (input) => { input.documents[0]!.question.sources[0]!.pageNumber = 2; },
    (input) => { input.documents[0]!.question.sources[0]!.url = "https://example.test/another-exam"; },
    (input) => { input.documents[0]!.question.sourceRevision = "f".repeat(64); },
    (input) => { input.documents[0]!.question.options[0]!.content = text("Changed after hashing"); },
    (input) => { delete input.topics.assignments[input.documents[0]!.question.id]; },
    (input) => { input.learning.explanations.pop(); },
    (input) => { input.learning.explanations[0]!.originalKeyDigest = "f".repeat(64); },
    (input) => {
      const explanation = input.learning.explanations[0]!;
      explanation.correctOptionIds = [input.documents[0]!.question.options[1]!.id];
      explanation.options.forEach((option) => { option.verdict = option.verdict === "correct" ? "incorrect" : "correct"; });
    },
    (input) => { input.eligibility.activeCounts.images = 0; },
    (input) => { input.assets = new Map(); },
    (input) => { input.assets = new Map([[input.ledger.assets[0]!.id, Buffer.from("not an image")]]); },
  ];
  for (const mutate of mutations) {
    const input = fixture();
    mutate(input);
    assert.throws(() => prepareSc900Release(input));
  }
});

test("SC900 full review and independent final approval bind exact hashes and cannot self-approve", () => {
  const input = fixture();
  const release = prepareSc900Release(input);
  const complete = review(release);
  const plan = buildSc900StaticPlan(input, complete);
  const receipt = createSc900ApprovalReceipt(plan);
  assert.equal(receipt.activate, false);
  assert.equal(receipt.finalReview, null);
  assert.throws(() => buildSc900StaticPlan(input, { ...complete, questions: complete.questions.slice(1) }), /Full SC900 review/);
  assert.throws(() => buildSc900StaticPlan(input, { ...complete, releaseId: SC900_DRAFT_RELEASE_ID }), /Full SC900 review/);
  const changed = fixture();
  changed.learning.explanations[0]!.takeaway += " Changed synthetic teaching text.";
  assert.throws(() => buildSc900StaticPlan(changed, complete), /Full SC900 review/);
  const finalReview = {
    schemaVersion: 1 as const, examId: "sc900" as const, releaseId: plan.release.manifest.releaseId,
    planDigest: plan.planDigest, reviewDigest: plan.reviewDigest, reviewer: "Synthetic independent final reviewer",
    reviewedAt: timestamp, independent: true as const, decision: "approve-activation" as const,
  };
  assert.equal(createSc900ApprovalReceipt(plan, finalReview).activate, true);
  assert.throws(() => createSc900ApprovalReceipt(plan, { ...finalReview, reviewer: complete.reviewer }), /independent/);
  assert.throws(() => createSc900ApprovalReceipt(plan, { ...finalReview, planDigest: "f".repeat(64) }));
  plan.files[0]!.bytes[0] = 0;
  assert.throws(() => validateSc900StaticPlan(plan), /modified after full review/);
});

test("SC900 staged export is immutable, exact-hash validated, ignored, and rejects extras and hard links", async () => {
  const workspace = resolve(".data/sc900-bank-tests", randomUUID());
  await mkdir(workspace, { recursive: true });
  try {
    const plan = planFixture();
    const staged = await stageSc900Publication(plan, { workspaceRoot: workspace });
    assert.ok(staged.directory.startsWith(`${workspace}/.data/sc900-publication/`));
    assert.equal(staged.receipt.activate, false);
    assert.deepEqual(await stageSc900Publication(plan, { workspaceRoot: workspace }), staged);
    await validateSc900StagedExport(staged.directory, plan, staged.receipt);
    const manifest = JSON.parse(await readFile(resolve(staged.directory, "exams/sc900/manifest.json"), "utf8"));
    assert.deepEqual(manifest, plan.release.manifest);
    await writeFile(resolve(staged.directory, "raw-private-capture.html"), "unapproved synthetic data");
    await assert.rejects(validateSc900StagedExport(staged.directory, plan, staged.receipt), /unapproved files/);
    await rm(resolve(staged.directory, "raw-private-capture.html"));
    const first = resolve(staged.directory, plan.files[0]!.path);
    const linked = resolve(workspace, "hard-linked-copy");
    await link(first, linked);
    await assert.rejects(validateSc900StagedExport(staged.directory, plan, staged.receipt), /hard-linked/);
    await rm(linked);
    await writeFile(first, "changed");
    await assert.rejects(stageSc900Publication(plan, { workspaceRoot: workspace }), /length changed/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("SC900 staging promotes only an exact independent approval and leaves all static bytes unchanged", async () => {
  const workspace = resolve(".data/sc900-bank-tests", randomUUID());
  await mkdir(workspace, { recursive: true });
  try {
    const plan = planFixture();
    const original = await stageSc900Publication(plan, { workspaceRoot: workspace });
    assert.equal(original.receipt.activate, false);
    const finalReview = {
      schemaVersion: 1 as const, examId: "sc900" as const, releaseId: plan.release.manifest.releaseId,
      planDigest: plan.planDigest, reviewDigest: plan.reviewDigest,
      reviewer: "Synthetic independent promotion reviewer", reviewedAt: timestamp,
      independent: true as const, decision: "approve-activation" as const,
    };
    await assert.rejects(stageSc900Publication(plan, {
      workspaceRoot: workspace, finalReview: { ...finalReview, reviewer: plan.review.reviewer },
    }), /independent/);
    await assert.rejects(stageSc900Publication(plan, {
      workspaceRoot: workspace, finalReview: { ...finalReview, planDigest: "f".repeat(64) },
    }));
    assert.equal(JSON.parse(await readFile(resolve(original.directory, "approval-receipt.json"), "utf8")).activate, false);
    const promoted = await stageSc900Publication(plan, { workspaceRoot: workspace, finalReview });
    assert.equal(promoted.directory, original.directory);
    assert.equal(promoted.receipt.activate, true);
    await validateSc900StagedExport(promoted.directory, plan, promoted.receipt);
    for (const file of plan.files) {
      assert.equal(byteSha256(await readFile(resolve(promoted.directory, file.path))), file.sha256);
    }
    assert.deepEqual(JSON.parse(await readFile(resolve(promoted.directory, "exams/sc900/availability.json"), "utf8")), SC900_INACTIVE);
    assert.deepEqual(await stageSc900Publication(plan, { workspaceRoot: workspace, finalReview }), promoted);
    await assert.rejects(stageSc900Publication(plan, { workspaceRoot: workspace }), /cannot be downgraded or changed/);
    await assert.rejects(stageSc900Publication(plan, {
      workspaceRoot: workspace, finalReview: { ...finalReview, reviewer: "A different independent reviewer" },
    }), /cannot be downgraded or changed/);
    await validateSc900StagedExport(promoted.directory, plan, promoted.receipt);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("SC900 stage promotion refuses changed bytes without modifying the pending receipt", async () => {
  const workspace = resolve(".data/sc900-bank-tests", randomUUID());
  await mkdir(workspace, { recursive: true });
  try {
    const plan = planFixture();
    const stage = await stageSc900Publication(plan, { workspaceRoot: workspace });
    const receiptPath = resolve(stage.directory, "approval-receipt.json");
    const previousReceipt = await readFile(receiptPath);
    const file = plan.files.find((item) => item.path.endsWith("/catalog.json"))!;
    const changed = Buffer.from(await readFile(resolve(stage.directory, file.path)));
    changed[0] = changed[0] === 123 ? 91 : 123;
    await writeFile(resolve(stage.directory, file.path), changed);
    await assert.rejects(stageSc900Publication(plan, {
      workspaceRoot: workspace,
      finalReview: {
        schemaVersion: 1, examId: "sc900", releaseId: plan.release.manifest.releaseId,
        planDigest: plan.planDigest, reviewDigest: plan.reviewDigest,
        reviewer: "Synthetic independent promotion reviewer", reviewedAt: timestamp,
        independent: true, decision: "approve-activation",
      },
    }), /hash changed/);
    assert.deepEqual(await readFile(receiptPath), previousReceipt);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("SC900 staging rejects a symlinked local publication directory", async () => {
  const workspace = resolve(".data/sc900-bank-tests", randomUUID());
  await mkdir(resolve(workspace, ".data"), { recursive: true });
  await mkdir(resolve(workspace, "other"));
  try {
    await symlink(resolve(workspace, "other"), resolve(workspace, ".data/sc900-publication"));
    await assert.rejects(stageSc900Publication(planFixture(), { workspaceRoot: workspace }), /symlink/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("SC900 later final approval persists separately without modifying the staged release", async () => {
  const workspace = resolve(".data/sc900-bank-tests", randomUUID());
  await mkdir(workspace, { recursive: true });
  try {
    const plan = planFixture();
    const stage = await stageSc900Publication(plan, { workspaceRoot: workspace });
    const finalReview = {
      schemaVersion: 1 as const, examId: "sc900" as const, releaseId: plan.release.manifest.releaseId,
      planDigest: plan.planDigest, reviewDigest: plan.reviewDigest,
      reviewer: "Synthetic final fixture reviewer", reviewedAt: timestamp,
      independent: true as const, decision: "approve-activation" as const,
    };
    const approval = await writeSc900FinalApproval(plan, finalReview, workspace);
    assert.equal(approval.receipt.activate, true);
    const availability = JSON.parse(await readFile(resolve(stage.directory, "exams/sc900/availability.json"), "utf8"));
    assert.deepEqual(availability, SC900_INACTIVE);
    assert.ok(approval.path.includes("/approvals/"));
    assert.equal(JSON.parse(await readFile(approval.path, "utf8")).activate, true);
    assert.deepEqual(await writeSc900FinalApproval(plan, finalReview, workspace), approval);
    assert.equal(JSON.parse(await readFile(resolve(stage.directory, "approval-receipt.json"), "utf8")).activate, false);
    await validateSc900StagedExport(stage.directory, plan, stage.receipt);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("SC900 cloud planning is nonexecuting and uses existing quota guards before reservation", async () => {
  const plan = planFixture();
  const requirements = sc900CloudRequirements(plan);
  assert.equal(requirements.executable, false);
  assert.equal(requirements.activate, false);
  assert.equal(requirements.counts.deletes, 0);
  assert.equal(requirements.counts.writes,
    plan.files.filter((file) => file.contentType === "application/json").length + plan.release.manifest.counts.comments + 3);
  assert.equal(requirements.counts.reads, requirements.counts.writes * 2);
  assert.equal(requirements.metadata.bank, "studyMetadata/sc900Bank");
  assert.equal(requirements.storage.objects, 1);
  const now = new Date();
  const usage = { checkedAt: now.toISOString(), pacificDay: pacificQuotaDay(now),
    periodStart: now.toISOString(), reads: 0, writes: 0, deletes: 0 };
  const workspace = resolve(".data/sc900-bank-tests", randomUUID());
  await mkdir(workspace, { recursive: true });
  try {
    await assert.rejects(reserveSc900CloudHeadroom(plan, createSc900ApprovalReceipt(plan), usage, workspace),
      /independent exact-hash activation approval/);
    const approved = createSc900ApprovalReceipt(plan, {
      schemaVersion: 1, examId: "sc900", releaseId: plan.release.manifest.releaseId,
      planDigest: plan.planDigest, reviewDigest: plan.reviewDigest,
      reviewer: "Synthetic external reviewer", reviewedAt: timestamp, independent: true, decision: "approve-activation",
    });

    await assert.rejects(reserveSc900CloudHeadroom(plan, approved, { ...usage, writes: 18000 }, workspace), /Quota pause/);
    await reserveSc900CloudHeadroom(plan, approved, usage, workspace);
    const journal = JSON.parse(await readFile(resolve(workspace, ".data/upload-journal.json"), "utf8"));
    assert.equal(journal.days[usage.pacificDay].reservedWrites, requirements.counts.writes);
    const operations = JSON.parse(await readFile(resolve(workspace, ".data/operation-journal.json"), "utf8"));
    assert.equal(operations.days[usage.pacificDay].reservedReads, requirements.counts.reads);
    assert.equal(SC900_EXPORT_LIMITS.minimumFreeBytes, 2.5 * 1024 ** 3);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("SC900 approved loader reconstructs exact proof, never selects a pending or newest stage, and excludes private files", async () => {
  const workspace = resolve(".data/sc900-bank-tests", randomUUID());
  await mkdir(workspace, { recursive: true });
  try {
    const plan = planFixture();
    const stage = await stageSc900Publication(plan, { workspaceRoot: workspace });
    await assert.rejects(loadSc900Publication(workspace), /ENOENT/);
    const selection = resolve(workspace, ".data/sc900-publication/current-approval.json");
    await writeFile(selection, JSON.stringify(stage.receipt));
    await assert.rejects(loadSc900Publication(workspace), /independent final approval/);
    const approval = await writeSc900FinalApproval(plan, {
      schemaVersion: 1, examId: "sc900", releaseId: plan.release.manifest.releaseId,
      planDigest: plan.planDigest, reviewDigest: plan.reviewDigest,
      reviewer: "Synthetic independent loader reviewer", reviewedAt: timestamp, independent: true, decision: "approve-activation",
    }, workspace);
    const explicit = await loadSc900Publication(workspace, { approvalPath: relative(workspace, approval.path) });
    assert.deepEqual(explicit.manifest, plan.release.manifest);
    assert.equal(explicit.files.size, plan.files.length);
    assert.equal(explicit.learning.records[plan.release.documents[0]!.question.id]?.sha256,
      plan.release.learningManifest.records[plan.release.documents[0]!.question.id]?.sha256);
    assert.ok([...explicit.files.keys()].every((path) => path.startsWith("exams/sc900/")));
    assert.ok(![...explicit.files.keys()].some((path) => /proof|receipt|inventory/.test(path)));
    for (const file of plan.files) {
      const entry = explicit.files.get(file.path)!;
      assert.equal(entry.kind, "source");
      assert.equal(byteSha256(await readFile(entry.path)), file.sha256);
    }
    await writeFile(selection, JSON.stringify(approval.receipt));
    assert.deepEqual((await loadSc900Publication(workspace)).receipt, approval.receipt);
    await assert.rejects(loadSc900Publication(workspace, { approvalPath: "../unapproved.json" }), /safe path/);
    const proofPath = resolve(stage.directory, "publication-proof.json");
    const proof = JSON.parse(await readFile(proofPath, "utf8"));
    proof.review.questions[0].documentHash = "f".repeat(64);
    await writeFile(proofPath, JSON.stringify(proof));
    await assert.rejects(loadSc900Publication(workspace), /proof differs/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
