import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { load } from "cheerio";
import {
  Sc900DocumentSchema, Sc900DiscussionSchema, type Sc900Document,
} from "../src/domain/sc900Bank.js";
import { Sc900CaptureLedgerSchema } from "../src/domain/sc900Capture.js";
import {
  byteSha256, canonicalJson, sc900OptionId, sc900QuestionId, sc900SourceRevision,
} from "../tools/sc900/canonical.js";
import {
  normalizeSc900Captures, normalizeSc900Directory, parseSc900NormalizeArgs,
  Sc900NormalizationError, type Sc900CaptureInput, type Sc900NormalizationResult,
} from "../tools/sc900/normalize.js";
import { plainText, type RawAsset, type RawImage } from "../tools/ingest/normalize-shared.js";
import { type RichContent } from "../src/domain/schemas.js";

const capturedAt = "2026-09-22T08:00:00.000Z";
const green = "rgb(104, 211, 145)";
const white = "rgb(255, 255, 255)";
const htmlText = (html: string) => load(html, undefined, false).text();
interface FixtureQuestion {
  heading: string;
  html: string;
  renderedText: string;
  answerRevealed?: boolean;
  choiceStyles: { label: string; text: string; borderColor: string; borderWidth: string }[];
  commentCount: number;
  remainingControls: string[];
  loadingIndicators?: number;
  images: RawImage[];
  discussionLoad?: {
    status: "loaded" | "rendered-only" | "failed" | "not-requested" | "loading" | "receiving";
    httpStatus?: number;
    error?: string;
    reason?: string;
  };
}
interface QuestionFixture {
  number?: number;
  prompt?: string;
  options?: string[];
  selected?: string[];
  explanation?: string;
  comments?: string;
  images?: RawImage[];
}
function comment(body = "<p>Retain the source answer.</p>", replies = "", avatar = ""): string {
  return `<div><a>[-]</a><div><ul class="chakra-wrap__list"><div>${avatar}<b>Reader</b><b>12 points</b><span>about 2 years ago</span></div><div>${body}</div><div>${replies}</div></ul></div></div>`;
}
function question(fixture: QuestionFixture = {}): FixtureQuestion {
  const number = fixture.number ?? 1;
  const contents = fixture.options ?? ["<p>First content</p>", "<p>Second content</p>"];
  const selected = fixture.selected ?? ["B"];
  const labels = contents.map((_, index) => String.fromCharCode(65 + index));
  const html = `<div class="chakra-accordion__item"><button class="chakra-accordion__button">Question ${number}</button><div class="chakra-collapse"><div class="chakra-accordion__panel"><div><div>${fixture.prompt ?? "<p>Which service fits this requirement?</p>"}</div><div>${contents.map((content, index) => `<div class="chakra-stack"><div>${labels[index]}<!-- -->.</div><div>${content}</div></div>`).join("")}</div></div><div><button>Hide Answer</button></div>${fixture.explanation === undefined ? "" : `<div><b>Correct answer:</b>${fixture.explanation}</div>`}${fixture.comments ? `<div>${fixture.comments}</div>` : ""}</div></div></div>`;
  return {
    heading: `Question ${number}`, html, renderedText: htmlText(html), answerRevealed: true,
    choiceStyles: contents.map((content, index) => ({
      label: labels[index]!, text: htmlText(content), borderColor: selected.includes(labels[index]!) ? green : white, borderWidth: "2px",
    })),
    commentCount: load(html)("ul.chakra-wrap__list").length,
    remainingControls: [], loadingIndicators: 0, images: fixture.images ?? [],
    discussionLoad: { status: "loaded", httpStatus: 200 },
  };
}
function input(questions: FixtureQuestion[], assets: RawAsset[] = [], page = 1): Sc900CaptureInput {
  return {
    path: `.data/sc900/raw/pages/page-${String(page).padStart(3, "0")}.json`,
    content: JSON.stringify({
      captureVersion: 1, method: "rendered-browser-ui", examId: 128,
      url: `https://www.examprepper.co/exam/128/${page}`,
      title: `SC-900 - Page ${page}`, capturedAt, questions, assets,
    }),
  };
}
function normalize(questions: FixtureQuestion[], assets: RawAsset[] = [], draft = false): Sc900NormalizationResult {
  return normalizeSc900Captures([input(questions, assets)], {
    expected: { pages: 1, occurrences: questions.length }, draft,
  });
}
function doc(result: Sc900NormalizationResult, sourceNumber = 1): Sc900Document {
  const value = result.draftDocuments.find((item) => item.question.sources.some((source) => source.questionNumber === sourceNumber));
  assert.ok(value);
  return value;
}
function assertBlocked(result: Sc900NormalizationResult, code: string): void {
  assert.equal(result.verifiedCaptureLedger, null);
  assert.ok(result.issues.some((issue) => issue.code === code && issue.severity === "error"),
    `${code} missing: ${JSON.stringify(result.issues)}`);
  assert.ok(result.draftDocuments.every((document) => document.answers.provisional));
  assert.equal(result.publicationState, "blocked-independent-review");
}
function png(red = 20): Buffer {
  const crc32 = (bytes: Buffer): number => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (name: string, bytes: Buffer) => {
    const data = Buffer.concat([Buffer.from(name), bytes]);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(bytes.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(data));
    return Buffer.concat([size, data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from([0, red, 40, 60, 255]))), chunk("IEND", Buffer.alloc(0)),
  ]);
}
function asset(url: string, red = 20): RawAsset {
  const bytes = png(red);
  return { url, contentType: "image/png", byteLength: bytes.length, base64: bytes.toString("base64") };
}
function image(url: string, alt = ""): RawImage {
  return { src: url, currentSrc: url, alt, width: 1, height: 1, loaded: true };
}
const promptUrl = "https://images.example.test/prompt.png";
const answerUrl = "https://images.example.test/answer.png";
function manual(number = 1): { raw: FixtureQuestion; assets: RawAsset[] } {
  return {
    raw: question({
      number, prompt: `<p>HOTSPOT -</p><img src="${promptUrl}" alt="Question">`,
      options: [], selected: [], explanation: `<img src="${answerUrl}" alt="">`,
      images: [image(promptUrl, "Question"), image(answerUrl)],
    }),
    assets: [asset(promptUrl), asset(answerUrl, 90)],
  };
}

