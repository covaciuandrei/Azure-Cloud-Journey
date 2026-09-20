import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { load } from "cheerio";
import {
  AnswerRecordSchema, CommentSchema, ConversionOverlaySchema, QuestionSchema, RichContentSchema,
  ReviewOverlaySchema, assertAnswerOptionIds, assertDocumentSize, richAssetIds,
  validateConversionForQuestion, validateReviewForQuestion,
  type ConversionOverlay, type ReviewOverlay,
} from "../src/domain/index.js";
import { auditDataset, parseAuditArgs } from "../tools/ingest/audit.js";
import { decodeCapturedAsset, inspectImage } from "../tools/ingest/normalize-assets.js";
import { normalizeCaptures, type CaptureInput, type NormalizedDataset } from "../tools/ingest/normalize-core.js";
import { normalizeDirectory, parseNormalizeArgs } from "../tools/ingest/normalize.js";
import {
  digest, jsonFile, plainText, sha256, type RawAsset, type RawImage, type RawQuestion,
} from "../tools/ingest/normalize-shared.js";

const capturedAt = "2026-09-09T21:00:00.000Z";
const green = "rgb(104, 211, 145)";
const white = "rgb(255, 255, 255)";
const workspace = process.cwd();
const text = (html: string) => load(html, undefined, false).text();

interface QuestionFixture {
  number?: number;
  prompt?: string;
  options?: string[];
  selected?: string[];
  comments?: string;
  explanation?: string;
  images?: RawImage[];
  discussionLoad?: RawQuestion["discussionLoad"];
}
function comment(
  body = "<p>B is correct.</p>", replies = "", author = "Reader", votes = "12 points", timestamp = "about 2 years ago",
): string {
  return `<div><a>[-]</a><div><ul class="chakra-wrap__list"><div><b>${author}</b><b> ${votes}</b><span> ${timestamp}</span></div><div>${body}</div><div>${replies}</div></ul></div></div>`;
}
function question(fixture: QuestionFixture = {}): RawQuestion {
  const number = fixture.number ?? 1;
  const options = fixture.options ?? ["<p>Yes</p>", "<p>No</p>"];
  const selected = fixture.selected ?? ["B"];
  const prompt = fixture.prompt ?? "<p>Does the solution meet the goal?</p>";
  const comments = fixture.comments ?? comment();
  const labels = options.map((_, index) => String.fromCharCode(65 + index));
  const html = `<div class="chakra-accordion__item"><h2><button class="chakra-accordion__button">Question ${number}</button></h2><div class="chakra-accordion__panel"><div><div class="css-naa3lg">${prompt}</div><div>${options.map((content, index) => `<div class="chakra-stack"><div>${labels[index]}<!-- -->.</div><div>${content}</div></div>`).join("")}</div></div><div><button>Hide Answer</button></div>${fixture.explanation === undefined ? "" : `<div><b>Correct answer:</b>${fixture.explanation}</div>`}<div>${comments}</div></div></div>`;
  return {
    heading: `Question ${number}`, html, renderedText: text(html), answerRevealed: true,
    choiceStyles: options.map((content, index) => ({
      label: labels[index]!, text: text(content), borderColor: selected.includes(labels[index]!) ? green : white, borderWidth: "2px",
    })),
    commentCount: load(html)("ul.chakra-wrap__list").length,
    remainingControls: [], loadingIndicators: 0, images: fixture.images ?? [],
    discussionLoad: fixture.discussionLoad ?? { status: "loaded" },
  };
}
function captureInput(questions: RawQuestion[], assets: RawAsset[] = [], page = 1, prefix = ".data/raw/pages"): CaptureInput {
  return {
    path: `${prefix}/page-${String(page).padStart(3, "0")}.json`,
    content: jsonFile({
      captureVersion: 1, method: "rendered-browser-ui",
      url: `https://www.examprepper.co/exam/45/${page}`,
      title: `AZ-104 - Page ${page}`, capturedAt, questions, assets,
    }),
  };
}
function normalize(questions: RawQuestion[], assets: RawAsset[] = []): NormalizedDataset {
  return normalizeCaptures([captureInput(questions, assets)], {
    expected: { pages: 1, occurrences: questions.length, pageSize: Math.max(5, questions.length) },
  });
}
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let index = 0; index < 8; index++) crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function png(red = 20, width = 1, height = 1): Buffer {
  const chunk = (name: string, data: Buffer) => {
    const chunkData = Buffer.concat([Buffer.from(name), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(chunkData));
    return Buffer.concat([length, chunkData, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = y * (width * 4 + 1) + 1 + x * 4;
      rows.set([red, 40, 60, 255], offset);
    }
  }
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0)),
  ]);
}
function rawAsset(url: string, bytes = png()): RawAsset {
  return { url, contentType: "image/png", byteLength: bytes.length, base64: bytes.toString("base64") };
}
function image(url: string, alt = "Question", width = 1, height = 1): RawImage {
  return { src: url, currentSrc: url, alt, width, height, loaded: true };
}
function imageQuestion(number = 1, sameBytes = false): { question: RawQuestion; assets: RawAsset[] } {
  const promptUrl = "https://images.example.test/question.png";
  const answerUrl = "https://images.example.test/answer.png";
  return {
    question: question({
      number,
      prompt: `<p>DRAG DROP -</p><p>Select and Place:</p><img src="${promptUrl}" alt="Question">`,
      options: [], selected: [],
      explanation: `<p>The author explains the source answer.</p><img src="${answerUrl}" alt="">`,
      images: [image(promptUrl), image(answerUrl, "")],
    }),
    assets: [rawAsset(promptUrl), rawAsset(answerUrl, png(sameBytes ? 20 : 90))],
  };
}
function review(dataset: NormalizedDataset, questionId = dataset.questions[0]!.id): ReviewOverlay {
  const q = dataset.questions.find((item) => item.id === questionId)!;
  return ReviewOverlaySchema.parse({
    schemaVersion: 1, questionId, basedOnSourceRevision: q.sourceRevision,
    status: "completed", reviewer: "Synthetic fixture reviewer", reviewedAt: capturedAt,
    commentAssessment: {
      assessedCommentIds: dataset.comments.filter((item) => item.questionId === questionId).map((item) => item.id),
      summary: "Read the synthetic discussion, including replies. Its one assertion agrees with the source; retain the source provisionally.",
    },
    answerDecision: { kind: "retain-source" }, published: false,
  });
}
async function withWorkspace(run: (path: string) => Promise<void>): Promise<void> {
  const path = `.data/ingest-test-runs/${process.pid}-${randomUUID()}`;
  await mkdir(path, { recursive: true });
  try { await run(path); } finally { await rm(path, { recursive: true, force: true }); }
}
async function persist(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, jsonFile(value));
}
async function persistInput(input: CaptureInput): Promise<void> {
  await mkdir(dirname(input.path), { recursive: true });
  await writeFile(input.path, input.content);
}

