import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EligibilityPolicySchema, type EligibilityPolicy } from "../src/domain/eligibility.js";
import { loadCleanBank } from "../tools/web/bank.js";
import { activeCounts, eligibilityIdentity, materializeEligibleRelease } from "../tools/eligibility/policy.js";
import { digest } from "../tools/ingest/normalize-shared.js";
import { withCurrentQuestions } from "../src/web/eligibility-repository.js";
import { createAttempt, validateAttemptDocuments } from "../src/web/engine.js";
import { QuestionCard } from "../src/web/ui/QuestionCard.js";
import type { StudyRepository } from "../src/web/types.js";

const fixture = (async () => {
  const bank = await loadCleanBank();
  const base = bank.releases.find((release) => release.catalog.releaseId === bank.manifest.releaseId)!;
  const removed = base.documents.filter((document) => [1, 430].includes(document.question.sources[0]!.questionNumber));
  const retiredIds = new Set(removed.map((document) => document.question.id));
  const activeQuestionIds = base.documents.map((document) => document.question.id).filter((id) => !retiredIds.has(id)).sort();
  const content = {
    schemaVersion: 1 as const, teachingReleaseId: base.catalog.releaseId, sourceRevision: base.catalog.sourceRevision,
    reviewedAt: "2026-09-19", reviewedQuestionIds: base.documents.map((document) => document.question.id).sort(),
    activeQuestionIds, activeCounts: activeCounts(base, new Set(activeQuestionIds)),
    retired: removed.map((document) => ({
      questionId: document.question.id, number: document.question.sources[0]!.questionNumber,
      sourceNumbers: document.question.sources.map((source) => source.questionNumber),
      category: "changed-assumptions" as const,
      reason: "Synthetic retirement fixture only; this prose is not published as an Azure content decision.",
      sources: [{ url: "https://learn.microsoft.com/en-us/azure/container-apps/custom-virtual-networks",
        title: "Synthetic reference fixture", supports: "Schema fixture for relevance-policy source binding." }],
    })),
  };
  const policy = EligibilityPolicySchema.parse({ ...content, ...eligibilityIdentity(content) });
  return { base, policy, removed };
})();

test("review policy partitions all source identities and rejects incomplete or duplicate decisions", async () => {
  const { policy } = await fixture;
  assert.equal(policy.activeCounts.questions, 602);
  assert.throws(() => EligibilityPolicySchema.parse({ ...policy, activeQuestionIds: policy.activeQuestionIds.slice(1) }));
  assert.throws(() => EligibilityPolicySchema.parse({ ...policy, retired: [...policy.retired, policy.retired[0]] }));
  assert.throws(() => EligibilityPolicySchema.parse({ ...policy, activeCounts: { ...policy.activeCounts, sourceQuestions: 606 } }));
});

test("retirement creates a smaller immutable release without modifying old sessions or answers", async () => {
  const { base, policy, removed } = await fixture;
  const before = digest(base);
  const oldDocuments = [...removed, ...base.documents.filter((document) => !removed.includes(document)).slice(0, 8)];
  const old = createAttempt({ mode: "free", id: "saved-before-retirement", now: 1, documents: oldDocuments });
  const active = materializeEligibleRelease(base, policy);
  assert.equal(digest(base), before);
  assert.equal(active.documents.length, 602);
  assert.equal(active.catalog.counts.comments, active.discussions.reduce((n, discussion) => n + discussion.comments.length, 0));
  assert.equal(active.catalog.counts.images, new Set(active.documents.flatMap((document) => document.question.media.map((media) => media.id))).size);
  assert.ok(active.documents.every((document) => !removed.some((item) => item.question.id === document.question.id)));
  assert.doesNotThrow(() => validateAttemptDocuments(old, oldDocuments));
  assert.throws(() => materializeEligibleRelease(base, { ...policy, activeCounts: { ...policy.activeCounts, images: 1 } }), /match|stale/);
});

test("current repositories exclude retired questions but explicit historical reads retain warning metadata", async () => {
  const { base, policy, removed } = await fixture;
  const raw: StudyRepository = {
    async loadCatalog() { return base.catalog; },
    async loadQuestion(id) { return base.documents.find((document) => document.question.id === id)!; },
    async loadQuestions(ids) { return ids.map((id) => base.documents.find((document) => document.question.id === id)!); },
    async loadDiscussion(id) { return base.discussions.find((discussion) => discussion.questionId === id)!; },
    mediaUrl() { return "https://example.test/image.png"; },
  };
  let reads = 0;
  const repository = withCurrentQuestions(raw, async () => { reads++; return policy; });
  assert.equal((await repository.loadCatalog()).questions.length, 602);
  assert.equal((await repository.loadCatalog(base.catalog.releaseId)).questions.length, 604);
  const id = removed[0]!.question.id;
  await assert.rejects(repository.loadQuestion(id), /retired/);
  await assert.rejects(repository.loadQuestions([id]), /retired/);
  const historical = await repository.loadQuestion(id, base.catalog.releaseId);
  assert.equal(historical.retirement?.questionId, id);
  assert.deepEqual(historical.answers, removed[0]!.answers);
  assert.equal(reads, 1);
  const html = renderToStaticMarkup(createElement(QuestionCard, {
    document: historical, repository, order: historical.question.fixedOptionOrder, revealed: false,
    response: { selectedIds: [], note: "", submitted: false, flagged: false, selfAssessment: null },
  }));
  assert.match(html, /Retired from the current question bank/);
  assert.match(html, /recorded score is unchanged/);
});

test("relevance load errors fail visibly and can be retried without silently restoring old pools", async () => {
  const { base, policy } = await fixture;
  const raw: StudyRepository = {
    async loadCatalog() { return base.catalog; }, async loadQuestion() { throw new Error("unused"); },
    async loadQuestions() { throw new Error("unused"); }, async loadDiscussion() { throw new Error("unused"); },
    mediaUrl() { throw new Error("unused"); },
  };
  let first = true;
  const repository = withCurrentQuestions(raw, async () => {
    if (first) { first = false; throw new Error("offline copy requires update"); }
    return policy;
  });
  await assert.rejects(repository.loadCatalog(), /requires update/);
  assert.equal((await repository.loadCatalog()).counts.questions, policy.activeCounts.questions);
  const stale: EligibilityPolicy = { ...policy, sourceRevision: "f".repeat(64) };
  await assert.rejects(withCurrentQuestions(raw, async () => stale).loadCatalog(), /does not match/);
});
