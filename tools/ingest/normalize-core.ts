import { load, type CheerioAPI } from "cheerio";
import type { AnyNode, Element } from "domhandler";
import {
  AnswerRecordSchema, AssetUseSchema, CatalogSchema, CommentSchema, CoverageSchema,
  DATASET_ID, EXPECTED_COVERAGE, ManifestSchema, NORMALIZER_VERSION, OptionSchema,
  QuestionSchema, SourceOccurrenceSchema, assertAnswerOptionIds, assertDocumentSize,
  pendingReview, richAssetIds,
  type AnswerRecord, type AnswerValue, type Asset, type AssetUse, type CaptureIssue,
  type Catalog, type Comment, type Coverage, type Manifest, type Option, type OriginalAnswer,
  type Question, type RawPageMetadata, type RichContent, type SourceOccurrence,
} from "../../src/domain/index.js";
import { AssetRegistry, type CapturedAsset } from "./normalize-assets.js";
import { parseRichContent, textContent } from "./normalize-html.js";
import {
  RawCaptureSchema, canonicalJson, digest, fail, jsonFile, occurrenceId,
  plainText, safeUrl, sha256, type RawCapture, type RawQuestion,
} from "./normalize-shared.js";

export interface CaptureInput { path: string; content: string }
export interface NormalizationOptions {
  assetDirectory?: string;
  expected?: { pages: number; occurrences: number; pageSize: number };
}
export interface NormalizedDataset {
  questions: Question[];
  answers: AnswerRecord[];
  occurrences: SourceOccurrence[];
  comments: Comment[];
  assets: Asset[];
  catalog: Catalog;
  manifest: Manifest;
  assetRegistry: AssetRegistry;
}
export const RECORD_COLLECTIONS = ["questions", "answers", "occurrences", "comments", "assets"] as const;
export type RecordCollection = typeof RECORD_COLLECTIONS[number];
interface PendingUse {
  assetId: string;
  use: Omit<AssetUse, "questionId">;
}
interface ParsedQuestion {
  fingerprint: string;
  prompt: RichContent;
  options: Option[];
  shuffle: Question["shuffle"];
  format: "choice" | "manual";
  multiSelect: boolean;
  occurrence: SourceOccurrence;
  originalAnswer: OriginalAnswer;
  comments: Comment[];
  uses: PendingUse[];
}

const collapseDisplayWhitespace = (text: string) => text.replace(/\s+/gu, " ").trim();
const expansionControl = /^(show answer|load more|show more|more comments|load more comments|show more comments|show replies|\[\+\])$/i;
const manualFormat = /\b(?:DRAG\s*DROP|HOT\s*(?:SPOT|AREA)|Select\s+and\s+Place|answer\s+by\s+dragging|select\s+(?:the\s+)?(?:appropriate|correct)\s+options?\s+in\s+the\s+answer\s+area)\b/i;
const orderedFormat = /\b(?:drag(?:ging)?|drop-down|match(?:ing)?|sequence|ordering|ascending|descending|in\s+(?:(?:the|a|an|this|that|correct|appropriate)\s+)*order|reorder|re-order)\b/i;
const multiInstruction = /\b(?:choose|select)\s+(?:two|three|four|five|six|\d+|all)\b|\beach\s+correct\s+answer\s+(?:presents|is)\b/i;

export function shufflePolicy(prompt: RichContent, options: Option[]): Question["shuffle"] {
  const reasons: Question["shuffle"]["reasons"] = [];
  const text = [plainText(prompt), ...options.map((option) => plainText(option.content))].join("\n");
  if (!options.length) reasons.push("no-discrete-options");
  if (/\b(?:option|answer|choice|statement|response)s?\s+(?:[A-Z]|\d+)(?=[\s,.:;)])/i.test(text) ||
      /\b[A-Z]\s*(?:[,+/&]|\band(?:\/or)?\b|\bor\b|\bthrough\b|\bto\b)\s*[A-Z]\b/.test(text) ||
      options.some((option) => /^\s*(?:[A-Z][.)]?|\([A-Z]\))\s*$/.test(plainText(option.content)))) {
    reasons.push("label-reference");
  }
  if (/\b(?:all|none|both|any|neither)\s+(?:of\s+)?(?:the\s+)?(?:above|below|preceding|following|other)\b|\b(?:above|below)\s+(?:answers?|options?|choices?)\b|\b(?:first|second|third|fourth|last|previous|next)\s+(?:(?:one|two|three|four|five|\d+)\s+)?(?:answers?|options?|choices?)\b/i.test(text)) {
    reasons.push("relative-option-reference");
  }
  if (manualFormat.test(text) || orderedFormat.test(text)) reasons.push("ordered-or-matching");
  if (new Set(options.map((option) => option.contentHash)).size !== options.length) {
    reasons.push("duplicate-option-content");
  }
  return { allowed: reasons.length === 0, reasons: [...new Set(reasons)].sort() };
}