test("source border keys remain unverified and every normalized question starts unpublished/review-pending", () => {
  const raw = question({ options: ["<p style=\"background: rgb(104, 211, 145)\">Yes</p>", "<p>No</p>"] });
  const dataset = normalize([raw]);
  const q = dataset.questions[0]!;
  const answer = dataset.answers[0]!;
  const occurrence = dataset.occurrences[0]!;
  assert.deepEqual(answer.originalAnswers[0]!.sourceLabels, ["B"]);
  assert.deepEqual(answer.effectiveAnswer.value, { kind: "option-selection", optionIds: [occurrence.sourceLabelToOptionId.B] });
  assert.equal(answer.effectiveAnswer.verification, "not-independently-verified");
  assert.equal(answer.originalAnswers[0]!.provenance.evidence, "rendered-green-border");
  assert.equal(q.review.status, "pending");
  assert.equal(answer.review.status, "pending");
  assert.equal(q.published, false);
  assert.equal(answer.published, false);
  assert.equal(q.readiness.publication, "blocked-review");
  assert.equal(QuestionSchema.safeParse({ ...q, published: true }).success, false);
  assert.equal(AnswerRecordSchema.safeParse({ ...answer, published: true }).success, false);
});

test("legacy page captures require the actual Hide Answer control and retain legacy evidence", () => {
  const raw = question();
  delete raw.answerRevealed;
  delete raw.loadingIndicators;
  delete raw.discussionLoad;
  const dataset = normalize([raw]);
  assert.equal(dataset.occurrences[0]!.capture.answerEvidence, "legacy-hide-control");
  assert.equal(dataset.occurrences[0]!.capture.discussionLoadStatus, "legacy-rendered");
  raw.html = raw.html.replace("Hide Answer", "Show Answer");
  assert.throws(() => normalize([raw]), /Question 1.*Hide Answer/);
});

test("safe option permutations deduplicate without losing labels, occurrences or discussions", () => {
  const dataset = normalize([
    question({ number: 1, options: ["<p>First distinct content</p>", "<p>Second distinct content</p>"], selected: ["B"] }),
    question({ number: 2, options: ["<p>Second distinct content</p>", "<p>First distinct content</p>"], selected: ["A"] }),
  ]);
  assert.equal(dataset.questions.length, 1);
  assert.equal(dataset.occurrences.length, 2);
  assert.equal(dataset.comments.length, 2);
  assert.equal(new Set(dataset.comments.map((item) => item.id)).size, 2);
  assert.equal(dataset.manifest.duplicateGroups, 1);
  assert.equal(dataset.manifest.mergedOccurrences, 1);
  assert.equal(dataset.questions[0]!.shuffle.allowed, true);
  assert.equal(dataset.questions[0]!.commentCount, 2);
  assert.equal(dataset.answers[0]!.originalKeysConflict, false);
  assert.equal(dataset.answers[0]!.originalAnswers.length, 2);
  const [first, second] = dataset.occurrences;
  assert.equal(first!.sourceLabelToOptionId.B, second!.sourceLabelToOptionId.A);
  assert.equal(first!.sourceLabelToOptionId.A, second!.sourceLabelToOptionId.B);
  assert.deepEqual(dataset.answers[0]!.originalAnswers.map((item) => item.sourceLabels), [["B"], ["A"]]);
  assert.deepEqual(dataset, normalizeCaptures([captureInput([
    question({ number: 1, options: ["<p>First distinct content</p>", "<p>Second distinct content</p>"], selected: ["B"] }),
    question({ number: 2, options: ["<p>Second distinct content</p>", "<p>First distinct content</p>"], selected: ["A"] }),
  ])], { expected: { pages: 1, occurrences: 2, pageSize: 5 } }));
});

test("different source keys and explanations are preserved rather than silently choosing one", () => {
  const dataset = normalize([
    question({ number: 1, selected: ["A"], explanation: "<p>Author says yes.</p>", comments: comment("<p>I agree.</p>") }),
    question({ number: 2, selected: ["B"], explanation: "<p>Author says no.</p>", comments: comment("<p>I disagree.</p>") }),
  ]);
  assert.equal(dataset.questions.length, 1);
  assert.equal(dataset.answers[0]!.originalKeysConflict, true);
  assert.equal(dataset.answers[0]!.effectiveAnswer.basis, "source-conflict");
  assert.deepEqual(dataset.answers[0]!.effectiveAnswer.value, {
    kind: "manual", reason: "conflicting-source-keys", sourceAnswerAssetIds: [],
  });
  assert.deepEqual(dataset.answers[0]!.originalAnswers.map((item) => plainText(item.explanation)), [
    "Author says yes.", "Author says no.",
  ]);
  assert.deepEqual(dataset.comments.map((item) => item.bodyText).sort(), ["I agree.", "I disagree."]);
});