test("complete five-question capture preserves originals, safe duplicate permutations, manual images and threads", () => {
  const manualFixture = manual(2);
  const commentUrl = "https://images.example.test/comment.png";
  const thread = comment(`<p>Root</p><img src="${commentUrl}" alt="Evidence">`,
    comment("<p>Reply</p>", comment("<p>Grandchild</p>"))) + comment("<p>Second root</p>");
  const questions = [
    question({ comments: thread, images: [image(commentUrl, "Evidence")], explanation: "<p>Original explanation.</p>" }),
    manualFixture.raw,
    question({ number: 3, prompt: "<p>Choose two keys.</p>", options: ["<p>Alpha</p>", "<p>Beta</p>", "<p>Gamma</p>"], selected: ["A", "C"] }),
    question({ number: 4, options: ["<p>Second content</p>", "<p>First content</p>"], selected: ["A"], comments: comment("<p>Duplicate occurrence discussion.</p>"), explanation: "<p>Another source explanation.</p>" }),
    question({ number: 5, prompt: "<p>Arrange the choices in the correct order.</p>" }),
  ];
  const result = normalize(questions, [...manualFixture.assets, asset(commentUrl, 70)]);
  assert.deepEqual(result.counts, {
    observedPages: 1, observedOccurrences: 5, normalizedOccurrences: 5,
    canonicalQuestions: 4, duplicatesGrouped: 1, parsedComments: 5, confirmedComments: 5,
  });
  assert.equal(result.issues.length, 0);
  assert.ok(result.verifiedCaptureLedger);
  Sc900CaptureLedgerSchema.parse(result.verifiedCaptureLedger);
  assert.equal(result.verifiedCaptureLedger.occurrences.length, 5);
  assert.equal(result.verifiedCaptureLedger.assets.length, 3);
  assert.equal(result.draftSourceRevision, sc900SourceRevision(result.verifiedCaptureLedger));
  const first = doc(result);
  assert.equal(first.question.shuffle.allowed, true);
  assert.equal(first.answers.originalAnswers.length, 2);
  assert.deepEqual(first.answers.originalAnswers.map((answer) => plainText(answer.explanation)),
    ["Original explanation.", "Another source explanation."]);
  assert.deepEqual(first.question.sources.map((source) => source.questionNumber), [1, 4]);
  assert.equal(result.draftOccurrences[0]!.sourceLabelToOptionId.B, result.draftOccurrences[3]!.sourceLabelToOptionId.A);
  assert.deepEqual(result.draftOccurrences[0]!.selectedSourceLabels, ["B"]);
  assert.deepEqual(result.draftOccurrences[3]!.selectedSourceLabels, ["A"]);
  assert.equal(doc(result, 2).question.kind, "manual");
  assert.equal(doc(result, 2).question.readiness.grading, "manual");
  assert.equal(doc(result, 2).question.shuffle.allowed, false);
  assert.equal(doc(result, 2).answers.originalAnswers[0]!.answerAssetIds[0], byteSha256(png(90)));
  assert.equal(doc(result, 3).question.kind, "multi-select");
  assert.equal(doc(result, 5).question.shuffle.allowed, false);
  for (const document of result.draftDocuments) {
    Sc900DocumentSchema.parse(document);
    assert.equal(document.question.id, sc900QuestionId(document.question));
    assert.equal(document.answers.provisional, true);
    assert.equal(document.examId, "sc900");
    assert.equal(document.question.examId, "sc900");
    assert.equal(document.answers.examId, "sc900");
    for (const option of document.question.options) assert.equal(option.id, sc900OptionId(option.content));
  }
  for (const discussion of result.draftDiscussions) Sc900DiscussionSchema.parse(discussion);
  const discussion = result.draftDiscussions.find((item) => item.questionId === first.question.id)!;
  const [root, reply, grandchild, otherRoot, duplicateRoot] = discussion.comments;
  assert.ok(root && reply && grandchild && otherRoot && duplicateRoot);
  assert.equal(root.parentId, null);
  assert.equal(reply.parentId, root.id);
  assert.equal(grandchild.rootId, root.id);
  assert.deepEqual(root.childIds, [reply.id]);
  assert.deepEqual(reply.childIds, [grandchild.id]);
  assert.equal(otherRoot.rootId, otherRoot.id);
  assert.notEqual(duplicateRoot.sourceOccurrenceId, root.sourceOccurrenceId);
  assert.equal(new Set(discussion.comments.map((item) => item.id)).size, 5);
  assert.ok(discussion.comments.every((item) => item.examId === "sc900" && item.sourceOccurrenceId.startsWith("examprepper-128-")));
  assert.ok(!JSON.stringify(result).includes("examprepper-45"));
  assert.deepEqual(result, normalize(questions, [...manualFixture.assets, asset(commentUrl, 70)]));
});