function sourceBorder(color: string, width: string, context: string): "selected" | "ordinary" {
  const rgb = color.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*(1(?:\.0+)?))?\s*\)$/i);
  if (!rgb) fail(context, `unsupported computed border color ${JSON.stringify(color)}`);
  const tuple = rgb.slice(1, 4).map(Number).join(",");
  const widths = width.split(/\s+/);
  if (!widths.every((value) => /^\d+(?:\.\d+)?px$/.test(value) && Number.parseFloat(value) >= 0)) {
    fail(context, `invalid computed border width ${JSON.stringify(width)}`);
  }
  if (tuple === "104,211,145") {
    if (widths.some((value) => Number.parseFloat(value) === 0)) {
      fail(context, "source-green border is not visibly drawn");
    }
    return "selected";
  }
  if (tuple === "255,255,255") return "ordinary";
  return fail(context, `unrecognized source key border ${JSON.stringify(color)}; refusing to guess the answer`);
}

function assertCaptureReady(
  $: CheerioAPI, raw: RawQuestion, context: string,
): Pick<SourceOccurrence["capture"], "answerEvidence" | "discussionLoadStatus"> {
  const hide = $("button").filter((_, node) => $(node).text().trim() === "Hide Answer");
  if (hide.length !== 1 || raw.answerRevealed === false) {
    fail(context, "answer is not demonstrably revealed (exactly one Hide Answer control required)");
  }
  if (raw.remainingControls.length) fail(context, `unexpanded capture controls: ${raw.remainingControls.join(", ")}`);
  const controls = $("button,a").filter((_, node) => expansionControl.test($(node).text().trim()));
  if (controls.length) fail(context, `unexpanded DOM controls: ${controls.map((_, node) => $(node).text().trim()).get().join(", ")}`);
  if ((raw.loadingIndicators ?? 0) > 0 ||
      (raw.loadingIndicators === undefined && $(".chakra-spinner,[role=progressbar]").length > 0)) {
    fail(context, "discussion/content loading indicators are still present");
  }
  const status = raw.discussionLoad?.status;
  if (status && !["loaded", "rendered-only"].includes(status)) {
    fail(context, `discussion loading was ${status}: ${JSON.stringify(raw.discussionLoad)}`);
  }
  if (raw.discussionLoad?.httpStatus !== undefined &&
      (raw.discussionLoad.httpStatus < 200 || raw.discussionLoad.httpStatus >= 300)) {
    fail(context, `discussion loading returned HTTP ${raw.discussionLoad.httpStatus}`);
  }
  return {
    answerEvidence: raw.answerRevealed === true ? "flag-and-hide-control" : "legacy-hide-control",
    discussionLoadStatus: status === "loaded" ? "loaded" : status === "rendered-only" ? "rendered-only" : "legacy-rendered",
  };
}