test("fingerprints preserve numeric values, case, code whitespace, instructions and option content", () => {
  const variants = [
    "<p>Deploy 2 VMs.</p>",
    "<p>Deploy 3 VMs.</p>",
    "<p>Deploy 2 vms.</p>",
    "<p>Deploy 2 VMs. Select two.</p>",
    "<p>Deploy 2 VMs.</p><pre><code>AccountName = A</code></pre>",
    "<p>Deploy 2 VMs.</p><pre><code>AccountName = a</code></pre>",
    "<p>Deploy 2 VMs.</p><pre><code>AccountName  = A</code></pre>",
  ];
  const ids = variants.map((prompt) => normalize([question({ prompt })]).questions[0]!.id);
  assert.equal(new Set(ids).size, variants.length);
  const changedChoice = normalize([question({ prompt: variants[0]!, options: ["<p>Yes</p>", "<p>NO</p>"] })]);
  assert.notEqual(changedChoice.questions[0]!.id, ids[0]);
  const assetUrl = "https://images.example.test/exhibit.png";
  const q = question({ prompt: `<p>Use this exhibit.</p><img src="${assetUrl}" alt="Question">`, images: [image(assetUrl)] });
  assert.notEqual(normalize([q], [rawAsset(assetUrl)]).questions[0]!.id,
    normalize([q], [rawAsset(assetUrl, png(21))]).questions[0]!.id);
});

test("label-relative, all-of-above, matching and repeated options disable unsafe shuffling", () => {
  for (const content of [
    "Both A and B", "A+B", "All of the above", "All the above", "The previous option",
    "The first two options", "Arrange these in the correct order", "Put these in order",
  ]) {
    const dataset = normalize([question({ options: [`<p>${content}</p>`, "<p>A different response</p>"] })]);
    assert.equal(dataset.questions[0]!.shuffle.allowed, false, content);
  }
  const a = normalize([question({ options: ["<p>All of the above</p>", "<p>Yes</p>"] })]);
  const b = normalize([question({ options: ["<p>Yes</p>", "<p>All of the above</p>"] })]);
  assert.notEqual(a.questions[0]!.id, b.questions[0]!.id);
  const identical = normalize([question({ options: ["<p>Identical</p>", "<p>Identical</p>"] })]);
  assert.equal(identical.questions[0]!.options.length, 2);
  assert.equal(new Set(identical.questions[0]!.options.map((option) => option.id)).size, 2);
  assert.ok(identical.questions[0]!.shuffle.reasons.includes("duplicate-option-content"));
  assert.equal(identical.answers[0]!.effectiveAnswer.value.kind, "manual");
});

test("all replies and exact body text survive safe rich parsing; relative dates remain relative", () => {
  const body = "<p>Line one.</p><p></p><p><b>Case A</b> &lt;literal&gt;</p>" +
    "<pre><code class=\"language-powershell\">  A  B\nC &lt; D\n</code></pre>" +
    "<table><caption>Values</caption><tr><th rowspan=\"0\">Name</th><td colspan=\"2\"><code>RG1</code></td></tr></table>" +
    "<ol start=\"3\"><li>First</li><li><i>Second</i></li></ol>" +
    "<p><a href=\"https://learn.example.test/reference\">Safe</a> <a href=\"javascript:alert(1)\">Unsafe URL text</a></p>" +
    "<script>throw new Error('must not execute')</script><iframe src=\"https://evil.example.test\"></iframe>";
  const deepest = comment("<p>Nested reply.</p>", "", "Third author", "-2 points", "yesterday");
  const reply = comment("<p>Reply.</p>", deepest, "Second author", "1 point", "4 months ago");
  const root = comment(body, reply, "Root author", "1,234 points", "about 5 years ago");
  const dataset = normalize([question({ comments: root })]);
  const records = [...dataset.comments].sort((a, b) => a.treePath.length - b.treePath.length);
  assert.equal(records.length, 3);
  const [first, second, third] = records;
  assert.deepEqual(records.map((item) => item.treePath), [[0], [0, 0], [0, 0, 0]]);
  assert.equal(first!.parentId, null);
  assert.equal(second!.parentId, first!.id);
  assert.equal(third!.parentId, second!.id);
  assert.equal(third!.rootId, first!.id);
  assert.deepEqual(first!.childIds, [second!.id]);
  assert.deepEqual(second!.childIds, [third!.id]);
  assert.equal(first!.votes, 1234);
  assert.equal(third!.votes, -2);
  assert.equal(first!.displayedTimestamp, "about 5 years ago");
  assert.equal(first!.sourceCreatedAt, null);
  assert.equal(first!.sourceCommentId, null);
  assert.equal(first!.capturedAt, capturedAt);
  assert.equal(first!.trust, "untrusted-source-content");
  assert.ok(first!.bodyText.startsWith("Line one.\n\nCase A <literal>\n"));
  assert.ok(first!.bodyTextContent.includes("Line one.Case A <literal>  A  B\nC < D\n"));
  assert.equal(first!.bodyTextContent.includes("must not execute"), false);
  const code = first!.body.find((block) => block.type === "code");
  assert.deepEqual(code, { type: "code", code: "  A  B\nC < D\n", language: "powershell" });
  const table = first!.body.find((block) => block.type === "table");
  assert.equal(table?.type === "table" ? table.rows[0]!.cells[0]!.rowSpan : undefined, 0);
  const serialized = JSON.stringify(first!.body);
  assert.ok(serialized.includes("https://learn.example.test/reference"));
  assert.ok(serialized.includes("Unsafe URL text"));
  assert.equal(serialized.includes("javascript:"), false);
  assert.equal(serialized.includes("iframe"), false);
  assert.equal(serialized.includes("must not execute"), false);
  assert.ok(dataset.manifest.issues.some((item) => item.code === "removed-unsafe-link"));
  assert.ok(dataset.manifest.issues.some((item) => item.code === "removed-active-content"));
  assert.equal(RichContentSchema.safeParse([{ type: "raw-html", html: "<script>alert(1)</script>" }]).success, false);
  assert.equal(CommentSchema.safeParse({ ...first, sourceCreatedAt: capturedAt }).success, false);
});

