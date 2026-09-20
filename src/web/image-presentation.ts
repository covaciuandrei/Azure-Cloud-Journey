import type { RichContent } from "../domain/index.js";
import type { CleanAnswer as PreparedAnswer } from "../domain/cleanBank.js";

type RichBlock = RichContent[number];
type ImageBlock = Extract<RichBlock, { type: "image" }>;

export function splitStandaloneImages(content: RichContent): {
  body: RichContent;
  images: RichContent;
} {
  const body: RichContent = [];
  const images: RichContent = [];
  for (const block of content) {
    (block.type === "image" ? images : body).push(block);
  }
  return { body, images };
}

function visitImages(content: RichContent, visit: (image: ImageBlock) => void): void {
  for (const block of content) {
    switch (block.type) {
      case "image":
        visit(block);
        break;
      case "quote":
        visitImages(block.blocks, visit);
        break;
      case "list":
        block.items.forEach((item) => visitImages(item, visit));
        break;
      case "table":
        block.rows.forEach((row) => row.cells.forEach((cell) => visitImages(cell.blocks, visit)));
        break;
      default:
        break;
    }
  }
}

export function answerImageContent(answers: {
  originalAnswers: Array<Pick<PreparedAnswer["originalAnswers"][number], "answerAssetIds" | "explanation">>;
  effectiveAnswer: Pick<PreparedAnswer["effectiveAnswer"], "value">;
}): RichContent {
  const found = new Map<string, ImageBlock>();
  for (const answer of answers.originalAnswers) {
    visitImages(answer.explanation, (image) => {
      if (!found.has(image.assetId)) found.set(image.assetId, image);
    });
  }

  const declared = answers.originalAnswers.flatMap((answer) => answer.answerAssetIds);
  if (answers.effectiveAnswer.value.kind === "manual") {
    declared.push(...answers.effectiveAnswer.value.sourceAnswerAssetIds);
  }
  const ids = [...new Set([...declared, ...found.keys()])];
  return ids.map((assetId) => found.get(assetId) ?? {
    type: "image",
    assetId,
    alt: "Source answer",
    width: 1,
    height: 1,
  });
}

export function hasNonImageContent(content: RichContent): boolean {
  return content.some((block) => {
    switch (block.type) {
      case "image":
      case "separator":
        return false;
      case "text":
      case "heading":
        return block.spans.some((span) => span.text.trim().length > 0);
      case "code":
        return block.code.trim().length > 0;
      case "quote":
        return hasNonImageContent(block.blocks);
      case "list":
        return block.items.some(hasNonImageContent);
      case "table":
        return block.caption.some((span) => span.text.trim().length > 0) ||
          block.rows.some((row) => row.cells.some((cell) => hasNonImageContent(cell.blocks)));
    }
  });
}