test("confirmed HTTP 200 empty discussions and absent explanations are complete acquisition", () => {
  const result = normalize([question()]);
  assert.ok(result.verifiedCaptureLedger);
  assert.equal(result.counts.confirmedComments, 0);
  assert.equal(result.draftOccurrences[0]!.discussionVerified, true);
  assert.equal(result.draftOccurrences[0]!.confirmedCommentCount, 0);
  assert.deepEqual(doc(result).answers.originalAnswers[0]!.explanation, []);
  assert.equal(doc(result).discussionEnabled, false);
  assert.equal(doc(result).answers.provisional, true);
});

test("429, no response, timeout, and unrequested empty discussions remain unknown", () => {
  const states: (FixtureQuestion["discussionLoad"])[] = [
    { status: "failed", httpStatus: 429, reason: "Browser verification challenge" },
    { status: "failed", error: "timeout" }, { status: "not-requested" },
    { status: "loaded" }, { status: "loaded", httpStatus: 500 },
    { status: "loaded", httpStatus: 200, error: "partial response" },
    { status: "rendered-only", httpStatus: 200 }, { status: "loading" },
    { status: "receiving", httpStatus: 200 }, undefined,
  ];
  for (const state of states) {
    const raw = question();
    if (state) raw.discussionLoad = state; else delete raw.discussionLoad;
    const result = normalize([raw], [], true);
    assertBlocked(result, "discussion-unverified");
    assert.equal(result.draftOccurrences.length, 1);
    assert.equal(result.draftOccurrences[0]!.parsedCommentCount, 0);
    assert.equal(result.draftOccurrences[0]!.confirmedCommentCount, null);
    assert.equal(result.counts.confirmedComments, null);
    assert.equal(result.draftDocuments.length, 1);
    assert.throws(() => normalize([raw]), (error) =>
      error instanceof Sc900NormalizationError && error.result.verifiedCaptureLedger === null);
  }
});

test("pilot-shaped incomplete capture keeps all five occurrences and makes unrevealed keys explicit", () => {
  const first = manual();
  const third = manual(3);
  const fourth = manual(4);
  third.raw.html = third.raw.html.replace(answerUrl, `${answerUrl}?third`);
  third.raw.images[1] = image(`${answerUrl}?third`);
  fourth.raw.html = fourth.raw.html.replace(answerUrl, `${answerUrl}?fourth`);
  fourth.raw.images[1] = image(`${answerUrl}?fourth`);
  const questions = [first.raw, question({ number: 2 }), third.raw, fourth.raw,
    question({ number: 5, prompt: "<p>Which two tasks apply? Each correct answer presents a solution.</p>" })];
  for (const raw of questions.slice(0, 2)) raw.discussionLoad = { status: "failed", httpStatus: 429 };
  for (const raw of questions.slice(2)) {
    raw.answerRevealed = false;
    raw.html = raw.html.replace("Hide Answer", "Show Answer");
    raw.remainingControls = ["Show Answer"];
    raw.discussionLoad = { status: "not-requested" };
  }
  const capture = input(questions, [...first.assets, asset(`${answerUrl}?third`, 90), asset(`${answerUrl}?fourth`, 90)]);
  const json: Record<string, unknown> = JSON.parse(capture.content);
  json.completion = { status: "incomplete" };
  capture.content = JSON.stringify(json);
  const result = normalizeSc900Captures([capture], { draft: true });
  assertBlocked(result, "capture-incomplete");
  assertBlocked(result, "unobserved-totals");
  assert.equal(result.draftOccurrences.length, 5);
  assert.equal(result.counts.normalizedOccurrences, 5);
  assert.equal(result.draftOccurrences.filter((item) => item.answerRevealed).length, 2);
  assert.equal(result.counts.confirmedComments, null);
  for (const number of [3, 4, 5]) {
    const answer = doc(result, number).answers.originalAnswers.find((item) => item.sourceOccurrenceId.endsWith(String(number).padStart(6, "0")))!;
    assert.deepEqual(answer.value.kind, "manual");
    assert.equal(answer.value.kind === "manual" && answer.value.reason, "no-readable-key");
  }
});

test("answer evidence requires both the explicit flag and actual Hide Answer control", () => {
  for (const variation of ["flag-false", "flag-missing", "show-control", "two-hide-controls"]) {
    const raw = question();
    if (variation === "flag-false") raw.answerRevealed = false;
    if (variation === "flag-missing") delete raw.answerRevealed;
    if (variation === "show-control") raw.html = raw.html.replace("Hide Answer", "Show Answer");
    if (variation === "two-hide-controls") raw.html = raw.html.replace("Hide Answer</button>", "Hide Answer</button><button>Hide Answer</button>");
    const result = normalize([raw], [], true);
    assertBlocked(result, variation === "two-hide-controls" ? "question-layout" : "answer-not-revealed");
    assert.equal(result.draftOccurrences[0]!.answerEvidence, "unreadable");
  }
});

test("visible loading indicators or unexpanded reply controls block a success-shaped response", () => {
  for (const variation of ["raw-spinner", "dom-spinner", "raw-control", "dom-control"]) {
    const raw = question({ comments: comment() });
    if (variation === "raw-spinner") raw.loadingIndicators = 1;
    if (variation === "dom-spinner") raw.html = raw.html.replace("<b>Reader", '<span class="chakra-spinner"></span><b>Reader');
    if (variation === "raw-control") raw.remainingControls = ["Show replies"];
    if (variation === "dom-control") raw.html = raw.html.replace("<a>[-]</a>", "<a>Show replies</a>");
    const result = normalize([raw], [], true);
    assertBlocked(result, variation.endsWith("spinner") ? "content-loading" : "unexpanded-controls");
    assert.equal(result.counts.confirmedComments, null);
  }
});