test("comment IDs are content/tree/occurrence based while revisions expose changed votes or captures", () => {
  const a = normalize([question({ comments: comment("<p>Same body.</p>", "", "Person", "3 points") })]);
  const b = normalize([question({ comments: comment("<p>Same body.</p>", "", "Person", "4 points") })]);
  assert.equal(a.questions[0]!.id, b.questions[0]!.id);
  assert.equal(a.comments[0]!.id, b.comments[0]!.id);
  assert.notEqual(a.comments[0]!.sourceRevision, b.comments[0]!.sourceRevision);
  assert.notEqual(a.questions[0]!.sourceRevision, b.questions[0]!.sourceRevision);
  const c = normalize([question({ comments: comment("<p>Changed body.</p>", "", "Person", "3 points") })]);
  assert.notEqual(a.comments[0]!.id, c.comments[0]!.id);
});

test("missing replies, ambiguous headers, unexpanded controls and loading failures are contextual errors", () => {
  const mismatched = question({ comments: comment("<p>Root</p>", comment("<p>Reply</p>")) });
  mismatched.commentCount = 1;
  assert.throws(() => normalize([mismatched]), /page-001.json \/ Question 1: comment reconciliation failed: captured 1, DOM 2/);
  const missingBody = question();
  missingBody.html = missingBody.html.replace("<b>Reader</b>", "");
  assert.throws(() => normalize([missingBody]), /comment 0: author\/vote\/displayed-timestamp/);
  for (const raw of [
    { ...question(), remainingControls: ["Show Replies"] },
    { ...question(), loadingIndicators: 1 },
    { ...question(), discussionLoad: { status: "failed" as const, httpStatus: 500 } },
    { ...question(), answerRevealed: false },
    { ...question(), html: question().html.replace("<a>[-]</a>", "<a>[+]</a>") },
  ]) assert.throws(() => normalize([raw]), /Question 1/);
  const brokenTree = question();
  brokenTree.html = brokenTree.html.replace("<div><p>B is correct.</p></div><div></div>", "<div><p>B is correct.</p></div>");
  assert.throws(() => normalize([brokenTree]), /expected header\/body\/replies children, found 2/);
});

test("empty discussions require successful loading, never failed requests or empty-state placeholders", () => {
  const raw = question({ comments: "" });
  delete raw.discussionLoad;
  assert.throws(() => normalize([raw]), /zero comments without confirmed successful discussion loading/);
  raw.discussionLoad = { status: "loaded", httpStatus: 200 };
  const empty = normalize([raw]);
  assert.equal(empty.comments.length, 0);
  assert.equal(empty.occurrences[0]!.capture.discussionEvidence, "confirmed-empty");
  assert.equal(empty.questions[0]!.review.status, "pending");
  delete raw.discussionLoad;
  raw.html = raw.html.replace(/<div><\/div><\/div><\/div>$/, "<div>No comments yet.</div></div></div>");
  assert.throws(() => normalize([raw]), /zero comments without confirmed successful discussion loading/);
  raw.discussionLoad = { status: "rendered-only" };
  assert.throws(() => normalize([raw]), /zero comments without confirmed successful discussion loading/);
  raw.discussionLoad = { status: "failed", error: "ERR_NETWORK_CHANGED" };
  assert.throws(() => normalize([raw]), /discussion loading was failed:.*ERR_NETWORK_CHANGED/);
  raw.discussionLoad = { status: "loaded", httpStatus: 200 };
  assert.equal(normalize([raw]).occurrences[0]!.capture.discussionEvidence, "confirmed-empty");
  const nonempty = normalize([question({ discussionLoad: { status: "rendered-only" } })]);
  assert.equal(nonempty.occurrences[0]!.capture.discussionLoadStatus, "rendered-only");
});

test("question and answer images stay distinct by role, and image-only answers are honestly manual", () => {
  const fixture = imageQuestion();
  const dataset = normalize([fixture.question], fixture.assets);
  assert.equal(dataset.questions[0]!.kind, "manual");
  assert.equal(dataset.questions[0]!.conversion.status, "pending");
  assert.equal(dataset.questions[0]!.readiness.grading, "manual");
  assert.deepEqual(dataset.questions[0]!.options, []);
  assert.equal(dataset.assets.length, 2);
  assert.equal(dataset.comments.length, 1);
  assert.equal(dataset.answers[0]!.originalAnswers[0]!.value.kind, "manual");
  assert.equal(dataset.answers[0]!.effectiveAnswer.value.kind, "manual");
  assert.equal(dataset.answers[0]!.originalAnswers[0]!.provenance.evidence, "rendered-answer-image");
  assert.ok(plainText(dataset.answers[0]!.originalAnswers[0]!.explanation).includes("The author explains the source answer."));
  const promptIds = richAssetIds(dataset.questions[0]!.prompt);
  const answerIds = dataset.answers[0]!.originalAnswers[0]!.answerAssetIds;
  assert.equal(promptIds.length, 1);
  assert.equal(answerIds.length, 1);
  assert.notEqual(promptIds[0], answerIds[0]);
  assert.equal(dataset.assets.find((asset) => asset.id === promptIds[0])!.uses[0]!.role, "prompt");
  assert.equal(dataset.assets.find((asset) => asset.id === answerIds[0])!.uses[0]!.role, "answer");
  const same = imageQuestion(1, true);
  const deduped = normalize([same.question], same.assets);
  assert.equal(deduped.assets.length, 1);
  assert.deepEqual(deduped.assets[0]!.uses.map((use) => use.role), ["prompt", "answer"]);
  assert.equal(deduped.assets[0]!.sourceUrls.length, 2);
  assert.equal(deduped.assets[0]!.uses.length, 2);
});