function parseQuestion(
  capture: RawCapture, raw: RawQuestion, page: RawPageMetadata,
  pageAssets: Map<string, CapturedAsset>,
): ParsedQuestion {
  const context = `${page.path} / ${raw.heading}`;
  const number = Number(raw.heading.slice("Question ".length));
  const sourceId = occurrenceId(number);
  const $ = load(raw.html, undefined, false);
  if ($(".chakra-accordion__item").length !== 1 || $(".chakra-accordion__panel").length !== 1) {
    fail(context, "expected exactly one rendered question container and panel");
  }
  if ($(".chakra-accordion__button").length !== 1 ||
      $(".chakra-accordion__button").text().trim() !== raw.heading) {
    fail(context, "HTML question heading does not match captured heading");
  }
  const ready = assertCaptureReady($, raw, context);
  const sections = $(".chakra-accordion__panel").children().toArray();
  const questionSection = sections[0];
  if (!questionSection || sections.length < 2 || $(sections[1]!).text().trim() !== "Hide Answer") {
    fail(context, "unexpected prompt/answer-controls layout");
  }
  const issues: CaptureIssue[] = [];
  const imageElements = $("img").toArray();
  if (imageElements.length !== raw.images.length) {
    fail(context, `captured image count ${raw.images.length} differs from DOM image count ${imageElements.length}`);
  }
  const imageMap = new Map<Element, { image: RawQuestion["images"][number]; asset: CapturedAsset; index: number }>();
  imageElements.forEach((element, index) => {
    const image = raw.images[index]!;
    if (!image.loaded || !image.width || !image.height) fail(context, `image ${index} is not loaded: ${image.currentSrc}`);
    const domSrc = element.attribs.src;
    if ((domSrc ?? null) !== image.src &&
        (!domSrc || image.src === null || safeUrl(domSrc, capture.url) !== safeUrl(image.src, capture.url))) {
      fail(context, `image ${index} DOM src does not match the captured image metadata`);
    }
    if ((element.attribs.alt ?? "") !== image.alt) {
      fail(context, `image ${index} DOM alternative text does not match the captured image metadata`);
    }
    const asset = pageAssets.get(image.currentSrc);
    if (!asset) fail(context, `missing captured bytes for image ${index}: ${image.currentSrc}`);
    if (asset.metadata.width !== image.width || asset.metadata.height !== image.height) {
      fail(context, `image ${index} captured ${image.width}x${image.height} but bytes are ${asset.metadata.width}x${asset.metadata.height}`);
    }
    imageMap.set(element, { image, asset, index });
  });
  const usedImages = new Set<Element>();
  const uses: PendingUse[] = [];
  const rich = (
    nodes: AnyNode[], role: AssetUse["role"], label: string,
    commentId: string | null = null, ignore?: ReadonlySet<AnyNode>,
  ): RichContent => parseRichContent($, nodes, {
    baseUrl: capture.url,
    context: `${context} / ${label}`,
    ...(ignore ? { ignore } : {}),
    issue: (issue) => issues.push(issue),
    image: (element) => {
      const metadata = imageMap.get(element);
      if (!metadata) fail(context, `unindexed image in ${label}`);
      if (usedImages.has(element)) fail(context, `image ${metadata.index} was assigned multiple content roles`);
      usedImages.add(element);
      const { image, asset, index } = metadata;
      uses.push({
        assetId: asset.metadata.id,
        use: { sourceOccurrenceId: sourceId, commentId, role, presentationIndex: index, sourceUrl: image.currentSrc, alt: image.alt },
      });
      return { type: "image", assetId: asset.metadata.id, alt: image.alt, width: image.width, height: image.height };
    },
  });
  const optionRows = $(questionSection).find(".chakra-stack").filter((_, row) => {
    const children = $(row).children();
    return children.length === 2 && /^[A-Z]\.$/.test(children.first().text().trim());
  }).toArray();
  if (optionRows.some((row) => $(row).parents().toArray().some((ancestor) => optionRows.includes(ancestor)))) {
    fail(context, "nested labeled choice rows are ambiguous");
  }
  const labels = optionRows.map((row) => $(row).children().first().text().trim().slice(0, -1));
  if (new Set(labels).size !== labels.length) fail(context, "duplicate source choice labels");
  const styles = new Map(raw.choiceStyles.map((style) => [style.label, style]));
  if (styles.size !== raw.choiceStyles.length ||
      [...styles.keys()].sort().join() !== [...labels].sort().join()) {
    fail(context, "captured choiceStyles do not match the DOM choice labels exactly");
  }
  const prompt = rich(questionSection.children, "prompt", "prompt", null, new Set(optionRows));
  if (!prompt.length || (!plainText(prompt).trim() && richAssetIds(prompt).length === 0)) {
    fail(context, "required question prompt is empty");
  }
  const optionContent = optionRows.map((row, index) => {
    const contentElement = $(row).children().eq(1)[0]!;
    const content = rich(contentElement.children, "option", `option ${labels[index]}`);
    if (!content.length || (!plainText(content).trim() && richAssetIds(content).length === 0)) {
      fail(context, `source option ${labels[index]} has no required content`);
    }
    const withoutImages = (blocks: RichContent): RichContent => blocks.filter((block) => block.type !== "image").map((block) => {
      if (block.type === "quote") return { ...block, blocks: withoutImages(block.blocks) };
      if (block.type === "list") return { ...block, items: block.items.map(withoutImages) };
      if (block.type === "table") return {
        ...block, rows: block.rows.map((row) => ({ cells: row.cells.map((cell) => ({ ...cell, blocks: withoutImages(cell.blocks) })) })),
      };
      return block;
    });
    if (collapseDisplayWhitespace(plainText(withoutImages(content))) !==
        collapseDisplayWhitespace(styles.get(labels[index]!)!.text)) {
      fail(context, `computed style text for option ${labels[index]} does not match its DOM content`);
    }
    return { content, contentHash: digest(content) };
  });
  const copies = new Map<string, number>();
  const options = optionContent.map((option) => {
    const duplicate = optionContent.filter((other) => other.contentHash === option.contentHash).length > 1;
    const copy = (copies.get(option.contentHash) ?? 0) + 1;
    copies.set(option.contentHash, copy);
    return OptionSchema.parse({ ...option, id: `opt_${option.contentHash}${duplicate ? `_${copy}` : ""}` });
  });
  const sourceLabelToOptionId = Object.fromEntries(options.map((option, index) => [labels[index]!, option.id]));
  const selectedLabels = labels.filter((label) => {
    const style = styles.get(label)!;
    return sourceBorder(style.borderColor, style.borderWidth, `${context} / option ${label}`) === "selected";
  });
  const shuffle = shufflePolicy(prompt, options);
  const format = options.length === 0 || manualFormat.test(plainText(prompt)) ? "manual" : "choice";
  const fingerprint = digest({
    normalizerVersion: NORMALIZER_VERSION,
    prompt,
    format,
    options: shuffle.allowed
      ? options.map((option) => option.contentHash).sort()
      : options.map((option, index) => ({ label: labels[index], hash: option.contentHash })),
  });
  const questionId = `q_${fingerprint}`;
  const allCommentElements = $("ul.chakra-wrap__list").toArray();
  if (allCommentElements.length !== raw.commentCount) {
    fail(context, `comment reconciliation failed: captured ${raw.commentCount}, DOM ${allCommentElements.length}`);
  }
  let discussionEvidence: SourceOccurrence["capture"]["discussionEvidence"] = "rendered-comments";
  if (raw.commentCount === 0) {
    if (ready.discussionLoadStatus !== "loaded") {
      fail(context, "zero comments without confirmed successful discussion loading is capture failure, even if an empty-state placeholder is displayed");
    }
    discussionEvidence = "confirmed-empty";
  }
  const explanation: RichContent = [];
  for (const section of sections.slice(2)) {
    if ($(section).find("ul.chakra-wrap__list").length) {
      if ($(section).find("b,strong").toArray().some((node) => $(node).text().trim() === "Correct answer:")) {
        fail(context, "mixed author explanation/discussion section needs explicit parsing");
      }
      continue;
    }
    if (raw.commentCount === 0 && /^(?:no comments(?: yet)?|no discussions?(?: yet)?|be the first to comment)[.!]?$/i.test($(section).text().trim())) continue;
    const markers = $(section).find("b,strong,p").filter((_, node) => $(node).text().trim() === "Correct answer:").toArray();
    explanation.push(...rich([section], "answer", "source explanation", null, new Set(markers)));
  }
  for (const element of allCommentElements) {
    if (!sections.slice(2).some((section) => $(element).parents().toArray().includes(section))) {
      fail(context, "discussion comment is outside the discussion sections");
    }
  }
  const comments: Comment[] = [];
  const visited = new Set<Element>();
  const rootCommentIds: string[] = [];
  const parseComment = (
    element: Element, treePath: number[], parentId: string | null, rootId: string | null,
  ): string => {
    if (visited.has(element)) fail(context, `comment at ${treePath.join(".")} visited twice`);
    visited.add(element);
    const where = `${context} / comment ${treePath.join(".")}`;
    const children = $(element).children();
    if (children.length !== 3) fail(where, `expected header/body/replies children, found ${children.length}`);
    const header = children.eq(0);
    const authorNodes = header.children("b");
    const timeNodes = header.children("span");
    if (authorNodes.length !== 2 || timeNodes.length !== 1) fail(where, "author/vote/displayed-timestamp header is missing or ambiguous");
    const author = authorNodes.eq(0).text().trim();
    const voteText = authorNodes.eq(1).text().trim();
    const displayedTimestamp = timeNodes.text().trim();
    const voteMatch = voteText.match(/^([+-]?\d[\d,]*)\s+points?$/);
    if (!author || !displayedTimestamp || !voteMatch) fail(where, "missing author/timestamp or unreadable vote count");
    const votes = Number(voteMatch[1]!.replaceAll(",", ""));
    if (!Number.isSafeInteger(votes)) fail(where, "vote count exceeds safe integer range");
    const bodyNodes = children.eq(1).contents().toArray();
    const useStart = uses.length;
    const body = rich(bodyNodes, "comment", `comment ${treePath.join(".")}`);
    const bodyTextContent = textContent(bodyNodes);
    const id = `c_${digest({ sourceOccurrenceId: sourceId, treePath, author, bodyTextContent, body })}`;
    for (const use of uses.slice(useStart)) use.use.commentId = id;
    const currentRoot = rootId ?? id;
    const comment = CommentSchema.parse({
      schemaVersion: 1, id, questionId, sourceOccurrenceId: sourceId,
      sourceRevision: digest({ id, questionId, parentId, rootId: currentRoot, body, bodyTextContent, votes, voteText, displayedTimestamp, capturedAt: capture.capturedAt }),
      sourceCommentId: null, sourceCreatedAt: null,
      author, votes, voteText, displayedTimestamp, capturedAt: capture.capturedAt,
      bodyText: plainText(body), bodyTextContent, body,
      parentId, rootId: currentRoot, childIds: [], treePath, trust: "untrusted-source-content",
    });
    comments.push(comment);
    const replies = children.eq(2).find("ul.chakra-wrap__list").filter((_, reply) =>
      $(reply).parents("ul.chakra-wrap__list").first()[0] === element).toArray();
    replies.forEach((reply, index) => {
      comment.childIds.push(parseComment(reply, [...treePath, index], id, currentRoot));
    });
    return id;
  };
  const roots = allCommentElements.filter((element) => $(element).parents("ul.chakra-wrap__list").length === 0);
  roots.forEach((element, index) => rootCommentIds.push(parseComment(element, [index], null, null)));
  if (comments.length !== raw.commentCount || visited.size !== allCommentElements.length) {
    fail(context, `comment reconciliation failed: captured ${raw.commentCount}, parsed ${comments.length}, visited ${visited.size}`);
  }
  if (usedImages.size !== imageElements.length) {
    const missing = imageElements.filter((element) => !usedImages.has(element)).map((element) => imageMap.get(element)!.index);
    fail(context, `images were not assigned content roles: ${missing.join(", ")}`);
  }
  const answerAssetIds = richAssetIds(explanation);
  const value: AnswerValue = selectedLabels.length ? {
    kind: "option-selection", optionIds: selectedLabels.map((label) => sourceLabelToOptionId[label]!).sort(),
  } : {
    kind: "manual",
    reason: options.length === 0
      ? (richAssetIds(prompt).length || answerAssetIds.length ? "image-only" : "non-choice-format")
      : "no-readable-key",
    sourceAnswerAssetIds: answerAssetIds,
  };
  if (value.kind === "manual" && value.reason === "no-readable-key") {
    issues.push({ code: "no-readable-source-key", context, message: "Answer was revealed but no supported green-border or image key identifies option IDs" });
  }
  const originalAnswer: OriginalAnswer = {
    sourceOccurrenceId: sourceId, value, sourceLabels: selectedLabels, explanation, answerAssetIds,
    provenance: {
      kind: "source-default", source: "examprepper", url: capture.url, capturedAt: capture.capturedAt,
      evidence: selectedLabels.length ? "rendered-green-border" : answerAssetIds.length ? "rendered-answer-image" :
        explanation.length ? "rendered-author-text" : "no-readable-key",
      verification: "not-independently-verified",
    },
  };
  const sourceRevision = digest({
    normalizerVersion: NORMALIZER_VERSION, rawPageSha256: page.sha256,
    questionNumber: number, htmlSha256: sha256(raw.html), originalAnswer,
    commentRevisions: comments.map((comment) => ({ id: comment.id, revision: comment.sourceRevision })),
  });
  const occurrence = SourceOccurrenceSchema.parse({
    schemaVersion: 1, id: sourceId, questionId, sourceRevision,
    source: "examprepper", sourceExamId: "45",
    pageNumber: page.pageNumber, questionNumber: number, heading: raw.heading,
    url: capture.url, title: capture.title, capturedAt: capture.capturedAt,
    sourceLabelToOptionId, sourceOptionOrder: labels,
    commentIds: comments.map((comment) => comment.id), rootCommentIds,
    capture: {
      version: 1, method: "rendered-browser-ui",
      rawPagePath: page.path, rawPageSha256: page.sha256, htmlSha256: sha256(raw.html),
      renderedTextSha256: sha256(raw.renderedText), ...ready, discussionEvidence,
      expectedCommentCount: raw.commentCount, parsedCommentCount: comments.length,
    },
    issues,
  });
  return {
    fingerprint, prompt,
    options: shuffle.allowed ? options.sort((a, b) => a.id.localeCompare(b.id)) : options,
    shuffle, format, multiSelect: multiInstruction.test(plainText(prompt)) || selectedLabels.length > 1,
    occurrence, originalAnswer, comments, uses,
  };
}

