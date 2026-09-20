import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RichContent } from "../src/domain/index.js";
import { CleanCatalogSchema, CleanDocumentSchema, CleanManifestSchema } from "../src/domain/cleanBank.js";
import { QuestionCard } from "../src/web/ui/QuestionCard.js";
import type { StudyDocument, StudyRepository } from "../src/web/types.js";
import {
  answerImageContent, hasNonImageContent, splitStandaloneImages,
} from "../src/web/image-presentation.js";

const image = (assetId: string): RichContent[number] => ({
  type: "image", assetId, alt: "", width: 10, height: 10,
});

test("splits only standalone images without dismantling nested structures", () => {
  const nested = image("b".repeat(64));
  const content: RichContent = [
    { type: "text", spans: [{ type: "text", text: "Context", marks: [] }] },
    image("a".repeat(64)),
    { type: "quote", blocks: [nested] },
  ];
  const split = splitStandaloneImages(content);
  assert.deepEqual(split.images, [content[1]]);
  assert.deepEqual(split.body, [content[0], content[2]]);
});

test("collects declared answer images in source order and deduplicates them", () => {
  const first = "a".repeat(64);
  const second = "b".repeat(64);
  const answers = {
    originalAnswers: [{
      answerAssetIds: [second, first],
      explanation: [image(first), { type: "quote", blocks: [image(second)] }],
    }],
    effectiveAnswer: {
      value: { kind: "manual", reason: "image-only", sourceAnswerAssetIds: [first] },
    },
  } satisfies Parameters<typeof answerImageContent>[0];
  assert.deepEqual(answerImageContent(answers).map((block) => block.type === "image" && block.assetId),
    [second, first]);
});

test("detects useful explanation text while ignoring image-only content", () => {
  assert.equal(hasNonImageContent([image("a".repeat(64))]), false);
  assert.equal(hasNonImageContent([{
    type: "table", caption: [], rows: [{ cells: [{
      header: false, rowSpan: 1, colSpan: 1,
      blocks: [{ type: "text", spans: [{ type: "text", text: "Reason", marks: [] }] }],
    }] }],
  }]), true);
});

async function documentFor(number: number): Promise<StudyDocument> {
  const manifest = CleanManifestSchema.parse(JSON.parse(await readFile(".data/clean-bank/data/manifest.json", "utf8")));
  const catalog = CleanCatalogSchema.parse(JSON.parse(await readFile(`.data/clean-bank/${manifest.catalogUrl}`, "utf8")));
  const entry = catalog.questions.find((question) => (question.sourceNumbers ?? [question.number]).includes(number));
  assert.ok(entry);
  return CleanDocumentSchema.parse(JSON.parse(await readFile(
    `.data/clean-bank/${manifest.questionBaseUrl}${entry.id}.json`, "utf8",
  )));
}

const repository: StudyRepository = {
  async loadCatalog() { throw new Error("SSR must not fetch data."); },
  async loadQuestion() { throw new Error("SSR must not fetch data."); },
  async loadQuestions() { throw new Error("SSR must not fetch data."); },
  async loadDiscussion() { throw new Error("SSR must not fetch discussions."); },
  mediaUrl(question, id) {
    assert.ok(question.media.some((media) => media.id === id));
    return `http://127.0.0.1:5173/test-media/${id}.png`;
  },
};

test("image questions reveal a single comparison without requiring typed answers", async () => {
  const document = await documentFor(157);
  const answerId = document.answers.originalAnswers[0]?.answerAssetIds[0];
  assert.ok(answerId);
  const props = {
    document, order: [], repository,
    response: { selectedIds: [], note: "Previously saved reasoning", submitted: false, flagged: false, selfAssessment: null },
    onReveal: () => undefined,
  };
  const hidden = renderToStaticMarkup(createElement(QuestionCard, { ...props, revealed: false }));
  const shown = renderToStaticMarkup(createElement(QuestionCard, { ...props, revealed: true }));
  assert.doesNotMatch(hidden, /<textarea/);
  assert.doesNotMatch(shown, /<textarea/);
  assert.match(hidden, /Previously saved reasoning/);
  assert.match(hidden, /Reveal answer/);
  assert.equal(hidden.includes(`/test-media/${answerId}.png`), false);
  assert.equal(shown.split(`/test-media/${answerId}.png`).length - 1, 1);
});

test("automatic converted questions retain source explanation images outside the manual comparison", async () => {
  const document = await documentFor(13);
  assert.equal(document.question.readiness.grading, "automatic");
  const answerId = document.answers.originalAnswers[0]?.answerAssetIds[0];
  assert.ok(answerId);
  const html = renderToStaticMarkup(createElement(QuestionCard, {
    document, order: document.question.options.map((option) => option.id),
    repository, revealed: true,
    response: { selectedIds: [], note: "", submitted: true, flagged: false, selfAssessment: null },
  }));
  assert.match(html, new RegExp(`/test-media/${answerId}\\.png`));
  assert.doesNotMatch(html, /image-comparison-panel/);
});

test("offline exhibits are eager and retain explicit image dimensions", async () => {
  const document = await documentFor(157);
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { onLine: false } });
  try {
    const html = renderToStaticMarkup(createElement(QuestionCard, {
      document, order: [], repository, revealed: true,
      response: { selectedIds: [], note: "", submitted: true, flagged: false, selfAssessment: null },
    }));
    assert.match(html, /loading="eager"/);
    assert.doesNotMatch(html, /loading="lazy"/);
    assert.match(html, /<img[^>]+width="\d+"[^>]+height="\d+"/);
  } finally {
    if (original) Object.defineProperty(globalThis, "navigator", original);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});