test("comment image bytes and per-use roles are preserved without introducing remote rendering HTML", () => {
  const url = "https://images.example.test/comment.png";
  const raw = question({ comments: comment(`<p>Evidence:</p><img src="${url}" alt="Diagram">`), images: [image(url, "Diagram")] });
  const dataset = normalize([raw], [rawAsset(url)]);
  const use = dataset.assets[0]!.uses[0]!;
  assert.equal(use.role, "comment");
  assert.equal(use.commentId, dataset.comments[0]!.id);
  assert.deepEqual(richAssetIds(dataset.comments[0]!.body), [dataset.assets[0]!.id]);
  assert.equal(JSON.stringify(dataset.comments[0]!.body).includes(url), false);
});

test("media verification rejects invalid bytes and preserves honest provenance for mislabeled image MIME", () => {
  const url = "https://images.example.test/image.png";
  const valid = rawAsset(url);
  assert.deepEqual(inspectImage(png(20, 3, 2), "image/png; charset=binary", "image test"), {
    width: 3, height: 2, contentType: "image/png", extension: "png",
  });
  assert.equal(decodeCapturedAsset(valid, ".data/assets", "image test").metadata.id, sha256(png()));
  for (const bad of [
    { ...valid, base64: `${valid.base64}\n` },
    { ...valid, base64: valid.base64.slice(1) },
    { ...valid, byteLength: valid.byteLength + 1 },
    { ...valid, contentType: "image/svg+xml" },
  ]) assert.throws(() => decodeCapturedAsset(bad, ".data/assets", "bad image"), /bad image:/);
  assert.throws(() => inspectImage(png(), "image/jpeg", "wrong MIME"), /JPEG signature/);
  const mislabeled = decodeCapturedAsset({ ...valid, contentType: "image/jpeg" }, ".data/assets", "mislabeled image");
  assert.equal(mislabeled.metadata.contentType, "image/png");
  assert.equal(mislabeled.metadata.validation.mime, "corrected-from-signature");
  assert.deepEqual(mislabeled.metadata.sourceResponses, [{ url, declaredContentType: "image/jpeg" }]);
  assert.equal(mislabeled.metadata.sha256, sha256(png()));
  const corrupted = Buffer.from(png());
  corrupted[41] = corrupted[41]! ^ 1;
  assert.throws(() => inspectImage(corrupted, "image/png", "bad image"), /CRC mismatch/);
  assert.throws(() => inspectImage(png().subarray(0, 30), "image/png", "bad image"), /truncated PNG/);
  const fixture = imageQuestion();
  assert.throws(() => normalize([fixture.question], fixture.assets.slice(0, 1)), /missing captured bytes/);
  const wrongSize = structuredClone(fixture.question);
  wrongSize.images[0]!.width = 2;
  assert.throws(() => normalize([wrongSize], fixture.assets), /captured 2x1 but bytes are 1x1/);
  const unloaded = structuredClone(fixture.question);
  unloaded.images[0]!.loaded = false;
  assert.throws(() => normalize([unloaded], fixture.assets), /image 0 is not loaded/);
  assert.throws(() => normalize([fixture.question], [...fixture.assets, fixture.assets[0]!]), /duplicate captured asset URL/);
});

test("answer option IDs and completed conversion overlays are validated against their actual question", () => {
  const dataset = normalize([question()]);
  const other = normalize([question({ options: ["<p>Different first</p>", "<p>Different second</p>"] })]);
  assert.throws(() => assertAnswerOptionIds(dataset.questions[0]!, {
    kind: "option-selection", optionIds: [other.questions[0]!.options[0]!.id],
  }, "test key"), /does not belong/);
  const imageFixture = imageQuestion();
  const manual = normalize([imageFixture.question], imageFixture.assets);
  const q = manual.questions[0]!;
  const completed: ConversionOverlay = ConversionOverlaySchema.parse({
    schemaVersion: 1, questionId: q.id, basedOnSourceRevision: q.sourceRevision,
    status: "completed", converter: "Fixture transcriber", convertedAt: capturedAt,
    kind: "single-select", prompt: dataset.questions[0]!.prompt,
    options: dataset.questions[0]!.options,
    answer: dataset.answers[0]!.effectiveAnswer.value,
    sourceAssetIds: q.assetIds,
    notes: "Synthetic transcription preserves the original prompt and answer image references.",
  });
  assert.equal(validateConversionForQuestion(q, manual.answers[0]!, completed).status, "completed");
  assert.throws(() => validateConversionForQuestion(q, manual.answers[0]!, { ...completed, sourceAssetIds: [] }), /Too small|missing/);
  assert.throws(() => validateConversionForQuestion(q, manual.answers[0]!, {
    ...completed, basedOnSourceRevision: "f".repeat(64),
  }), /different question\/source revision/);
  assert.equal(ConversionOverlaySchema.safeParse({
    ...completed, answer: { kind: "option-selection", optionIds: [other.questions[0]!.options[0]!.id] },
  }).success, false);
  const assessed = review(manual);
  assert.equal(validateReviewForQuestion(q, manual.answers[0]!, manual.comments.map((c) => c.id), assessed).status, "completed");
  assert.throws(() => validateReviewForQuestion(q, manual.answers[0]!, manual.comments.map((c) => c.id), {
    ...assessed, answerDecision: { kind: "override", value: dataset.answers[0]!.effectiveAnswer.value, rationale: "Manual guess", evidence: [] },
  }), /does not belong/);
});

