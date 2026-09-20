import type { CheerioAPI } from "cheerio";
import type { AnyNode, Element } from "domhandler";
import type { CaptureIssue, Inline, RichBlock, RichContent } from "../../src/domain/index.js";
import { canonicalJson, fail, safeUrl } from "./normalize-shared.js";

const ignoredTags = new Set([
  "script", "style", "iframe", "object", "embed", "noscript", "template", "base", "link", "meta",
]);
const blockTags = new Set([
  "p", "div", "section", "article", "main", "aside", "header", "footer", "address", "figure",
  "figcaption", "details", "summary", "dl", "dt", "dd",
]);
const marksByTag: Partial<Record<string, Inline["marks"][number]>> = {
  b: "bold", strong: "bold", i: "italic", em: "italic", u: "underline",
  s: "strike", del: "strike", strike: "strike", sub: "subscript", sup: "superscript",
};
type ImageBlock = Extract<RichBlock, { type: "image" }>;
interface ParseContext {
  baseUrl: string;
  context: string;
  image: (element: Element) => ImageBlock;
  issue: (issue: CaptureIssue) => void;
  ignore?: ReadonlySet<AnyNode>;
}
interface InlineStyle {
  marks: Inline["marks"];
  code: boolean;
  href: string | null;
}
const emptyStyle = (): InlineStyle => ({ marks: [], code: false, href: null });

export function isElement(node: AnyNode): node is Element {
  return "tagName" in node;
}

export function textContent(nodes: AnyNode[]): string {
  return nodes.map((node) => {
    if (node.type === "text") return node.data;
    if (!isElement(node) || ignoredTags.has(node.tagName)) return "";
    return textContent(node.children);
  }).join("");
}

function appendSpan(spans: Inline[], text: string, style: InlineStyle): void {
  if (!text) return;
  const span: Inline = style.href
    ? { type: "link", text, href: style.href, marks: [...style.marks] }
    : { type: style.code ? "code" : "text", text, marks: [...style.marks] };
  const previous = spans[spans.length - 1];
  if (previous && previous.type === span.type &&
      canonicalJson(previous.marks) === canonicalJson(span.marks) &&
      (previous.type !== "link" || (span.type === "link" && previous.href === span.href))) {
    previous.text += text;
  } else {
    spans.push(span);
  }
}

function trimSpans(spans: Inline[]): Inline[] {
  const first = spans[0];
  const last = spans[spans.length - 1];
  if (first && first.type !== "code") first.text = first.text.replace(/^ +/, "");
  if (last && last.type !== "code") last.text = last.text.replace(/ +$/, "");
  return spans.filter((span) => span.text !== "");
}

