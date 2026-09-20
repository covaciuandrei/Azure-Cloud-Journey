import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeCaptures } from "../tools/ingest/normalize-core.js";
import { buildReviewOverlay, type ReviewedOccurrence } from "../tools/review/apply.js";
import { decideComment, filterQuestionComments } from "../tools/review/filter-comments.js";
import { type MaterializeInput } from "../tools/review/materialize.js";
import { sourceReviewSchema } from "../tools/review/source-review.js";
import { type Comment } from "../src/domain/index.js";

function fixture(entries: Array<{ text: string; parent?: number }>): {
  input: MaterializeInput; comments: Comment[];
} {
  const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const render = (index: number): string => {
    const entry = entries[index];
    if (!entry) throw new Error("Invalid fixture.");
    return `<div><a>[-]</a><div><ul class="chakra-wrap__list">
      <div><b>Reader${index}</b><b>1 point</b><span>1 day ago</span></div>
      <div>${entry.text.split("\n").map((line) => `<p>${escape(line)}</p>`).join("")}</div>
      <div>${entries.flatMap((child, number) => child.parent === index ? [render(number)] : []).join("")}</div>
    </ul></div></div>`;
  };
  const discussion = entries.flatMap((entry, index) => entry.parent === undefined ? [render(index)] : []).join("");
  const html = `<div class="chakra-accordion__item"><button class="chakra-accordion__button">Question 1</button>
    <div class="chakra-accordion__panel"><div><div class="css-naa3lg"><p>How should resources be categorized?</p></div><div>
    ${["Management groups", "Resource groups", "Tags"].map((text, index) =>
      `<div class="chakra-stack"><div>${String.fromCharCode(65 + index)}.</div><div><p>${text}</p></div></div>`).join("")}
    </div></div><div><button>Hide Answer</button></div><div>${discussion}</div></div></div>`;
  const dataset = normalizeCaptures([{
    path: ".data/raw/pages/page-001.json",
    content: JSON.stringify({
      captureVersion: 1, method: "rendered-browser-ui",
      url: "https://www.examprepper.co/exam/45/1", title: "Synthetic comments fixture",
      capturedAt: "2026-09-09T21:00:00Z",
      questions: [{
        heading: "Question 1", html, renderedText: "Synthetic rendered content",
        choiceStyles: ["Management groups", "Resource groups", "Tags"].map((text, index) => ({
          label: String.fromCharCode(65 + index), text, borderWidth: "2px",
          borderColor: index === 2 ? "rgb(104, 211, 145)" : "rgb(255, 255, 255)",
        })),
        answerRevealed: true, images: [], commentCount: entries.length, remainingControls: [],
        discussionLoad: { status: "loaded", httpStatus: 200 },
      }], assets: [],
    }),
  }], { expected: { pages: 1, occurrences: 1, pageSize: 5 } });
  const question = dataset.questions[0];
  const answers = dataset.answers[0];
  const occurrence = dataset.occurrences[0];
  assert.ok(question && answers && occurrence);
  const source: ReviewedOccurrence = {
    occurrence, review: sourceReviewSchema.parse({
      schemaVersion: 1, sourceQuestionNumber: 1, sourcePage: 1,
      rawPageSha256: occurrence.capture.rawPageSha256, reviewedCommentCount: entries.length,
      commentVerdict: "supports-source", answerStatus: "source-default",
      effectiveSourceLabels: ["C"], sourceImageAnswerSummary: null,
      rationale: "Synthetic reviewed discussion.", supportingComments: [], citations: [], warnings: [],
      reviewedAt: "2026-09-10T06:30:00Z",
    }),
  };
  return {
    input: { question, answers, sources: [source], review: buildReviewOverlay(question, answers, [source]) },
    comments: dataset.comments,
  };
}

test("answer-only agreements are omitted, but reasoning, disagreements and references remain", () => {
  const { input, comments } = fixture([
    { text: "Selected Answer: C\nC is correct" },
    { text: "The answer is Tags." },
    { text: "C is correct because tags associate resources with departments." },
    { text: "B is correct" },
    { text: "Selected Answer: C\nB is correct" },
    { text: "C is correct. https://learn.microsoft.com/en-us/azure/azure-resource-manager/management/tag-resources" },
    { text: "Why is C the correct answer?" },
  ]);
  const results = comments.map((comment) => ({ text: comment.bodyText, ...decideComment(comment, input) }));
  assert.equal(results.find((item) => item.text === "Selected Answer: C\nC is correct")?.retained, false);
  assert.equal(results.find((item) => item.text === "The answer is Tags.")?.retained, false);
  assert.equal(results.filter((item) => item.retained).length, 5);
});

test("pure acknowledgments and exam attendance add no question explanation", () => {
  const { input, comments } = fixture([
    { text: "Thank you for the explanation!" },
    { text: "This question was there on 16/03/2022 and I passed with 900 points." },
    { text: "The question was different in my exam: it used blob storage instead." },
    { text: "Tested C in my subscription; it works." },
  ]);
  const result = filterQuestionComments(input, comments);
  assert.equal(result.comments.length, 2);
  assert.ok(result.comments.some((comment) => comment.bodyText.includes("different")));
  assert.ok(result.comments.some((comment) => comment.bodyText.startsWith("Tested")));
});

test("relevant replies retain their ancestors, while omitted child references are removed", () => {
  const { input, comments } = fixture([
    { text: "C is correct" },
    { text: "Tags let you organize resources without moving them.", parent: 0 },
    { text: "Thank you", parent: 0 },
  ]);
  const filtered = filterQuestionComments(input, comments);
  assert.equal(filtered.comments.length, 2);
  const parent = filtered.comments.find((comment) => comment.parentId === null);
  assert.ok(parent);
  assert.equal(parent.childIds.length, 1);
  assert.equal(filtered.decisions.find((decision) => decision.id === parent.id)?.reason, "thread-context");
  assert.equal(comments.find((comment) => comment.id === parent.id)?.childIds.length, 2);
});

test("a question with only redundant confirmations has an empty public discussion", () => {
  const { input, comments } = fixture([
    { text: "C is correct." }, { text: "Selected Answer: C\nCorrect Answer: C" }, { text: "Thanks" },
  ]);
  const result = filterQuestionComments(input, comments);
  assert.equal(result.comments.length, 0);
  assert.equal(result.decisions.length, 3);
  assert.equal(comments.length, 3);
});

test("uncertain keys keep answer assertions and filtering rejects incomplete inputs", () => {
  const { input, comments } = fixture([{ text: "C is correct." }]);
  const source = input.sources[0];
  assert.ok(source);
  source.review.answerStatus = "unresolved";
  source.review.warnings = ["The correct answer remains disputed."];
  assert.equal(decideComment(comments[0]!, input).retained, true);
  assert.throws(() => filterQuestionComments(input, []), /complete original discussion/);
});

test("exact sibling duplicates keep one explanation without changing source records", () => {
  const { input, comments } = fixture([
    { text: "Tags group resources without changing their resource group." },
    { text: "Tags group resources without changing their resource group." },
  ]);
  const result = filterQuestionComments(input, comments);
  assert.equal(result.comments.length, 1);
  assert.equal(result.decisions.filter((decision) => decision.reason === "duplicate-sibling").length, 1);
  assert.equal(comments.length, 2);
});