test("publication requires semantic assessment of every retained comment, not independent research of every key", () => {
  const dataset = normalize([question({ comments: comment("<p>Agree</p>", comment("<p>Reply agrees</p>")) })]);
  const assessed = review(dataset);
  const ids = dataset.comments.map((item) => item.id);
  assert.equal(validateReviewForQuestion(dataset.questions[0]!, dataset.answers[0]!, ids, assessed).answerDecision.kind, "retain-source");
  assert.throws(() => validateReviewForQuestion(dataset.questions[0]!, dataset.answers[0]!, ids, {
    ...assessed, commentAssessment: { ...assessed.commentAssessment, assessedCommentIds: ids.slice(0, 1) },
  }), /semantic comment assessment missing/);
  const q = QuestionSchema.parse({
    ...dataset.questions[0]!,
    review: { status: "completed", basedOnSourceRevision: dataset.questions[0]!.sourceRevision, reviewer: assessed.reviewer, reviewedAt: assessed.reviewedAt },
    readiness: { ...dataset.questions[0]!.readiness, publication: "ready" },
    published: true,
  });
  assert.equal(q.published, true);
  assert.equal(dataset.answers[0]!.effectiveAnswer.verification, "not-independently-verified");
  assert.throws(() => assertDocumentSize({ body: "x".repeat(800_000) }, "oversize comment"), /Firestore safety limit/);
});

test("coverage is explicit and incomplete overall captures differ from broken pages", () => {
  const five = Array.from({ length: 5 }, (_, index) => question({ number: index + 1, prompt: `<p>Unique question ${index + 1}.</p>` }));
  const partial = normalizeCaptures([captureInput(five)]);
  assert.equal(partial.manifest.coverage.complete, false);
  assert.equal(partial.manifest.coverage.actualPages, 1);
  assert.equal(partial.manifest.coverage.actualOccurrences, 5);
  assert.equal(partial.manifest.coverage.expectedPages, 122);
  assert.equal(partial.manifest.coverage.expectedOccurrences, 606);
  assert.deepEqual(partial.manifest.coverage.missingPages, Array.from({ length: 121 }, (_, i) => i + 2));
  assert.equal(partial.manifest.coverage.missingQuestionNumbers[0], 6);
  assert.equal(partial.manifest.coverage.missingQuestionNumbers.at(-1), 606);
  assert.throws(() => normalizeCaptures([captureInput(five.slice(0, 4))]), /expected questions 1–5/);
  assert.throws(() => normalizeCaptures([captureInput(five), captureInput(five)]), /duplicate captured page/);
  const mismatched = { ...captureInput(five), path: ".data/raw/pages/page-002.json" };
  assert.throws(() => normalizeCaptures([mismatched]), /does not match the numbered filename/);
  assert.throws(() => normalizeCaptures([{ path: ".data/raw/pages/page-001.json", content: "{" }]), /invalid capture JSON/);
  assert.throws(() => normalizeCaptures([{
    ...captureInput(five), content: captureInput(five).content.replace('"rendered-browser-ui"', '"source-api"'),
  }]), /capture schema validation failed/);
});

test("unpacking is idempotent and conflicting existing asset files are never overwritten", async () => {
  await withWorkspace(async (path) => {
    const assetDirectory = `${path}/assets`;
    const fixture = imageQuestion();
    const dataset = normalizeCaptures([captureInput([fixture.question], fixture.assets)], {
      assetDirectory, expected: { pages: 1, occurrences: 1, pageSize: 5 },
    });
    await dataset.assetRegistry.unpack(workspace, assetDirectory);
    const binaryPath = dataset.assets[0]!.filePath;
    const before = await stat(binaryPath);
    const bytes = await readFile(binaryPath);
    await dataset.assetRegistry.unpack(workspace, assetDirectory);
    assert.equal((await stat(binaryPath)).mtimeMs, before.mtimeMs);
    assert.deepEqual(await readFile(binaryPath), bytes);
    await writeFile(binaryPath, "conflicting bytes");
    await assert.rejects(dataset.assetRegistry.unpack(workspace, assetDirectory), /Conflicting existing asset.*left untouched/);
    assert.equal(await readFile(binaryPath, "utf8"), "conflicting bytes");
  });
});

test("normalization writes stable source files, preserves overlays and exposes review staleness after recapture", async () => {
  await withWorkspace(async (path) => {
    const expected = { pages: 1, occurrences: 1, pageSize: 5 };
    const inputDirectory = `${path}/raw`;
    const outputDirectory = `${path}/normalized`;
    const assetDirectory = `${path}/assets`;
    const reviewDirectory = `${path}/reviews`;
    const conversionDirectory = `${path}/conversions`;
    const options = { inputDirectory, outputDirectory, assetDirectory, reviewDirectory, conversionDirectory, expected };
    const raw = question();
    await persistInput(captureInput([raw], [], 1, inputDirectory));
    const first = await normalizeDirectory(options);
    const q = first.questions[0]!;
    const reviewPath = `${reviewDirectory}/${q.id}.json`;
    const conversionPath = `${conversionDirectory}/${q.id}.json`;
    await persist(reviewPath, review(first));
    await persist(conversionPath, { schemaVersion: 1, questionId: q.id, basedOnSourceRevision: q.sourceRevision, status: "pending", notes: "Fixture note, do not overwrite." });
    const reviewBefore = await readFile(reviewPath, "utf8");
    const conversionBefore = await readFile(conversionPath, "utf8");
    const manifestBefore = await stat(`${outputDirectory}/manifest.json`);
    const repeated = await normalizeDirectory(options);
    assert.deepEqual(repeated.manifest, first.manifest);
    assert.equal((await stat(`${outputDirectory}/manifest.json`)).mtimeMs, manifestBefore.mtimeMs);
    assert.equal(await readFile(reviewPath, "utf8"), reviewBefore);
    assert.equal(await readFile(conversionPath, "utf8"), conversionBefore);
    const audit = await auditDataset({ ...options, requireComplete: true, forPublication: true });
    assert.equal(audit.ok, true, JSON.stringify(audit.issues));
    assert.equal(audit.reviewStates.completed, 1);
    assert.equal(audit.records.comments, 1);
    const changed = question({ comments: comment("<p>B is correct.</p>", "", "Reader", "13 points") });
    await persistInput(captureInput([changed], [], 1, inputDirectory));
    const beforeRenormalize = await auditDataset(options);
    assert.equal(beforeRenormalize.ok, false);
    assert.ok(beforeRenormalize.issues.some((item) => item.code === "stale-source-revision"));
    const next = await normalizeDirectory(options);
    assert.equal(next.questions[0]!.id, q.id);
    assert.notEqual(next.questions[0]!.sourceRevision, q.sourceRevision);
    assert.equal(await readFile(reviewPath, "utf8"), reviewBefore);
    assert.equal(await readFile(conversionPath, "utf8"), conversionBefore);
    const stale = await auditDataset({ ...options, forPublication: true });
    assert.equal(stale.ok, false);
    assert.equal(stale.reviewStates.stale, 1);
    assert.equal(stale.conversionStates.stale, 1);
    assert.ok(stale.issues.some((item) => item.code === "stale-review-overlay"));
  });
});

