import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Sc900CaptureLedgerSchema } from "../src/domain/sc900Capture.js";
import { Sc900ScopedCaptureLedgerSchema, SC900_UNAVAILABLE_DISCUSSIONS_NOTICE } from "../src/domain/sc900Scope.js";
import { Sc900PublicationReviewSchema } from "../src/domain/sc900Publication.js";
import { Sc900ManifestSchema, Sc900DiscussionSchema } from "../src/domain/sc900Bank.js";
import { Sc900EligibilityPolicySchema, Sc900DuplicateExclusionSchema } from "../src/domain/sc900Eligibility.js";
import { RetirementSchema } from "../src/domain/eligibility.js";
import {
  prepareSc900Release, buildSc900StaticPlan, createSc900ApprovalReceipt, stageSc900Publication,
  writeSc900FinalApproval, loadSc900Publication,
} from "../tools/sc900/publication.js";
import {
  sc900AuthorizationDigest, sc900SourceRevision, sc900DuplicateAdjudicationDigest,
} from "../tools/sc900/canonical.js";
import { sc900BankFixture, sc900BankReview, SC900_FIXTURE_TIMESTAMP } from "./sc900-bank-fixture.js";
import { sc900ScopedFixture, sc900ScopedReview } from "./sc900-scoped-fixture.js";
import { createStudyRepository } from "../src/web/data.js";
import { createFirestoreStudyRepository } from "../src/web/firestore-repository.js";
import { withCurrentQuestions } from "../src/web/eligibility-repository.js";
import { DiscussionBelow } from "../src/web/ui/AnswerDetails.js";
import { Home } from "../src/web/ui/Home.js";
import { hasDocumentedQualification } from "../src/web/ui/QuestionCard.js";

test("scoped ledgers are explicit, authorization-bound, and never parse as full discussion capture", () => {
  const input = sc900ScopedFixture();
  assert.equal(Sc900CaptureLedgerSchema.safeParse(input.ledger).success, false);
  const ledger = Sc900ScopedCaptureLedgerSchema.parse(input.ledger);
  assert.equal(ledger.sourceCommentCount, null);
  assert.ok(ledger.occurrences.every((item) => item.discussionState === "unavailable" && item.sourceCommentCount === null));
  for (const input of [
    { ...ledger, sourceCommentCount: 0 },
    { ...ledger, occurrences: [{ ...ledger.occurrences[0]!, discussionState: "loaded" }, ...ledger.occurrences.slice(1)] },
    { ...ledger, occurrences: [{ ...ledger.occurrences[0]!, answerRevealed: false }, ...ledger.occurrences.slice(1)] },
  ]) assert.equal(Sc900ScopedCaptureLedgerSchema.safeParse(input).success, false);
  const released = prepareSc900Release(input);
  assert.equal(released.manifest.approvedCommentsDigest, null);
  assert.equal(released.manifest.discussionScope?.sourceCommentCount, null);
  assert.equal(released.manifest.counts.sourceQuestions, input.ledger.reported.questions);
  assert.equal(released.manifest.counts.images, input.ledger.assets.length);
  assert.equal(released.catalog.counts.duplicatesGrouped, 0);
  assert.ok(released.documents.every((document) => document.question.discussionScope && !document.discussionEnabled));
  assert.ok(released.discussions.every((discussion) => discussion.discussionScope && discussion.comments.length === 0));
  const { ownerAuthorization: _receipt, ...missing } = input;
  assert.throws(() => prepareSc900Release(missing));
  assert.throws(() => prepareSc900Release({ ...input, ledger: sc900BankFixture().ledger }), /Full-discussion/);
  for (const key of ["sourceScopeReceiptSha256", "rawPageInventoryDigest", "assetInventoryDigest"] as const) {
    assert.throws(() => prepareSc900Release({ ...input, ownerAuthorization: { ...input.ownerAuthorization!, [key]: "0".repeat(64) } }), /authorization/i);
  }
  for (const change of [
    (input: ReturnType<typeof sc900ScopedFixture>) => { input.documents.pop(); },
    (input: ReturnType<typeof sc900ScopedFixture>) => { input.assets = new Map(); },
    (input: ReturnType<typeof sc900ScopedFixture>) => { input.documents[0]!.answers.originalAnswers = []; },
    (input: ReturnType<typeof sc900ScopedFixture>) => {
      input.discussions[0]!.comments = sc900BankFixture().discussions[0]!.comments;
    },
  ]) {
    const changed = sc900ScopedFixture();
    change(changed);
    assert.throws(() => prepareSc900Release(changed));
  }
  const changed = { ...input.ownerAuthorization!, authorizationText: "Changed synthetic owner decision after approval." };
  assert.notEqual(sc900SourceRevision({ ...ledger, authorizationDigest: sc900AuthorizationDigest(changed) }), sc900SourceRevision(ledger));
});

