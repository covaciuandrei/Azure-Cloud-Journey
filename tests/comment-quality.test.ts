import assert from "node:assert/strict";
import { test } from "node:test";
import { CommentSchema, PreparedAnswerSchema, PreparedQuestionSchema } from "../src/domain/index.js";
import { assessCommentSupport, retainSupportedComments } from "../src/domain/commentQuality.js";

// The historical classifier is tested on synthetic inputs, never on the frozen approved set.
const fixture = (() => {
  const rich = (text: string) => [{ type: "text" as const, spans: [{ type: "text" as const, text, marks: [] }] }];
  const fingerprint = "a".repeat(64);
  const questionId = `q_${fingerprint}`;
  const sourceRevision = "b".repeat(64);
  const sourceOccurrenceId = "examprepper-45-q000001";
  const url = "https://example.test/synthetic-question";
  const options = ["Directory synchronization tool", "Directory replication"].map((text, index) => ({
    id: `opt_${String(index + 1).repeat(64)}`,
    contentHash: String(index + 1).repeat(64),
    content: rich(text),
  }));
  const prompt = rich("Which tool synchronizes a directory?");
  const shuffle = { allowed: true, reasons: [] };
  const review = { status: "pending", basedOnSourceRevision: null, reviewer: null, reviewedAt: null };
  const question = PreparedQuestionSchema.parse({
    schemaVersion: 1, id: questionId, exam: "AZ-104", fingerprint, sourceRevision,
    kind: "single-select", prompt, options, shuffle,
    sourceOccurrenceIds: [sourceOccurrenceId], assetIds: [], commentCount: 0,
    review, conversion: { status: "not-required", reason: null },
    readiness: { content: "complete", grading: "automatic", publication: "blocked-review" },
    published: false,
    sourcePresentation: { kind: "single-select", prompt, options, shuffle },
    media: [],
    sources: [{
      questionNumber: 1, pageNumber: 1, url,
      sourceOptionOrder: ["A", "B"],
      sourceLabelToOptionId: { A: options[0]!.id, B: options[1]!.id },
    }],
  });
  const value = { kind: "option-selection", optionIds: [options[0]!.id] };
  const answer = PreparedAnswerSchema.parse({
    schemaVersion: 1, id: questionId, questionId, sourceRevision,
    originalAnswers: [{
      sourceOccurrenceId, value, sourceLabels: ["A"], explanation: [], answerAssetIds: [],
      provenance: {
        kind: "source-default", source: "examprepper", url,
        capturedAt: "2026-01-01T00:00:00.000Z", evidence: "rendered-green-border",
        verification: "not-independently-verified",
      },
    }],
    originalKeysConflict: false,
    effectiveAnswer: {
      value, basis: "source-default", sourceOccurrenceIds: [sourceOccurrenceId],
      verification: "not-independently-verified",
    },
    review, published: false,
    assessment: {
      status: "source-default", provisional: false, summary: "Synthetic unit-test fixture",
      warnings: [], citations: [], sourceQuestionNumbers: [1],
      originalImageAnswers: [], effectiveImageAnswerSummary: null,
    },
  });
  const base = CommentSchema.parse({
    schemaVersion: 1, id: `c_${"0".repeat(64)}`, questionId, sourceOccurrenceId, sourceRevision,
    sourceCommentId: null, sourceCreatedAt: null, author: "Synthetic author",
    votes: 0, voteText: "0", displayedTimestamp: "Test timestamp",
    capturedAt: "2026-01-01T00:00:00.000Z",
    bodyText: "", bodyTextContent: "", body: [],
    parentId: null, rootId: `c_${"0".repeat(64)}`, childIds: [], treePath: [0],
    trust: "untrusted-source-content",
  });
  const comment = (text: string, index = 1) => ({
    ...base, id: `c_${String(index).padStart(64, "0")}`, bodyText: text, bodyTextContent: text,
    body: [{ type: "text" as const, spans: [{ type: "text" as const, text, marks: [] }] }],
    parentId: null, rootId: `c_${String(index).padStart(64, "0")}`, childIds: [], treePath: [index],
  });
  return { question, answer, comment };
})();

test("unsupported answer claims are removed even when they disagree with the source", async () => {
  const { question, answer, comment } = await fixture;
  for (const text of ["A is correct", "B is wrong", "Selected Answer: A", "No Yes Yes", "N,Y,Y is correct!",
    "The correct answer is No", "I tested B. Correct.", "So the answer is Hyper-V site and Replication policy"]) {
    assert.equal(assessCommentSupport(comment(text), question, answer).retained, false, text);
  }
});

test("reasoning, supporting references, empirical details, and technical clarification remain", async () => {
  const { question, answer, comment } = await fixture;
  for (const text of [
    "B because Active Directory replication does not synchronize users to Azure AD.",
    "NSGs are stateful.",
    "Tags aren't inherited.",
    "Peering is not transitive.",
    "Only owners can assign roles to other users.",
    "Azure AD Connect sends changes after a synchronization cycle.",
    "Selected Answer: B\nhttps://learn.microsoft.com/en-us/azure/active-directory/hybrid/connect/",
    "I tested it by stopping all the VMs in the availability set and the resize worked.",
    "Why does the subnet NSG allow ICMP but the VM still fail to respond?",
    "At 15 minutes the scale-out starts. Memory stays at 80%, but the cooldown prevents another operation until the next interval.",
    "Daily backup points = 5 + monthly backup points = 1. Total backups after 8 days = 6.",
    "Correct Answer: D\n64 bytes from VMTEST1: icmp_seq=1 ttl=64 time=0.013 ms\n5 packets transmitted, 5 received, 0% packet loss.",
    "Steps I took via the Azure Portal: created a VM, created a Compute Gallery, and successfully deployed the image.",
    "La conexion VPN falla porque el trafico necesita la puerta de enlace de Azure para acceder a otra red.",
  ]) {
    assert.equal(assessCommentSupport(comment(text), question, answer).retained, true, text);
  }
});

test("thanks, promotions and exam-attendance chatter are excluded", async () => {
  const { question, answer, comment } = await fixture;
  for (const text of [
    "Thank you for this!",
    "On the exam today, 1.feb.2022. Passed with 900.",
    "Got this question on 09/09/23",
    "Please send the PDF to me on Telegram.",
    "What is the correct answer?",
  ]) {
    assert.equal(assessCommentSupport(comment(text), question, answer).retained, false, text);
  }
});

test("useful replies are promoted when answer-only parents are removed", async () => {
  const { question, answer, comment } = await fixture;
  const parent = comment("A is correct", 1);
  const child = {
    ...comment("No, because directory replication does not trigger Azure AD synchronization.", 2),
    parentId: parent.id, rootId: parent.id, treePath: [1, 0],
  };
  const inputs = [{ ...parent, childIds: [child.id] }, child];
  const before = structuredClone(inputs);
  const result = retainSupportedComments(inputs, question, answer);
  assert.equal(result.comments.length, 1);
  assert.equal(result.comments[0]?.id, child.id);
  assert.equal(result.comments[0]?.parentId, null);
  assert.equal(result.comments[0]?.rootId, child.id);
  assert.equal(result.promoted, 1);
  assert.deepEqual(inputs, before);
  assert.deepEqual(retainSupportedComments(result.comments, question, answer).comments, result.comments);
});