test("unknown border styles, invisible green borders and missing keys never invent selections", () => {
  for (const variation of ["color", "width", "transparent", "no-green"]) {
    const raw = question();
    if (variation === "color") raw.choiceStyles[0]!.borderColor = "rgb(10, 20, 30)";
    if (variation === "width") raw.choiceStyles[1]!.borderWidth = "0px";
    if (variation === "transparent") raw.choiceStyles[1]!.borderColor = "rgba(104, 211, 145, 0)";
    if (variation === "no-green") raw.choiceStyles[1]!.borderColor = white;
    const result = normalize([raw], [], true);
    assertBlocked(result, variation === "no-green" ? "no-readable-key" : "unknown-answer-style");
    assert.equal(doc(result).answers.originalAnswers[0]!.value.kind, "manual");
    assert.equal(doc(result).question.readiness.grading, "manual");
  }
});

test("manual answer images remain manual evidence rather than inferred options", () => {
  const fixture = manual();
  const result = normalize([fixture.raw], fixture.assets);
  const document = doc(result);
  assert.equal(document.answers.effectiveAnswer.value.kind, "manual");
  assert.equal(result.draftOccurrences[0]!.answerEvidence, "marked-manual-answer");
  assert.equal(result.verifiedCaptureLedger!.occurrences[0]!.assetIds.length, 2);
  const noMarker = structuredClone(fixture.raw);
  noMarker.html = noMarker.html.replace("<b>Correct answer:</b>", "");
  assertBlocked(normalize([noMarker], fixture.assets, true), "unknown-answer-section");
});

test("exact duplicate conflicts keep all original keys and disable effective automatic grading", () => {
  const result = normalize([
    question({ selected: ["A"], explanation: "<p>Author chose the first.</p>" }),
    question({ number: 2, selected: ["B"], explanation: "<p>Author chose the second.</p>" }),
  ]);
  assert.equal(result.draftDocuments.length, 1);
  assert.equal(doc(result).answers.originalAnswers.length, 2);
  const effective = doc(result).answers.effectiveAnswer.value;
  assert.equal(effective.kind, "manual");
  assert.equal(effective.kind === "manual" && effective.reason, "conflicting-source-keys");
  assert.ok(result.verifiedCaptureLedger);
  assert.ok(result.issues.some((issue) => issue.code === "conflicting-source-keys"));
});

test("label-relative, ordering and manual questions preserve order and cannot be shuffled", () => {
  for (const prompt of ["Choose option A.", "Which is the first answer?", "Place the choices in the correct order.", "DRAG DROP - Arrange these."]) {
    const result = normalize([
      question({ prompt: `<p>${prompt}</p>` }),
      question({ number: 2, prompt: `<p>${prompt}</p>`, options: ["<p>Second content</p>", "<p>First content</p>"], selected: ["A"] }),
    ]);
    assert.equal(result.draftDocuments.length, 2);
    assert.ok(result.draftDocuments.every((document) => !document.question.shuffle.allowed));
    assert.deepEqual(doc(result).question.fixedOptionOrder, doc(result).question.options.map((option) => option.id));
  }
  const relative = normalize([question({ options: ["<p>Only the first setting</p>", "<p>All of the above</p>"] })]);
  assert.equal(doc(relative).question.shuffle.allowed, false);
});

test("parenthesized option references preserve order and prevent semantically different duplicate merges", () => {
  for (const reference of ["(A) and (B)", "( A ) and ( B )"]) {
    const contents = ["<p>Alpha</p>", "<p>Beta</p>", "<p>Gamma</p>", `<p>${reference}</p>`];
    const reordered = [contents[2]!, contents[1]!, contents[0]!, contents[3]!];
    const result = normalize([
      question({ options: contents, selected: ["D"] }),
      question({ number: 2, options: reordered, selected: ["D"] }),
    ]);
    assert.equal(result.draftDocuments.length, 2);
    assert.equal(result.counts.duplicatesGrouped, 0);
    assert.ok(result.verifiedCaptureLedger);
    for (const number of [1, 2]) {
      const document = doc(result, number);
      const occurrence = result.draftOccurrences[number - 1]!;
      assert.equal(document.question.shuffle.allowed, false);
      assert.deepEqual(document.question.options.map((option) => option.id), occurrence.fixedOptionOrder);
      assert.deepEqual(document.question.options.map((option) => plainText(option.content)),
        number === 1 ? ["Alpha", "Beta", "Gamma", reference] : ["Gamma", "Beta", "Alpha", reference]);
      assert.deepEqual(document.answers.originalAnswers[0]!.value, {
        kind: "option-selection", optionIds: [occurrence.sourceLabelToOptionId.D],
      });
      assert.equal(document.question.id, sc900QuestionId(document.question));
    }
    assert.notEqual(doc(result, 1).question.id, doc(result, 2).question.id);
  }
  const promptReference = normalize([question({ prompt: "<p>Evaluate (A) and (B).</p>" })]);
  assert.equal(doc(promptReference).question.shuffle.allowed, false);
});