function integerAttribute(
  element: Element, name: string, fallback: number, context: ParseContext, allowZero = false,
): number {
  const raw = element.attribs[name];
  if (raw === undefined) return fallback;
  if (!/^-?\d+$/.test(raw)) fail(context.context, `invalid ${name} attribute ${JSON.stringify(raw)}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || (name !== "start" && value < (allowZero ? 0 : 1))) {
    fail(context.context, `invalid ${name} attribute ${JSON.stringify(raw)}`);
  }
  return value;
}

export function parseRichContent(
  $: CheerioAPI, nodes: AnyNode[], context: ParseContext,
): RichContent {
  const flow = (children: AnyNode[], inherited = emptyStyle(), preserveEmpty = false): RichContent => {
    const blocks: RichContent = [];
    let spans: Inline[] = [];
    const flush = (empty = false) => {
      const cleaned = trimSpans(spans);
      if (cleaned.length || empty) blocks.push({ type: "text", spans: cleaned });
      spans = [];
    };
    const report = (code: string, message: string) =>
      context.issue({ code, context: context.context, message });
    const visit = (node: AnyNode, style: InlineStyle): void => {
      if (context.ignore?.has(node)) return;
      if (node.type === "text") {
        appendSpan(spans, style.code ? node.data : node.data.replace(/[ \t\r\n\f]+/g, " "), style);
        return;
      }
      if (!isElement(node)) return;
      const tag = node.tagName.toLowerCase();
      if (ignoredTags.has(tag)) {
        report("removed-active-content", `Excluded non-renderable/active <${tag}> from safe content; original stays in private capture`);
        return;
      }
      if (["svg", "canvas", "video", "audio", "input", "textarea", "select"].includes(tag)) {
        fail(context.context, `unsupported visible <${tag}> requires explicit conversion, not silent text loss`);
      }
      const next: InlineStyle = { ...style, marks: [...style.marks] };
      const mark = marksByTag[tag];
      if (mark && !next.marks.includes(mark)) next.marks.push(mark);
      next.marks.sort();
      if (tag === "code") next.code = true;
      if (tag === "a" && node.attribs.href !== undefined) {
        next.href = safeUrl(node.attribs.href, context.baseUrl);
        if (!next.href) report("removed-unsafe-link", "Kept link text but excluded unsafe/non-HTTP(S) URL");
      }
      if (tag === "br") { appendSpan(spans, "\n", next); return; }
      if (tag === "wbr") return;
      if (tag === "img") { flush(); blocks.push(context.image(node)); return; }
      if (tag === "hr") { flush(); blocks.push({ type: "separator" }); return; }
      if (tag === "pre") {
        flush();
        const code = $(node).find("code").first();
        const className = code.attr("class") ?? node.attribs.class ?? "";
        const language = className.match(/(?:^|\s)language-([a-zA-Z0-9_+-]+)(?:\s|$)/)?.[1] ?? null;
        blocks.push({ type: "code", code: textContent(node.children), language });
        for (const child of $(node).find("script,style,iframe,object,embed").toArray()) {
          if (isElement(child)) report("removed-active-content", `Excluded <${child.tagName}> from code block`);
        }
        return;
      }
      if (/^h[1-6]$/.test(tag)) {
        flush();
        const content = flow(node.children, next, true);
        if (content.length === 1 && content[0]?.type === "text") {
          blocks.push({ type: "heading", level: Number(tag[1]), spans: content[0].spans });
        } else {
          blocks.push(...content);
        }
        return;
      }
      if (tag === "blockquote") {
        flush();
        blocks.push({ type: "quote", blocks: flow(node.children, next) });
        return;
      }
      if (tag === "ul" || tag === "ol") {
        flush();
        const items = $(node).children("li").toArray();
        const otherContent = node.children.filter((child) =>
          !(isElement(child) && child.tagName === "li") &&
          !(child.type === "text" && !child.data.trim()) && child.type !== "comment");
        if (otherContent.length) fail(context.context, "list has non-li content; unsupported layout");
        blocks.push({
          type: "list", ordered: tag === "ol",
          start: integerAttribute(node, "start", 1, context),
          items: items.map((item) => flow(item.children, next, true)),
        });
        return;
      }
      if (tag === "table") {
        flush();
        const caption = $(node).children("caption").toArray().flatMap((element) => flow(element.children, next));
        if (caption.some((block) => block.type !== "text")) {
          fail(context.context, "table caption contains non-text content requiring conversion");
        }
        const rows = $(node).find("tr").filter((_, element) => $(element).closest("table")[0] === node).toArray();
        blocks.push({
          type: "table",
          caption: caption.flatMap((block) => block.type === "text" ? block.spans : []),
          rows: rows.map((row) => ({
            cells: $(row).children("th,td").toArray().map((cell) => ({
              header: cell.tagName === "th",
              rowSpan: integerAttribute(cell, "rowspan", 1, context, true),
              colSpan: integerAttribute(cell, "colspan", 1, context),
              blocks: flow(cell.children, next, true),
            })),
          })),
        });
        return;
      }
      if (blockTags.has(tag)) {
        flush();
        blocks.push(...flow(node.children, next, tag === "p"));
        return;
      }
      for (const child of node.children) visit(child, next);
    };
    for (const child of children) visit(child, inherited);
    flush(preserveEmpty && blocks.length === 0 && spans.length === 0);
    return blocks;
  };
  return flow(nodes);
}