export function collectionDigest(records: { id: string }[]): string {
  return digest([...records].sort((a, b) => a.id.localeCompare(b.id)).map((record) => ({
    id: record.id, sha256: sha256(jsonFile(record)),
  })));
}

export function computeCoverage(
  pages: RawPageMetadata[], expected: { pages: number; occurrences: number; pageSize: number },
): Coverage {
  const pageNumbers = new Set(pages.map((page) => page.pageNumber));
  const questionNumbers = new Set(pages.flatMap((page) => page.questionNumbers));
  const missingPages = Array.from({ length: expected.pages }, (_, index) => index + 1).filter((number) => !pageNumbers.has(number));
  const missingQuestionNumbers = Array.from({ length: expected.occurrences }, (_, index) => index + 1).filter((number) => !questionNumbers.has(number));
  return CoverageSchema.parse({
    expectedPages: expected.pages, expectedOccurrences: expected.occurrences, pageSize: expected.pageSize,
    actualPages: pages.length, actualOccurrences: questionNumbers.size, missingPages, missingQuestionNumbers,
    complete: missingPages.length === 0 && missingQuestionNumbers.length === 0 &&
      pageNumbers.size === expected.pages && questionNumbers.size === expected.occurrences,
  });
}

export function normalizeCaptures(
  inputs: CaptureInput[], options: NormalizationOptions = {},
): NormalizedDataset {
  const expected = options.expected ?? EXPECTED_COVERAGE;
  if (![expected.pages, expected.occurrences, expected.pageSize].every((value) => Number.isSafeInteger(value) && value > 0) ||
      Math.ceil(expected.occurrences / expected.pageSize) !== expected.pages) {
    throw new Error("Expected page/occurrence/page-size coverage is inconsistent");
  }
  const assetDirectory = options.assetDirectory ?? ".data/assets";
  const assetRegistry = new AssetRegistry();
  const rawPages: RawPageMetadata[] = [];
  const assetIssues: CaptureIssue[] = [];
  const parsed: ParsedQuestion[] = [];
  const seenPages = new Set<number>();
  const seenNumbers = new Set<number>();
  for (const input of [...inputs].sort((a, b) => a.path.localeCompare(b.path))) {
    let json: unknown;
    try { json = JSON.parse(input.content) as unknown; }
    catch (error) { fail(input.path, `invalid capture JSON: ${error instanceof Error ? error.message : String(error)}`); }
    const result = RawCaptureSchema.safeParse(json);
    if (!result.success) fail(input.path, `capture schema validation failed: ${result.error.message}`);
    const capture = result.data;
    const match = capture.url.match(/^https:\/\/www\.examprepper\.co\/exam\/45\/(\d+)\/?$/);
    if (!match) fail(input.path, `unexpected rendered source URL ${capture.url}`);
    const pageNumber = Number(match[1]);
    if (pageNumber < 1 || pageNumber > expected.pages) fail(input.path, `unexpected page number ${pageNumber}`);
    const filename = input.path.split("/").at(-1);
    if (filename !== `page-${String(pageNumber).padStart(3, "0")}.json`) {
      fail(input.path, `capture URL page ${pageNumber} does not match the numbered filename`);
    }
    if (seenPages.has(pageNumber)) fail(input.path, `duplicate captured page ${pageNumber}`);
    seenPages.add(pageNumber);
    const firstNumber = (pageNumber - 1) * expected.pageSize + 1;
    const count = Math.min(expected.pageSize, expected.occurrences - firstNumber + 1);
    const actualNumbers = capture.questions.map((question) => Number(question.heading.slice("Question ".length)));
    if (capture.questions.length !== count ||
        actualNumbers.some((number, index) => number !== firstNumber + index)) {
      fail(input.path, `expected questions ${firstNumber}–${firstNumber + count - 1} in order, found ${actualNumbers.join(", ")}`);
    }
    for (const number of actualNumbers) {
      if (seenNumbers.has(number)) fail(input.path, `duplicate source occurrence Question ${number}`);
      seenNumbers.add(number);
    }
    const page: RawPageMetadata = {
      path: input.path, sha256: sha256(input.content), pageNumber,
      capturedAt: capture.capturedAt, questionNumbers: actualNumbers,
    };
    rawPages.push(page);
    const pageAssets = new Map<string, CapturedAsset>();
    for (const rawAsset of capture.assets) {
      if (pageAssets.has(rawAsset.url)) fail(input.path, `duplicate captured asset URL ${rawAsset.url}`);
      const asset = assetRegistry.add(rawAsset, assetDirectory, `${input.path} / asset ${rawAsset.url}`);
      pageAssets.set(rawAsset.url, asset);
      const declared = rawAsset.contentType.split(";")[0]!.trim().toLowerCase();
      if (declared !== asset.metadata.contentType) assetIssues.push({
        code: "captured-mime-mismatch", context: `${input.path} / asset ${rawAsset.url}`,
        message: `Captured response declared ${rawAsset.contentType}; verified signature/dimensions identify ${asset.metadata.contentType}. Bytes retained unchanged as ${asset.metadata.filePath}.`,
      });
    }
    for (const rawQuestion of capture.questions) parsed.push(parseQuestion(capture, rawQuestion, page, pageAssets));
  }
  rawPages.sort((a, b) => a.pageNumber - b.pageNumber);
  parsed.sort((a, b) => a.occurrence.questionNumber - b.occurrence.questionNumber);
  const groups = new Map<string, ParsedQuestion[]>();
  for (const question of parsed) {
    const group = groups.get(question.fingerprint) ?? [];
    group.push(question);
    groups.set(question.fingerprint, group);
  }
  const questions: Question[] = [];
  const answers: AnswerRecord[] = [];
  const occurrences: SourceOccurrence[] = [];
  const comments: Comment[] = [];
  for (const [fingerprint, group] of groups) {
    const first = group[0]!;
    const id = `q_${fingerprint}`;
    const sourceOccurrenceIds = group.map((member) => member.occurrence.id);
    const sourceRevision = digest({
      normalizerVersion: NORMALIZER_VERSION, fingerprint,
      occurrences: group.map((member) => ({ id: member.occurrence.id, revision: member.occurrence.sourceRevision })),
    });
    const originalAnswers = group.map((member) => member.originalAnswer);
    const originalKeysConflict = new Set(originalAnswers.map((answer) => canonicalJson(answer.value))).size > 1;
    const answerAssets = [...new Set(originalAnswers.flatMap((answer) => answer.answerAssetIds))].sort();
    let value: AnswerValue = first.originalAnswer.value;
    let basis: AnswerRecord["effectiveAnswer"]["basis"] = "source-default";
    if (originalKeysConflict) {
      value = { kind: "manual", reason: "conflicting-source-keys", sourceAnswerAssetIds: answerAssets };
      basis = "source-conflict";
    } else if (first.format === "manual") {
      value = { kind: "manual", reason: first.options.length ? "conversion-pending" : answerAssets.length ? "image-only" : "non-choice-format", sourceAnswerAssetIds: answerAssets };
      basis = "manual-required";
    } else if (first.shuffle.reasons.includes("duplicate-option-content")) {
      value = { kind: "manual", reason: "ambiguous-options", sourceAnswerAssetIds: answerAssets };
      basis = "manual-required";
    } else if (value.kind === "manual") {
      basis = "manual-required";
    }
    const question = QuestionSchema.parse({
      schemaVersion: 1, id, exam: "AZ-104", fingerprint, sourceRevision,
      kind: first.format === "manual" ? "manual" : group.some((member) => member.multiSelect) ? "multi-select" : "single-select",
      prompt: first.prompt, options: first.options, shuffle: first.shuffle,
      sourceOccurrenceIds,
      assetIds: [...new Set(group.flatMap((member) => member.uses.map((use) => use.assetId)))].sort(),
      commentCount: group.reduce((sum, member) => sum + member.comments.length, 0),
      review: pendingReview(),
      conversion: first.format === "manual"
        ? { status: "pending", reason: "Rendered non-choice/image answer requires a human-authored conversion overlay" }
        : { status: "not-required", reason: null },
      readiness: { content: "complete", grading: value.kind === "option-selection" ? "automatic" : "manual", publication: "blocked-review" },
      published: false,
    });
    const answer = AnswerRecordSchema.parse({
      schemaVersion: 1, id, questionId: id, sourceRevision, originalAnswers, originalKeysConflict,
      effectiveAnswer: { value, basis, sourceOccurrenceIds, verification: "not-independently-verified" },
      review: pendingReview(), published: false,
    });
    assertAnswerOptionIds(question, answer.effectiveAnswer.value, `${id} effective answer`);
    for (const original of originalAnswers) assertAnswerOptionIds(question, original.value, `${original.sourceOccurrenceId} original answer`);
    questions.push(question);
    answers.push(answer);
    for (const member of group) {
      occurrences.push(member.occurrence);
      comments.push(...member.comments);
      for (const use of member.uses) assetRegistry.use(use.assetId, AssetUseSchema.parse({ ...use.use, questionId: id }));
    }
  }
  for (const records of [questions, answers, occurrences, comments]) records.sort((a, b) => a.id.localeCompare(b.id));
  const assets = assetRegistry.records();
  const records = { questions, answers, occurrences, comments, assets };
  for (const collection of RECORD_COLLECTIONS) {
    const ids = new Set<string>();
    for (const record of records[collection]) {
      if (ids.has(record.id)) throw new Error(`Duplicate internal ${collection} ID ${record.id}`);
      ids.add(record.id);
      assertDocumentSize(record, `${collection}/${record.id}`);
    }
  }
  const sourceRevision = digest({ normalizerVersion: NORMALIZER_VERSION, rawPages });
  const catalog = CatalogSchema.parse({
    schemaVersion: 1, datasetId: DATASET_ID, sourceRevision,
    entries: questions.map((question) => ({
      id: question.id, sourceRevision: question.sourceRevision,
      questionPath: `questions/${question.id}.json`, answerPath: `answers/${question.id}.json`,
      sourceOccurrenceIds: question.sourceOccurrenceIds,
      sourceQuestionNumbers: occurrences.filter((occurrence) => occurrence.questionId === question.id)
        .map((occurrence) => occurrence.questionNumber).sort((a, b) => a - b),
      kind: question.kind, commentCount: question.commentCount,
      conversionStatus: question.conversion.status, reviewStatus: question.review.status, published: false,
    })),
  });
  const manifest = ManifestSchema.parse({
    schemaVersion: 1, datasetId: DATASET_ID, normalizerVersion: NORMALIZER_VERSION,
    importId: `import_${sourceRevision}`, sourceRevision, sourceMethod: "rendered-browser-ui",
    coverage: computeCoverage(rawPages, expected), rawPages,
    records: Object.fromEntries(RECORD_COLLECTIONS.map((name) => [name, records[name].length])),
    recordDigests: Object.fromEntries(RECORD_COLLECTIONS.map((name) => [name, collectionDigest(records[name])])),
    catalogSha256: sha256(jsonFile(catalog)),
    duplicateGroups: questions.filter((question) => question.sourceOccurrenceIds.length > 1).length,
    mergedOccurrences: occurrences.length - questions.length,
    conflictingOriginalKeys: answers.filter((answer) => answer.originalKeysConflict).length,
    conversionPending: questions.filter((question) => question.conversion.status === "pending").length,
    reviewPending: questions.filter((question) => question.review.status === "pending").length,
    issues: [...assetIssues, ...occurrences.flatMap((occurrence) => occurrence.issues)],
  });
  return { ...records, catalog, manifest, assetRegistry };
}