test("ordinary nonlabel parentheses retain safe shuffling and exact permutation merging", () => {
  const result = normalize([
    question({
      prompt: "<p>Choose a deployment (for production).</p>",
      options: ["<p>Alpha (cloud)</p>", "<p>Beta (on-premises)</p>"], selected: ["B"],
    }),
    question({
      number: 2, prompt: "<p>Choose a deployment (for production).</p>",
      options: ["<p>Beta (on-premises)</p>", "<p>Alpha (cloud)</p>"], selected: ["A"],
    }),
  ]);
  assert.equal(result.draftDocuments.length, 1);
  assert.equal(result.counts.duplicatesGrouped, 1);
  assert.equal(doc(result).question.shuffle.allowed, true);
  assert.deepEqual(doc(result).answers.originalAnswers[0]!.value, doc(result).answers.originalAnswers[1]!.value);
  assert.ok(result.verifiedCaptureLedger);
});

test("IDs ignore source letters for safe permutations but retain prompt values, case and code whitespace", () => {
  const first = normalize([question()]);
  const reversed = normalize([question({ options: ["<p>Second content</p>", "<p>First content</p>"], selected: ["A"] })]);
  assert.equal(doc(first).question.id, doc(reversed).question.id);
  assert.deepEqual(doc(first).answers.originalAnswers[0]!.value, doc(reversed).answers.originalAnswers[0]!.value);
  const changed = normalize([
    question({ prompt: "<p>Threshold 10</p>" }),
    question({ number: 2, prompt: "<p>Threshold 100</p>" }),
    question({ number: 3, prompt: "<p>threshold 10</p>" }),
    question({ number: 4, prompt: "<pre><code>a  b</code></pre>" }),
    question({ number: 5, prompt: "<pre><code>a b</code></pre>" }),
  ]);
  assert.equal(changed.draftDocuments.length, 5);
});

test("identical option content is blocked rather than assigned ambiguous or fabricated IDs", () => {
  const result = normalize([question({ options: ["<p>Same</p>", "<p>Same</p>"] })], [], true);
  assertBlocked(result, "ambiguous-options");
  assert.equal(result.draftDocuments.length, 0);
  assert.equal(result.draftOccurrences.length, 1);
});

test("original image bytes bind identity, URL provenance, MIME, lengths and decoded dimensions", () => {
  const fixture = manual();
  const result = normalize([fixture.raw], fixture.assets);
  for (const record of result.draftAssets) {
    assert.equal(record.id, byteSha256(Buffer.from(record.base64, "base64")));
    assert.ok(record.sourceUrls.length);
    assert.equal(record.byteLength, Buffer.from(record.base64, "base64").length);
    assert.equal(record.examId, "sc900");
  }
  const variants = ["mime", "length", "base64", "corrupt", "dimensions", "missing", "source", "alt", "unloaded", "unsafe-src"] as const;
  for (const variation of variants) {
    const raw = structuredClone(fixture.raw);
    const assets = structuredClone(fixture.assets);
    if (variation === "mime") assets[0]!.contentType = "image/jpeg";
    if (variation === "length") assets[0]!.byteLength++;
    if (variation === "base64") assets[0]!.base64 += " ";
    if (variation === "corrupt") {
      const bytes = Buffer.from(assets[0]!.base64, "base64");
      bytes[35] = bytes[35]! ^ 0xff;
      assets[0]!.base64 = bytes.toString("base64");
    }
    if (variation === "dimensions") raw.images[0]!.width = 2;
    if (variation === "missing") assets.shift();
    if (variation === "source") raw.images[0]!.currentSrc = answerUrl;
    if (variation === "alt") raw.images[0]!.alt = "Not the DOM alt";
    if (variation === "unloaded") raw.images[0]!.loaded = false;
    if (variation === "unsafe-src") raw.html = raw.html.replace(promptUrl, "javascript:alert(1)");
    const blocked = normalize([raw], assets, true);
    assert.equal(blocked.verifiedCaptureLedger, null, variation);
    assert.equal(blocked.draftOccurrences.length, 1, variation);
    assert.equal(blocked.draftDocuments.length, 0, variation);
    assert.ok(blocked.issues.some((issue) => issue.severity === "error"), variation);
  }
});

test("prompt image changes prevent duplicate merging while byte-identical media aggregate source URLs", () => {
  const secondPrompt = "https://images.example.test/second-prompt.png";
  const first = manual();
  const second = manual(2);
  second.raw.html = second.raw.html.replace(promptUrl, secondPrompt);
  second.raw.images[0] = image(secondPrompt, "Question");
  const same = normalize([first.raw, second.raw], [...first.assets, asset(secondPrompt)]);
  assert.equal(same.draftDocuments.length, 1);
  assert.deepEqual(same.draftAssets.find((entry) => entry.id === byteSha256(png()))!.sourceUrls, [promptUrl, secondPrompt].sort());
  const different = normalize([first.raw, second.raw], [...first.assets, asset(secondPrompt, 33)]);
  assert.equal(different.draftDocuments.length, 2);
});

test("only recognized comment-header avatars are skipped and excluded from content inventory", () => {
  const avatarUrl = "https://images.example.test/avatar.png";
  const avatar = `<span class="chakra-avatar"><img class="chakra-avatar__img" src="${avatarUrl}" alt="Reader"></span>`;
  const raw = question({ comments: comment("<p>Body.</p>", "", avatar), images: [{ ...image(avatarUrl, "Reader"), loaded: false, width: 0 }] });
  const result = normalize([raw]);
  assert.ok(result.verifiedCaptureLedger);
  assert.equal(result.draftOccurrences[0]!.skippedAvatarCount, 1);
  assert.deepEqual(result.draftAssets, []);
  assert.deepEqual(result.verifiedCaptureLedger.assets, []);
  assert.deepEqual(result.verifiedCaptureLedger.occurrences[0]!.assetIds, []);
  const bodyAvatar = question({ comments: comment(avatar), images: [image(avatarUrl, "Reader")] });
  assertBlocked(normalize([bodyAvatar], [], true), "missing-image");
});

