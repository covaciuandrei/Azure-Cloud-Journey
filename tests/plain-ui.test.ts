import assert from "node:assert/strict";
import { test } from "node:test";
import type { RichContent } from "../src/domain/index.js";
import { compactJsonParagraphs } from "../src/web/ui/codePresentation.js";

const paragraph = (text: string): RichContent[number] => ({ type: "text", spans: [{ type: "text", text, marks: [] }] });

test("JSON split into source paragraphs is displayed compactly without changing the text", () => {
  const content: RichContent = [
    paragraph("Example:"),
    paragraph("{"),
    paragraph('"type": "example",'),
    paragraph('"items": [1, 2]'),
    paragraph("}"),
    paragraph("The next explanation stays separate."),
  ];
  const copy = structuredClone(content);
  const result = compactJsonParagraphs(content);
  assert.equal(result.length, 3);
  assert.deepEqual(result[1], { type: "code", language: "json", code: '{\n"type": "example",\n"items": [1, 2]\n}' });
  assert.deepEqual(content, copy);
});

test("ordinary prose, incomplete examples, and linked paragraphs are not rewritten", () => {
  const content: RichContent = [
    paragraph("{unfinished"),
    paragraph("Keep this explanation."),
    { type: "text", spans: [{ type: "link", text: '{"value": 1}', href: "https://example.test/", marks: [] }] },
    paragraph("Another sentence."),
  ];
  assert.deepEqual(compactJsonParagraphs(content), content);
});
