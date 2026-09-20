import type { RichContent } from "../../domain/index.js";

function textOf(block: RichContent[number]): string | null {
  if (block.type !== "text" || block.spans.some((span) => span.type !== "text")) return null;
  return block.spans.map((span) => span.text).join("");
}

export function compactJsonParagraphs(blocks: RichContent): RichContent {
  const result: RichContent = [];
  for (let index = 0; index < blocks.length; index++) {
    const first = blocks[index];
    if (!first) continue;
    const text = textOf(first);
    if (text === null || !/^\s*[\[{]/.test(text)) {
      result.push(first);
      continue;
    }
    const lines: string[] = [];
    let end: number | null = null;
    for (let cursor = index; cursor < blocks.length; cursor++) {
      const block = blocks[cursor];
      const line = block ? textOf(block) : null;
      if (line === null) break;
      lines.push(line);
      if (!/[}\]]\s*$/.test(line)) continue;
      try {
        JSON.parse(lines.join("\n"));
        end = cursor;
        break;
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
    if (end === null) {
      result.push(first);
    } else {
      result.push({ type: "code", code: lines.join("\n"), language: "json" });
      index = end;
    }
  }
  return result;
}