test("safe rich blocks remove active elements and unsafe URL schemes while preserving tables and code", () => {
  const prompt = `<p onclick="evil()">Safe <a href="javascript:evil()">text</a><a href="/help">help</a></p><script>evil()</script><iframe src="https://bad.example.test"></iframe><style>p{color:red}</style><table><caption>Caption</caption><tr><th rowspan="2">Header</th><td>Cell <code>x</code></td></tr><tr><td>Next</td></tr></table><pre><code class="language-text">a  b\n  c</code></pre>`;
  const result = normalize([question({ prompt })]);
  const blocks = doc(result).question.prompt;
  const serialized = JSON.stringify(blocks);
  assert.ok(!serialized.includes("evil"));
  assert.ok(!serialized.includes("iframe"));
  assert.ok(!serialized.includes("onclick"));
  assert.ok(!serialized.includes("javascript"));
  const table = blocks.find((block) => block.type === "table");
  assert.equal(table?.type === "table" && table.rows[0]!.cells[0]!.rowSpan, 2);
  const code = blocks.find((block) => block.type === "code");
  assert.equal(code?.type === "code" && code.code, "a  b\n  c");
  assert.ok(serialized.includes("https://www.examprepper.co/help"));
  assert.ok(result.issues.some((issue) => issue.code === "removed-active-content"));
  assert.ok(result.issues.some((issue) => issue.code === "removed-unsafe-link"));
});

test("unsupported visible content and style text mismatches fail visibly without partial documents", () => {
  const unsupported = question({ prompt: '<svg><text>Important answer image</text></svg>' });
  assertBlocked(normalize([unsupported], [], true), "unsupported-rich-content");
  const mismatch = question();
  mismatch.choiceStyles[0]!.text = "Different content";
  assertBlocked(normalize([mismatch], [], true), "choice-style-text");
});

test("unconsumed bare prompt or answer text in the panel blocks verification instead of being discarded", () => {
  for (const location of ["before-prompt", "before-controls", "after-controls", "after-explanation"]) {
    const raw = question({ explanation: "<p>Marked author explanation.</p>" });
    if (location === "before-prompt") {
      raw.html = raw.html.replace('class="chakra-accordion__panel">', 'class="chakra-accordion__panel">Bare prompt condition.');
    } else if (location === "before-controls") {
      raw.html = raw.html.replace("<div><button>Hide Answer", "Additional prompt requirement.<div><button>Hide Answer");
    } else if (location === "after-controls") {
      raw.html = raw.html.replace("Hide Answer</button></div>", "Hide Answer</button></div>Bare source explanation.");
    } else {
      raw.html = raw.html.replace("Marked author explanation.</p></div>", "Marked author explanation.</p></div>Additional source explanation.");
    }
    raw.renderedText = htmlText(raw.html);
    const result = normalize([raw], [], true);
    assertBlocked(result, "unparsed-panel-content");
    assert.equal(result.draftOccurrences.length, 1);
    assert.equal(result.draftDocuments.length, 0);
    assert.throws(() => normalize([raw]), Sc900NormalizationError);
  }
});

test("benign panel whitespace is ignored while bare text inside known prompt and answer sections is preserved", () => {
  const raw = question({ prompt: "Bare prompt within its section.", explanation: "Bare marked answer explanation." });
  raw.html = raw.html
    .replace('class="chakra-accordion__panel">', 'class="chakra-accordion__panel">\n \t')
    .replace("<div><button>Hide Answer", "\n&nbsp; <div><button>Hide Answer")
    .replace("Hide Answer</button></div>", "Hide Answer</button></div>\n\t ")
    .replace("Bare marked answer explanation.</div>", "Bare marked answer explanation.</div>\n ");
  raw.renderedText = htmlText(raw.html);
  const result = normalize([raw]);
  assert.ok(result.verifiedCaptureLedger);
  assert.equal(result.issues.length, 0);
  assert.equal(plainText(doc(result).question.prompt), "Bare prompt within its section.");
  assert.equal(plainText(doc(result).answers.originalAnswers[0]!.explanation), "Bare marked answer explanation.");
});

test("comment counts, ancestry and unparsed reply text cannot silently lose threads", () => {
  for (const variation of ["count", "body-thread", "reply-text", "header", "unknown-discussion"]) {
    const raw = question({ comments: comment("<p>Root</p>", comment("<p>Reply</p>")) });
    if (variation === "count") raw.commentCount = 1;
    if (variation === "body-thread") {
      raw.html = raw.html.replace("<p>Root</p>", comment("<p>Misnested</p>"));
      raw.commentCount++;
    }
    if (variation === "reply-text") raw.html = raw.html.replace("<p>Reply</p></div><div></div>", "<p>Reply</p></div><div>Unparsed child text</div>");
    if (variation === "header") raw.html = raw.html.replace("12 points", "many points");
    if (variation === "unknown-discussion") {
      raw.html = raw.html.replaceAll('class="chakra-wrap__list"', 'class="unknown-comment"');
      raw.commentCount = 0;
    }
    const result = normalize([raw], [], true);
    assert.equal(result.verifiedCaptureLedger, null, variation);
    assert.equal(result.draftDocuments.length, 0, variation);
    assert.deepEqual(result.draftDiscussions, [], variation);
    assert.equal(result.draftOccurrences[0]!.confirmedCommentCount, null, variation);
    assert.ok(result.issues.some((issue) => issue.severity === "error"), variation);
  }
});