test("scoped reviews never claim loaded threads and final approval must acknowledge the exact omission", async () => {
  const input = sc900ScopedFixture();
  const release = prepareSc900Release(input);
  const review = sc900ScopedReview(release);
  assert.equal(review.checks.allComments, null);
  assert.ok(review.questions.every((item) => item.discussionHash === null && item.discussionOmissionHash));
  assert.equal(Sc900PublicationReviewSchema.safeParse({ ...review, checks: { ...review.checks, allComments: true } }).success, false);
  assert.throws(() => buildSc900StaticPlan(input, sc900BankReview(prepareSc900Release(sc900BankFixture()))), /Scoped publication/);
  const plan = buildSc900StaticPlan(input, review);
  const final = { schemaVersion: 1 as const, examId: "sc900" as const, releaseId: release.manifest.releaseId,
    planDigest: plan.planDigest, reviewDigest: plan.reviewDigest, reviewer: "Synthetic final reviewer",
    reviewedAt: SC900_FIXTURE_TIMESTAMP, independent: true as const, decision: "approve-activation" as const };
  assert.throws(() => createSc900ApprovalReceipt(plan, final));
  const approved = { ...final, discussionScope: release.manifest.discussionScope! };
  assert.equal(createSc900ApprovalReceipt(plan, approved).activate, true);
  const root = resolve(`.data/sc900-scoped-test-${randomUUID()}`);
  try {
    await mkdir(root, { recursive: true });
    const staged = await stageSc900Publication(plan, { workspaceRoot: root });
    const receipt = await writeSc900FinalApproval(plan, approved, root);
    const loaded = await loadSc900Publication(root, { approvalPath: relative(root, receipt.path) });
    assert.deepEqual(loaded.manifest, release.manifest);
    assert.deepEqual(loaded.ownerAuthorization, input.ownerAuthorization);
    assert.ok(![...loaded.files.keys()].some((path) => /authorization|proof/.test(path)));
    const proofPath = resolve(staged.directory, "publication-proof.json");
    const proof = JSON.parse(await readFile(proofPath, "utf8"));
    proof.ownerAuthorization.authorizationText += " modified";
    await writeFile(proofPath, JSON.stringify(proof));
    await assert.rejects(loadSc900Publication(root, { approvalPath: relative(root, receipt.path) }), /authorization/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unavailable threads and active reviewed answers are disclosed identically by static and Firestore readers", async () => {
  const input = sc900ScopedFixture();
  const release = prepareSc900Release(input);
  const plan = buildSc900StaticPlan(input, sc900ScopedReview(release));
  const files = new Map(plan.files.map((file) => [`/${file.path}`, file.bytes]));
  const fetcher: typeof fetch = async (request) => {
    const url = new URL(String(request));
    const file = files.get(url.pathname);
    return file ? new Response(Buffer.from(file)) : new Response("", { status: 404 });
  };
  const repository = createStudyRepository("https://example.test/", fetcher, "sc900");
  const catalog = await repository.loadCatalog();
  const question = await repository.loadQuestion(catalog.questions[0]!.id);
  const discussion = await repository.loadDiscussion(question.question.id);
  assert.equal(discussion.discussionScope?.sourceCommentCount, null);
  const html = renderToStaticMarkup(createElement(DiscussionBelow, { document: question, repository }));
  assert.ok(html.includes(SC900_UNAVAILABLE_DISCUSSIONS_NOTICE));
  assert.doesNotMatch(html, /Discussion \(0\)|No additional useful discussion/);
  const home = renderToStaticMarkup(createElement(Home, { catalog, activeAttempt: null,
    onPractice() {}, onExam() {}, onLibrary() {}, onResume() {} }));
  assert.ok(home.includes(SC900_UNAVAILABLE_DISCUSSIONS_NOTICE));
  const cloud = createFirestoreStudyRepository({
    async document(path) {
      if (path === "studyMetadata/sc900Bank") return { schemaVersion: 1, examId: "sc900", bankVersion: release.manifest.bankVersion,
        releaseId: release.manifest.releaseId, sourceRevision: release.manifest.sourceRevision, discussionScope: release.manifest.discussionScope };
      if (path.endsWith("/catalogs/sc900")) return release.catalog;
      return release.documents.find((document) => path.endsWith(`/questions/${document.question.id}`));
    },
    async comments() { throw new Error("Unavailable source threads must never be queried."); },
  }, repository, "https://example.test/", "sc900");
  assert.deepEqual((await cloud.loadDiscussion(question.question.id)).discussionScope, discussion.discussionScope);
  const invalid = { ...release.manifest, discussionScope: undefined };
  assert.equal(Sc900ManifestSchema.safeParse(invalid).success, false);
  assert.equal(Sc900DiscussionSchema.safeParse({ ...release.discussions[0],
    comments: sc900BankFixture().discussions.find((item) => item.comments.length)!.comments }).success, false);
});

test("SC900 duplicate exclusions keep original records and assets while requiring an active target and exact adjudication", async () => {
  const input = sc900ScopedFixture();
  const [target, copy] = input.documents;
  assert.ok(target && copy);
  const excluded = {
    examId: "sc900" as const, questionId: copy.question.id, number: 2, sourceNumbers: [2],
    category: "duplicate" as const, reason: "This synthetic duplicate task is kept in the archive rather than counted twice in new practice.",
    sources: [], duplicateOfQuestionId: target.question.id,
    evidence: "Synthetic independent adjudication found the same task assumptions and expected outcome in both records. Both original source records and their image references remain retained in the archive.",
  };
  const retirement = Sc900DuplicateExclusionSchema.parse({ ...excluded, adjudicationDigest: sc900DuplicateAdjudicationDigest(excluded) });
  input.eligibility.retired = [retirement];
  input.eligibility.activeQuestionIds = [target.question.id];
  input.eligibility.activeCounts = { questions: 1, comments: 0, images: 1, automatic: 1, manual: 0, omittedComments: 0, sourceQuestions: 1, duplicatesGrouped: 0 };
  input.documents[1]!.answers.provisional = true;
  const release = prepareSc900Release(input);
  assert.equal(release.documents.length, 2);
  assert.equal(release.assets.size, 1);
  assert.equal(release.documents.find((item) => item.question.id === copy.question.id)!.answers.provisional, true);
  assert.equal(release.catalog.counts.sourceQuestions, 2);
  assert.equal(RetirementSchema.safeParse(retirement).success, false);
  for (const duplicateOfQuestionId of [copy.question.id, `q_${"a".repeat(64)}`]) {
    assert.equal(Sc900EligibilityPolicySchema.safeParse({ ...input.eligibility,
      retired: [{ ...retirement, duplicateOfQuestionId }] }).success, false);
  }
  assert.equal(Sc900EligibilityPolicySchema.safeParse({ ...input.eligibility,
    activeQuestionIds: [], activeCounts: { ...input.eligibility.activeCounts, questions: 0, automatic: 0, sourceQuestions: 0 },
    retired: [retirement, { ...retirement, questionId: target.question.id, duplicateOfQuestionId: copy.question.id, number: 1, sourceNumbers: [1] }] }).success, false);
  assert.throws(() => prepareSc900Release({ ...input, eligibility: { ...input.eligibility,
    retired: [{ ...retirement, evidence: `${retirement.evidence} Changed later.` }] } }), /exact independently adjudicated/);
  assert.equal(Sc900EligibilityPolicySchema.safeParse({ ...input.eligibility, retired: [{
    examId: "sc900", questionId: copy.question.id, number: 2, sourceNumbers: [2], category: "defective-question",
    reason: retirement.reason, sources: [],
  }] }).success, false);
  const current = withCurrentQuestions({
    examId: "sc900", async loadCatalog() { return release.catalog; },
    async loadQuestion(id) { return release.documents.find((item) => item.question.id === id)!; },
    async loadQuestions(ids) { return release.documents.filter((item) => ids.includes(item.question.id)); },
    async loadDiscussion(id) { return release.discussions.find((item) => item.questionId === id)!; },
    mediaUrl() { throw new Error("No media requested"); },
  }, async () => release.eligibility);
  assert.deepEqual((await current.loadCatalog()).questions.map((question) => question.id), [target.question.id]);
  await assert.rejects(current.loadQuestion(copy.question.id), /retired/);
  assert.equal((await current.loadQuestion(copy.question.id, release.manifest.releaseId)).retirement?.category, "duplicate");
});

test("all active SC900 automatic keys and manual parts must be definitive without rewriting historical answers", () => {
  for (const change of [
    (input: ReturnType<typeof sc900ScopedFixture>) => { input.documents[0]!.answers.provisional = true; },
    (input: ReturnType<typeof sc900ScopedFixture>) => { input.learning.explanations[0]!.status = "conditional"; input.learning.explanations[0]!.caveat = "This synthetic uncertainty should not be graded without a definite answer."; input.learning.explanations[0]!.options[0]!.verdict = "conditional"; },
    (input: ReturnType<typeof sc900ScopedFixture>) => { input.learning.explanations[0]!.status = "conditional"; input.learning.explanations[0]!.caveat = "This synthetic uncertainty should not be graded without a definite answer."; input.learning.explanations[0]!.correctOptionIds = [input.documents[0]!.question.options[1]!.id]; },
    (input: ReturnType<typeof sc900ScopedFixture>) => { input.learning.explanations[1]!.answerParts[0]!.answer = "unresolved"; },
  ]) {
    const input = sc900ScopedFixture();
    change(input);
    assert.throws(() => prepareSc900Release(input), /Active|active/);
  }
  const input = sc900ScopedFixture();
  const historical = sc900ScopedFixture();
  historical.documents[1]!.answers.provisional = true;
  historical.learning.explanations[1]!.status = "incomplete";
  historical.learning.explanations[1]!.caveat = "Synthetic historical source lacks a required assumption; retain but never grade it in new sessions.";
  historical.eligibility.activeQuestionIds = [historical.documents[0]!.question.id];
  historical.eligibility.activeCounts = { questions: 1, comments: 0, images: 1, automatic: 1, manual: 0,
    sourceQuestions: 1, duplicatesGrouped: 0, omittedComments: 0 };
  historical.eligibility.retired = [{ examId: "sc900", category: "defective-question",
    questionId: historical.documents[1]!.question.id, number: 2, sourceNumbers: [2],
    reason: "An essential synthetic task assumption is missing, so this archived question is not scored in new practice.",
    sources: historical.learning.explanations[1]!.sources }];
  assert.equal(prepareSc900Release(historical).eligibility.activeCounts.questions, 1);
  input.learning.explanations[0]!.status = "conditional";
  input.learning.explanations[0]!.caveat = "The documented qualification explains scope, while every answer choice has a definite verdict.";
  const original = structuredClone(input.documents[0]!.answers.originalAnswers);
  const released = prepareSc900Release(input);
  assert.deepEqual(released.documents.find((item) => item.question.id === input.documents[0]!.question.id)!.answers.originalAnswers, original);
  assert.equal(hasDocumentedQualification(input.documents[0]!, input.learning.explanations[0]!), true);
  assert.equal(hasDocumentedQualification({ ...input.documents[0]!, examId: "az104" }, input.learning.explanations[0]!), false);
  assert.equal(hasDocumentedQualification(input.documents[0]!, {
    ...input.learning.explanations[0]!, options: input.learning.explanations[0]!.options.map((option) => ({ ...option, verdict: "conditional" })),
  }), false);
});