test("normalization reads only the numbered pages directory, never archived failed revisions", async () => {
  await withWorkspace(async (path) => {
    const inputDirectory = `${path}/raw/pages`;
    const revisionDirectory = `${path}/raw/revisions`;
    const options = {
      inputDirectory, outputDirectory: `${path}/normalized`, assetDirectory: `${path}/assets`,
      expected: { pages: 1, occurrences: 1, pageSize: 5 },
    };
    await persistInput(captureInput([question()], [], 1, inputDirectory));
    const failed = question({ comments: "", discussionLoad: { status: "failed", error: "ERR_NETWORK_CHANGED" } });
    const archived = captureInput([failed], [], 1, revisionDirectory);
    await persistInput(archived);
    const dataset = await normalizeDirectory(options);
    assert.equal(dataset.manifest.rawPages.length, 1);
    assert.equal(dataset.manifest.rawPages[0]!.path, `${inputDirectory}/page-001.json`);
    assert.equal(dataset.comments.length, 1);
    assert.equal(await readFile(archived.path, "utf8"), archived.content);
  });
});

test("audit allows reviewed manual/source-default answers but detects missing media/comments and invalid keys", async () => {
  await withWorkspace(async (path) => {
    const inputDirectory = `${path}/raw`;
    const outputDirectory = `${path}/normalized`;
    const assetDirectory = `${path}/assets`;
    const reviewDirectory = `${path}/reviews`;
    const conversionDirectory = `${path}/conversions`;
    const options = {
      inputDirectory, outputDirectory, assetDirectory, reviewDirectory, conversionDirectory,
      expected: { pages: 1, occurrences: 1, pageSize: 5 },
    };
    const fixture = imageQuestion();
    await persistInput(captureInput([fixture.question], fixture.assets, 1, inputDirectory));
    const dataset = await normalizeDirectory(options);
    const pending = await auditDataset({ ...options, forPublication: true });
    assert.equal(pending.ok, false);
    assert.equal(pending.reviewStates.pending, 1);
    await persist(`${reviewDirectory}/${dataset.questions[0]!.id}.json`, review(dataset));
    const publishable = await auditDataset({ ...options, forPublication: true });
    assert.equal(publishable.ok, true, JSON.stringify(publishable.issues));
    assert.equal(publishable.conversionStates.pending, 1);
    await rm(`${outputDirectory}/comments/${dataset.comments[0]!.id}.json`);
    await writeFile(dataset.assets[0]!.filePath, "bad image bytes");
    const broken = await auditDataset(options);
    assert.equal(broken.ok, false);
    assert.ok(broken.issues.some((item) => item.code === "missing-source-records" && item.message.includes(dataset.comments[0]!.id)));
    assert.ok(broken.issues.some((item) => item.code === "comment-reconciliation"));
    assert.ok(broken.issues.some((item) => item.code === "asset-hash-mismatch"));
    const answerPath = `${outputDirectory}/answers/${dataset.answers[0]!.id}.json`;
    const badAnswer = { ...dataset.answers[0]!, effectiveAnswer: {
      ...dataset.answers[0]!.effectiveAnswer, value: { kind: "option-selection", optionIds: [`opt_${"a".repeat(64)}`] },
    } };
    await persist(answerPath, badAnswer);
    const invalidKey = await auditDataset(options);
    assert.ok(invalidKey.issues.some((item) => item.code === "invalid-effective-key"));
  });
});