test("source-answer marker words inside comments remain scoped to the discussion", () => {
  const result = normalize([question({
    comments: comment("<b>Correct answer:</b><p>The comment author's interpretation, not the site key.</p>"),
    explanation: "<p>The actual site explanation.</p>",
  })]);
  assert.ok(result.verifiedCaptureLedger);
  assert.equal(result.draftDiscussions[0]!.comments.length, 1);
  assert.match(result.draftDiscussions[0]!.comments[0]!.bodyText, /Correct answer:/);
  assert.equal(plainText(doc(result).answers.originalAnswers[0]!.explanation), "The actual site explanation.");
});

test("all source totals and sequential pages must reconcile, independent of file count", () => {
  const first = input(Array.from({ length: 5 }, (_, index) => question({ number: index + 1 })));
  const second = input([question({ number: 6 }), question({ number: 7 })], [], 2);
  const options = { expected: { pages: 2, occurrences: 7 } };
  const result = normalizeSc900Captures([second, first], options);
  assert.ok(result.verifiedCaptureLedger);
  assert.deepEqual(result, normalizeSc900Captures([first, second], options));
  assert.equal(result.counts.observedOccurrences, 7);
  assert.equal(result.counts.duplicatesGrouped, 6);
  assertBlocked(normalizeSc900Captures([first], { ...options, draft: true }), "incomplete-coverage");
  assertBlocked(normalizeSc900Captures([first, second], { draft: true }), "unobserved-totals");
  assertBlocked(normalizeSc900Captures([first, first, second], { ...options, draft: true }), "duplicate-page");
  assertBlocked(normalize([question({ number: 2 })], [], true), "page-sequence");
  assert.throws(() => normalizeSc900Captures([first], { expected: { pages: 2, occurrences: 5 } }), /five-question/);
});

test("wrong exam URLs, filenames and repeated source occurrences never become a verified ledger", () => {
  const captured = input([question()]);
  const badExam = { ...captured, content: captured.content.replace("/exam/128/", "/exam/45/") };
  assertBlocked(normalizeSc900Captures([badExam], { draft: true }), "source-url");
  const wrongFilename = { ...captured, path: ".data/sc900/raw/pages/page-002.json" };
  assertBlocked(normalizeSc900Captures([wrongFilename], { draft: true }), "page-filename");
  assertBlocked(normalize([question(), question()], [], true), "duplicate-occurrence");
  assertBlocked(normalizeSc900Captures([], { draft: true }), "empty-input");
  assertBlocked(normalizeSc900Captures([{ path: captured.path, content: "{" }], { draft: true }), "invalid-json");
});

test("stable draft hashes distinguish partial source revisions and never substitute a verified source hash", () => {
  const first = question();
  first.discussionLoad = { status: "failed", httpStatus: 429 };
  const result = normalize([first], [], true);
  assert.match(result.draftReleaseId, /^r_[0-9a-f]{64}$/);
  assert.match(result.draftSourceRevision, /^[0-9a-f]{64}$/);
  assert.deepEqual(result, normalize([first], [], true));
  first.discussionLoad = { status: "loaded", httpStatus: 200 };
  const complete = normalize([first]);
  assert.notEqual(result.draftSourceRevision, complete.draftSourceRevision);
  assert.notEqual(result.draftReleaseId, complete.draftReleaseId);
  const rich: RichContent = [{ type: "text", spans: [{ type: "text", text: "First content", marks: [] }] }];
  assert.notEqual(sc900OptionId(rich), `opt_${byteSha256(canonicalJson(rich))}`);
});

async function withWorkspace(run: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = resolve(".data/sc900/normalize-tests", `${process.pid}-${randomUUID()}`);
  await mkdir(resolve(workspace, ".data/sc900/raw/pages"), { recursive: true });
  try { await run(workspace); }
  finally { await rm(workspace, { recursive: true, force: true }); }
}
async function persist(workspace: string, capture: Sc900CaptureInput): Promise<void> {
  const file = resolve(workspace, capture.path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, capture.content);
}

test("private directory output is immutable and idempotent, with hash-addressed original media", async () => {
  await withWorkspace(async (workspace) => {
    const fixture = manual();
    await persist(workspace, input([fixture.raw], fixture.assets));
    const options = { workspaceRoot: workspace, expected: { pages: 1, occurrences: 1 } };
    const result = await normalizeSc900Directory(options);
    const output = resolve(workspace, ".data/sc900/normalized", result.draftReleaseId, "draft.json");
    const before = await stat(output);
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), result);
    await normalizeSc900Directory(options);
    assert.equal((await stat(output)).mtimeMs, before.mtimeMs);
    assert.equal(byteSha256(await readFile(resolve(dirname(output), "assets", `${byteSha256(png())}.png`))), byteSha256(png()));
    await writeFile(output, "unrecognized previous artifact");
    await assert.rejects(normalizeSc900Directory(options), /Refusing to overwrite/);
  });
});

test("directory normalizer refuses public paths, traversal, overlaps and symlinks", async () => {
  await withWorkspace(async (workspace) => {
    await persist(workspace, input([question()]));
    const base = { workspaceRoot: workspace, expected: { pages: 1, occurrences: 1 } };
    for (const outputDirectory of ["public/exams/sc900", "dist/exams/sc900", ".data/sc900/../bank", ".data/sc900/raw", ".data/sc900", "/tmp/sc900"]) {
      await assert.rejects(normalizeSc900Directory({ ...base, outputDirectory }), /restricted|strict|overlap/);
    }
    const target = resolve(workspace, ".data/sc900/target");
    await mkdir(target);
    await symlink(target, resolve(workspace, ".data/sc900/normalized"));
    await assert.rejects(normalizeSc900Directory(base), /symbolic link/);
  });
});

test("CLI drafts persist explicit issues with exit 2; strict incomplete captures never write output", async () => {
  await withWorkspace(async (workspace) => {
    const raw = question();
    raw.discussionLoad = { status: "failed", httpStatus: 429 };
    await persist(workspace, input([raw]));
    const script = resolve("tools/sc900/normalize.ts");
    const strict = spawnSync(process.execPath, ["--import", "tsx", script, "--expected-pages", "1", "--expected-occurrences", "1"], {
      cwd: workspace, encoding: "utf8",
    });
    assert.equal(strict.status, 1, strict.stderr);
    assert.match(strict.stderr, /incomplete/);
    assert.deepEqual(await readdir(resolve(workspace, ".data/sc900")), ["raw"]);
    const draft = spawnSync(process.execPath, ["--import", "tsx", script, "--draft"], { cwd: workspace, encoding: "utf8" });
    assert.equal(draft.status, 2, draft.stderr);
    const summary: { draftReleaseId: string; verifiedCaptureLedger: boolean } = JSON.parse(draft.stdout);
    assert.equal(summary.verifiedCaptureLedger, false);
    const artifact = JSON.parse(await readFile(resolve(workspace, ".data/sc900/normalized", summary.draftReleaseId, "draft.json"), "utf8")) as Sc900NormalizationResult;
    assertBlocked(artifact, "discussion-unverified");
    assert.equal(artifact.draftOccurrences[0]!.confirmedCommentCount, null);
    assert.equal(artifact.verifiedCaptureLedger, null);
  });
});

test("CLI arguments require explicit paired observed totals and reject typo or repeated flags", () => {
  assert.deepEqual(parseSc900NormalizeArgs(["--draft", "--expected-pages", "1", "--expected-occurrences", "5"]),
    { draft: true, expected: { pages: 1, occurrences: 5 } });
  for (const args of [
    ["--expected-pages", "1"], ["--expected-occurrences", "5"], ["--expected-pages", "1.5"],
    ["--draft", "--draft"], ["--output"], ["--require-complete"], ["--expected-pages", "0"],
  ]) assert.throws(() => parseSc900NormalizeArgs(args));
});

test("private pilot 2d2a5e3 is incomplete, retains all five questions and produces no verified ledger", async (context) => {
  const path = ".data/sc900/raw/pages/page-001.json";
  if (!existsSync(path)) return context.skip("Exact private SC900 pilot is not present in this checkout");
  const content = await readFile(path, "utf8");
  if (byteSha256(content) !== "2d2a5e3546969415bc48fa746932d5d6d0d5073989eabf0ae165ad429f361be3") {
    return context.skip("Private page has been replaced; this assertion covers only the identified incomplete pilot");
  }
  const result = normalizeSc900Captures([{ path, content }], { draft: true });
  assertBlocked(result, "capture-incomplete");
  assertBlocked(result, "unobserved-totals");
  assert.equal(result.counts.observedOccurrences, 5);
  assert.equal(result.counts.normalizedOccurrences, 5);
  assert.equal(result.draftDocuments.length, 5);
  assert.equal(result.draftAssets.length, 4);
  assert.equal(result.draftOccurrences.filter((occurrence) => occurrence.answerRevealed).length, 2);
  assert.deepEqual(result.draftOccurrences.map((occurrence) => occurrence.discussionState),
    ["failed", "failed", "not-requested", "not-requested", "not-requested"]);
  assert.deepEqual(result.draftOccurrences.map((occurrence) => occurrence.confirmedCommentCount), [null, null, null, null, null]);
  assert.deepEqual(result.draftOccurrences.map((occurrence) => occurrence.discussionHttpStatus), [429, 429, null, null, null]);
  assert.equal(result.counts.confirmedComments, null);
  const secondAnswer = doc(result, 2).answers.originalAnswers[0]!.value;
  assert.equal(secondAnswer.kind, "option-selection");
  assert.equal(secondAnswer.kind === "option-selection" && secondAnswer.optionIds[0],
    result.draftOccurrences[1]!.sourceLabelToOptionId.D);
  assert.ok([3, 4, 5].every((number) => doc(result, number).answers.effectiveAnswer.value.kind === "manual"));
  assert.equal(doc(result, 5).question.kind, "multi-select");
  assert.equal(doc(result, 5).question.options.length, 4);
  assert.equal(doc(result, 5).question.readiness.grading, "manual");
  assert.ok(result.draftDocuments.every((document) => Sc900DocumentSchema.safeParse(document).success));
  assert.throws(() => normalizeSc900Captures([{ path, content }]), Sc900NormalizationError);
  const scoped = normalizeSc900Captures([{ path, content }], {
    draft: true, expected: { pages: 44, occurrences: 219 },
  });
  assertBlocked(scoped, "incomplete-coverage");
  assert.deepEqual(scoped.observedSourceTotals, { pages: 44, occurrences: 219 });
  assert.equal(scoped.counts.normalizedOccurrences, 5);
  assert.equal(scoped.counts.confirmedComments, null);
});