test("normalization refuses reviewed source records, and CLI completeness gates stay explicit", async () => {
  await withWorkspace(async (path) => {
    const inputDirectory = `${path}/raw`;
    const outputDirectory = `${path}/normalized`;
    const assetDirectory = `${path}/assets`;
    const options = { inputDirectory, outputDirectory, assetDirectory };
    const questions = Array.from({ length: 5 }, (_, index) => question({ number: index + 1, prompt: `<p>Question with ${index + 1} machines.</p>` }));
    await persistInput(captureInput(questions, [], 1, inputDirectory));
    const dataset = await normalizeDirectory(options);
    const partial = await auditDataset({ ...options, reviewDirectory: `${path}/reviews`, conversionDirectory: `${path}/conversions` });
    assert.equal(partial.ok, true, JSON.stringify(partial.issues));
    assert.ok(partial.issues.some((item) => item.code === "incomplete-coverage" && item.severity === "warning"));
    await assert.rejects(normalizeDirectory({ ...options, requireComplete: true }), /missing pages \[2, 3/);
    const finalGate = await auditDataset({ ...options, requireComplete: true });
    assert.equal(finalGate.ok, false);
    assert.ok(finalGate.issues.some((item) => item.code === "incomplete-coverage" && item.severity === "error"));
    const q = dataset.questions[0]!;
    const pathToQuestion = `${outputDirectory}/questions/${q.id}.json`;
    const curation = { ...q, published: true, review: { status: "completed" } };
    await persist(pathToQuestion, curation);
    await assert.rejects(normalizeDirectory(options), /Refusing to overwrite reviewed\/published\/converted data/);
    assert.deepEqual(JSON.parse(await readFile(pathToQuestion, "utf8")), curation);
  });
  assert.deepEqual(parseNormalizeArgs(["--require-complete", "--input", "input", "--output", "output", "--assets", "assets"]), {
    requireComplete: true, inputDirectory: "input", outputDirectory: "output", assetDirectory: "assets",
  });
  assert.equal(parseAuditArgs(["--for-publication", "--require-complete"]).forPublication, true);
  assert.throws(() => parseNormalizeArgs(["--bad"]), /Unknown normalization argument/);
  assert.throws(() => parseAuditArgs(["--reviews"]), /requires a directory/);
});

const observedPaths = [1, 2, 3, 4].map((number) => `.data/raw/pages/page-${String(number).padStart(3, "0")}.json`);
test("observed pages 1–4 preserve actual border keys, explanations, full comment trees and original images", {
  skip: !observedPaths.every((path) => existsSync(path)) && "Private UI captures are not present in this checkout",
}, () => {
  const inputs = observedPaths.map((path) => ({ path, content: readFileSync(path, "utf8") }));
  const raw = inputs.map((input) => JSON.parse(input.content) as { questions: RawQuestion[]; assets?: RawAsset[] });
  const dataset = normalizeCaptures(inputs);
  assert.equal(dataset.manifest.coverage.actualPages, 4);
  assert.equal(dataset.manifest.coverage.actualOccurrences, 20);
  assert.equal(dataset.manifest.coverage.complete, false);
  assert.equal(dataset.questions.length, 20);
  assert.equal(dataset.comments.length, raw.flatMap((page) => page.questions).reduce((sum, item) => sum + item.commentCount, 0));
  assert.equal(dataset.assets.length, 4);
  const observedKeys = ["C", "B", "B", "B", "B", "A", "B", "C", "C", "D", "B", "B", null, "A", "B"];
  observedKeys.forEach((label, index) => {
    const occurrence = dataset.occurrences.find((item) => item.questionNumber === index + 1)!;
    const answer = dataset.answers.find((item) => item.id === occurrence.questionId)!;
    const original = answer.originalAnswers.find((item) => item.sourceOccurrenceId === occurrence.id)!;
    assert.deepEqual(original.sourceLabels, label ? [label] : []);
  });
  const source13 = dataset.occurrences.find((item) => item.questionNumber === 13)!;
  const q13 = dataset.questions.find((item) => item.id === source13.questionId)!;
  const answer13 = dataset.answers.find((item) => item.id === q13.id)!;
  assert.equal(q13.kind, "manual");
  assert.equal(q13.conversion.status, "pending");
  assert.equal(q13.options.length, 0);
  assert.equal(q13.readiness.grading, "manual");
  assert.equal(answer13.originalAnswers[0]!.answerAssetIds.length, 1);
  assert.equal(richAssetIds(q13.prompt).length, 1);
  assert.ok(plainText(answer13.originalAnswers[0]!.explanation).includes("retrieving the password that is stored in a Key Vault"));
  assert.ok(dataset.comments.some((item) => item.parentId !== null));
  assert.ok(dataset.questions.every((item) => item.review.status === "pending" && !item.published));
  assert.ok(dataset.answers.every((item) => !item.published));
  const expectedHashes = new Set(raw.flatMap((page) => page.assets ?? []).map((asset) => sha256(Buffer.from(asset.base64, "base64"))));
  assert.deepEqual(new Set(dataset.assets.map((asset) => asset.id)), expectedHashes);
  for (const occurrence of dataset.occurrences) {
    assert.equal(occurrence.commentIds.length, occurrence.capture.expectedCommentCount);
    assert.equal(dataset.comments.filter((item) => item.sourceOccurrenceId === occurrence.id).length, occurrence.capture.expectedCommentCount);
  }
  for (const collection of [dataset.questions, dataset.answers, dataset.comments, dataset.occurrences, dataset.assets]) {
    for (const record of collection) assertDocumentSize(record, record.id);
  }
  assert.equal(dataset.manifest.sourceRevision, digest({
    normalizerVersion: dataset.manifest.normalizerVersion, rawPages: dataset.manifest.rawPages,
  }));
});

const mislabeledPaths = [53, 107].map((number) => `.data/raw/pages/page-${String(number).padStart(3, "0")}.json`);
test("observed mislabeled JPEGs are verified offline, stored unchanged with JPEG MIME and explicitly reported", {
  skip: !mislabeledPaths.every((path) => existsSync(path)) && "Private captures with source MIME defects are not present",
}, () => {
  const inputs = mislabeledPaths.map((path) => ({ path, content: readFileSync(path, "utf8") }));
  const dataset = normalizeCaptures(inputs);
  const corrected = dataset.assets.filter((asset) => asset.validation.mime === "corrected-from-signature");
  assert.equal(corrected.length, 2);
  assert.equal(dataset.manifest.issues.filter((issue) => issue.code === "captured-mime-mismatch").length, 2);
  for (const asset of corrected) {
    assert.equal(asset.contentType, "image/jpeg");
    assert.equal(asset.extension, "jpg");
    assert.ok(asset.sourceResponses.some((response) => response.declaredContentType === "image/png"));
    const bytes = dataset.assetRegistry.assets.get(asset.id)!.bytes;
    assert.equal(bytes.subarray(0, 2).toString("hex"), "ffd8");
    assert.equal(sha256(bytes), asset.id);
    assert.deepEqual(inspectImage(bytes, asset.contentType, asset.id), {
      contentType: asset.contentType, extension: asset.extension, width: asset.width, height: asset.height,
    });
  }
});
