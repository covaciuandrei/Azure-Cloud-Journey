import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { load } from "cheerio";
import type { AnyNode, Element } from "domhandler";
import { z } from "zod";
import {
  Sc900DocumentSchema, Sc900DiscussionSchema, Sc900CommentSchema,
  type Sc900Document, type Sc900Discussion, type Sc900Comment, type Sc900Question,
} from "../../src/domain/sc900Bank.js";
import {
  SC900_EXAM_ID, Sc900CaptureLedgerSchema, sc900OccurrenceId,
  type Sc900CaptureLedger, type Sc900CaptureAsset,
} from "../../src/domain/sc900Capture.js";
import { richAssetIds, type AnswerValue, type RichContent } from "../../src/domain/schemas.js";
import { mediaExtension } from "../../src/domain/cleanBank.js";
import { decodeCapturedAsset } from "../ingest/normalize-assets.js";
import { shufflePolicy } from "../ingest/normalize-core.js";
import { parseRichContent, textContent } from "../ingest/normalize-html.js";
import {
  RawCaptureSchema, RawQuestionSchema, plainText, safeUrl, type RawAsset,
} from "../ingest/normalize-shared.js";
import {
  byteSha256, canonicalJson, sc900Hash, sc900OptionId, sc900QuestionId, sc900SourceRevision,
} from "./canonical.js";

const NORMALIZER_VERSION = "sc900-rendered-ui-2";
const MAX_PAGE_BYTES = 32 * 1024 * 1024;
const MAX_INPUT_BYTES = 256 * 1024 * 1024;
const MAX_ASSET_BYTES = 16 * 1024 * 1024;
const PAGE_SIZE = 5;
const RawSc900QuestionSchema = RawQuestionSchema.extend({
  html: z.string().min(1).max(2 * 1024 * 1024),
  commentCount: z.number().int().min(0).max(10000),
  discussionLoad: z.object({
    status: z.enum(["loaded", "rendered-only", "loading", "receiving", "failed", "not-requested"]),
    httpStatus: z.number().int().optional(),
    error: z.string().optional(),
    reason: z.string().optional(),
  }).passthrough().optional(),
});
const RawSc900CaptureSchema = RawCaptureSchema.extend({
  examId: z.union([z.literal(128), z.literal("128"), z.literal("sc900")]).optional(),
  questions: z.array(RawSc900QuestionSchema).min(1).max(PAGE_SIZE),
  completion: z.object({ status: z.string() }).passthrough().optional(),
});
type RawQuestion = z.infer<typeof RawSc900QuestionSchema>;
type RawCapture = z.infer<typeof RawSc900CaptureSchema>;

export interface Sc900CaptureInput { path: string; content: string }
export interface Sc900NormalizationOptions {
  draft?: boolean;
  /** Observed source totals, never the number of files in a partial capture. */
  expected?: { pages: number; occurrences: number };
}
export interface Sc900NormalizationIssue {
  examId: "sc900";
  severity: "error" | "warning";
  code: string;
  context: string;
  message: string;
}
export interface Sc900DraftOccurrence {
  examId: "sc900";
  id: string;
  questionNumber: number;
  pageNumber: number;
  url: string;
  rawPath: string;
  rawSha256: string;
  htmlSha256: string;
  renderedTextSha256: string;
  questionId: string | null;
  answerRevealed: boolean;
  answerEvidence: "green-border" | "marked-manual-answer" | "unreadable";
  sourceLabelToOptionId: Record<string, string>;
  sourceOptionOrder: string[];
  fixedOptionOrder: string[];
  selectedSourceLabels: string[];
  choiceStyles: RawQuestion["choiceStyles"];
  discussionState: NonNullable<RawQuestion["discussionLoad"]>["status"] | "unobserved";
  discussionHttpStatus: number | null;
  discussionDetail: string | null;
  discussionVerified: boolean;
  capturedDomCommentCount: number;
  parsedCommentCount: number | null;
  confirmedCommentCount: number | null;
  commentIds: string[];
  assetIds: string[];
  skippedAvatarCount: number;
}
export interface Sc900DraftAsset extends Sc900CaptureAsset {
  examId: "sc900";
  sourceUrls: string[];
  sourceResponses: {
    url: string;
    declaredContentType: string;
    detectedContentType: Sc900CaptureAsset["contentType"];
  }[];
  base64: string;
}
export interface Sc900NormalizationResult {
  schemaVersion: 1;
  examId: "sc900";
  normalizerVersion: string;
  publicationState: "blocked-independent-review";
  observedSourceTotals: { pages: number; occurrences: number } | null;
  draftSourceRevision: string;
  draftReleaseId: string;
  draftDocuments: Sc900Document[];
  draftDiscussions: Sc900Discussion[];
  draftOccurrences: Sc900DraftOccurrence[];
  draftAssets: Sc900DraftAsset[];
  issues: Sc900NormalizationIssue[];
  verifiedCaptureLedger: Sc900CaptureLedger | null;
  counts: {
    observedPages: number;
    observedOccurrences: number;
    normalizedOccurrences: number;
    canonicalQuestions: number;
    duplicatesGrouped: number;
    parsedComments: number;
    confirmedComments: number | null;
  };
}
export class Sc900NormalizationError extends Error {
  constructor(readonly result: Sc900NormalizationResult) {
    super(`SC900 capture is incomplete: ${result.issues.filter((issue) => issue.severity === "error")
      .map((issue) => `${issue.context}: ${issue.message}`).join("; ")}`);
    this.name = "Sc900NormalizationError";
  }
}
class CaptureParseError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
function requireCapture(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new CaptureParseError(code, message);
}
const sortedUnique = (values: string[]) => [...new Set(values)].sort();
const displayText = (value: string) => value.replace(/\s+/gu, " ").trim();
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const manualFormat = /\b(?:DRAG\s*DROP|HOT\s*(?:SPOT|AREA)|Select\s+and\s+Place|answer\s+by\s+dragging|select\s+(?:the\s+)?(?:appropriate|correct)\s+options?\s+in\s+the\s+answer\s+area)\b/i;
const multiFormat = /\b(?:choose|select|which)\s+(?:two|three|four|five|six|\d+|all)\b|\beach\s+correct\s+answer\s+(?:presents|is)\b/i;
const expansionControl = /^(?:show answer|load more|show more|more comments|load more comments|show more comments|show replies|\[\+\])(?:\s*\(\d+\))?$/i;
const commentSelector = "ul.chakra-wrap__list";

interface Page {
  capture: RawCapture;
  input: Sc900CaptureInput;
  pageNumber: number;
  rawSha256: string;
  questionNumbers: number[];
}
interface ParsedQuestion {
  kind: Sc900Question["kind"];
  prompt: RichContent;
  options: Sc900Question["options"];
  fixedOptionOrder: string[];
  shuffle: Sc900Question["shuffle"];
  originalAnswer: Sc900Document["answers"]["originalAnswers"][number];
  comments: Sc900Comment[];
  occurrence: Sc900DraftOccurrence;
}
type Report = (code: string, context: string, message: string, severity?: "error" | "warning") => void;

function sourceBorder(color: string, width: string): "selected" | "ordinary" | null {
  const match = color.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*(1(?:\.0+)?))?\s*\)$/i);
  const widths = width.trim().split(/\s+/);
  if (!match || widths.length > 4 || !widths.every((part) => /^\d+(?:\.\d+)?px$/.test(part))) return null;
  const rgb = match.slice(1, 4).map(Number).join(",");
  if (rgb === "104,211,145" && widths.every((part) => Number.parseFloat(part) > 0)) return "selected";
  return rgb === "255,255,255" ? "ordinary" : null;
}

function withoutImages(content: RichContent): RichContent {
  return content.filter((block) => block.type !== "image").map((block) => {
    if (block.type === "quote") return { ...block, blocks: withoutImages(block.blocks) };
    if (block.type === "list") return { ...block, items: block.items.map(withoutImages) };
    if (block.type === "table") return {
      ...block, rows: block.rows.map((row) => ({
        cells: row.cells.map((cell) => ({ ...cell, blocks: withoutImages(cell.blocks) })),
      })),
    };
    return block;
  });
}

function parseQuestion(
  page: Page, raw: RawQuestion, occurrence: Sc900DraftOccurrence,
  registry: Map<string, Sc900DraftAsset>, report: Report,
): ParsedQuestion {
  const context = `${page.input.path} / ${raw.heading}`;
  const $ = load(raw.html, undefined, false);
  const check: typeof requireCapture = requireCapture;
  check($(".chakra-accordion__item").length === 1 && $(".chakra-accordion__panel").length === 1 &&
    $(".chakra-accordion__button").length === 1 &&
    $(".chakra-accordion__button").text().trim() === raw.heading,
  "question-layout", "Expected one rendered Chakra question, panel and matching heading");
  const panel = $(".chakra-accordion__panel");
  check(!panel.contents().toArray().some((node) => node.type === "text" && node.data.trim()),
    "unparsed-panel-content", "Visible text outside recognized prompt, answer and discussion sections requires explicit parsing");
  const sections = panel.children().toArray();
  const questionSection = sections[0];
  check(questionSection && sections[1] && /^(?:Hide|Show) Answer$/.test($(sections[1]).text().trim()),
    "question-layout", "Unexpected prompt/answer-control layout");
  // These checks describe acquisition only. A verified ledger is not a reviewed answer bank.
  const hideControls = $("button").filter((_, node) => $(node).text().trim() === "Hide Answer");
  occurrence.answerRevealed = raw.answerRevealed === true && hideControls.length === 1;
  if (!occurrence.answerRevealed) report("answer-not-revealed", context, "Explicit answerRevealed=true and one Hide Answer control are required");
  const remaining = $("button,a").filter((_, node) => expansionControl.test($(node).text().trim()))
    .map((_, node) => $(node).text().trim()).get();
  if (raw.remainingControls.length || remaining.length) {
    report("unexpanded-controls", context, `Unexpanded controls: ${sortedUnique([...raw.remainingControls, ...remaining]).join(", ")}`);
  }
  const loading = (raw.loadingIndicators ?? 0) > 0 || $(".chakra-spinner,[role=progressbar]").length > 0;
  if (loading) report("content-loading", context, "Loading indicators remain in the capture");
  const httpStatus = raw.discussionLoad?.httpStatus;
  const loaded = raw.discussionLoad?.status === "loaded" &&
    httpStatus !== undefined && httpStatus >= 200 && httpStatus < 300 &&
    !raw.discussionLoad.error && !loading && !raw.remainingControls.length && !remaining.length;
  if (!loaded) {
    report("discussion-unverified", context,
      `Discussion ${occurrence.discussionState}, HTTP ${httpStatus ?? "unobserved"}; its displayed count is not confirmed, including zero`);
  }
  const imageElements = $("img").toArray();
  check(imageElements.length === raw.images.length, "image-count",
    `DOM has ${imageElements.length} images but capture metadata has ${raw.images.length}`);
  const imageMap = new Map<Element, { id: string; width: number; height: number; alt: string }>();
  const usedImages = new Set<Element>();
  const assetsByUrl = new Map<string, RawAsset>();
  for (const asset of page.capture.assets) {
    check(!assetsByUrl.has(asset.url), "duplicate-asset-url", `Repeated asset URL ${asset.url}`);
    assetsByUrl.set(asset.url, asset);
  }
  imageElements.forEach((element, index) => {
    const thread = $(element).parents(commentSelector).first();
    const header = thread.children().first();
    const inHeader = header.length > 0 && $(element).parents().toArray().includes(header[0]!);
    if (inHeader && ($(element).hasClass("chakra-avatar__img") || $(element).parents(".chakra-avatar").length > 0)) {
      usedImages.add(element);
      occurrence.skippedAvatarCount++;
      return;
    }
    const image = raw.images[index]!;
    check(image.loaded && image.width > 0 && image.height > 0, "image-unloaded", `Required image ${index} is not loaded`);
    const domSrc = element.attribs.src;
    check(domSrc && safeUrl(domSrc, page.capture.url) &&
      safeUrl(domSrc, page.capture.url) === safeUrl(image.src ?? "", page.capture.url) &&
      (element.attribs.alt ?? "") === image.alt,
    "image-metadata", `Image ${index} src/alt differs from the captured DOM`);
    const knownUrls = [safeUrl(domSrc!, page.capture.url), ...(element.attribs.srcset ?? "")
      .split(",").filter(Boolean).map((item) => safeUrl(item.trim().split(/\s+/)[0]!, page.capture.url))];
    check(knownUrls.includes(image.currentSrc), "image-source-url", `Image ${index} currentSrc was not declared in the captured DOM`);
    const rawAsset = assetsByUrl.get(image.currentSrc);
    check(rawAsset, "missing-image", `Missing original bytes for ${image.currentSrc}`);
    check(rawAsset.byteLength <= MAX_ASSET_BYTES && rawAsset.base64.length <= Math.ceil(MAX_ASSET_BYTES / 3) * 4,
      "image-size", "Captured image exceeds the 16 MiB safety limit");
    let decoded: ReturnType<typeof decodeCapturedAsset>;
    try {
      decoded = decodeCapturedAsset(rawAsset, ".data/sc900/normalized/assets", context);
    } catch (error) {
      throw new CaptureParseError("invalid-image", errorText(error));
    }
    check(decoded.metadata.width === image.width && decoded.metadata.height === image.height,
      "image-dimensions", `Captured dimensions disagree with bytes: ${image.currentSrc}`);
    if (decoded.metadata.validation.mime !== "matched") {
      report("image-mime", context,
        `Declared ${rawAsset.contentType} disagrees with byte-detected ${decoded.metadata.contentType}: ${image.currentSrc}; original bytes retained for draft review only, capture verification blocked`);
    }
    const id = byteSha256(decoded.bytes);
    const previous = registry.get(id);
    const response = {
      url: image.currentSrc, declaredContentType: rawAsset.contentType, detectedContentType: decoded.metadata.contentType,
    };
    const sourceResponses = [...(previous?.sourceResponses ?? [])];
    if (!sourceResponses.some((item) => item.url === response.url &&
      item.declaredContentType === response.declaredContentType && item.detectedContentType === response.detectedContentType)) {
      sourceResponses.push(response);
    }
    sourceResponses.sort((a, b) => a.url.localeCompare(b.url) ||
      a.declaredContentType.localeCompare(b.declaredContentType) || a.detectedContentType.localeCompare(b.detectedContentType));
    const asset: Sc900DraftAsset = {
      examId: SC900_EXAM_ID, id, contentType: decoded.metadata.contentType,
      width: decoded.metadata.width, height: decoded.metadata.height, byteLength: decoded.bytes.length,
      sourceUrls: sortedUnique([...(previous?.sourceUrls ?? []), image.currentSrc]), sourceResponses,
      base64: decoded.bytes.toString("base64"),
    };
    registry.set(id, asset);
    imageMap.set(element, { id, width: image.width, height: image.height, alt: image.alt });
  });
  const rich = (nodes: AnyNode[], label: string, ignore?: ReadonlySet<AnyNode>): RichContent => {
    try {
      return parseRichContent($, nodes, {
        baseUrl: page.capture.url, context: `${context} / ${label}`,
        ...(ignore ? { ignore } : {}),
        issue: (issue) => report(issue.code, issue.context, issue.message, "warning"),
        image: (element) => {
          const image = imageMap.get(element);
          requireCapture(image && !usedImages.has(element), "image-role", `Unindexed or multiply assigned image in ${label}`);
          usedImages.add(element);
          return { type: "image", assetId: image.id, alt: image.alt, width: image.width, height: image.height };
        },
      });
    } catch (error) {
      if (error instanceof CaptureParseError) throw error;
      throw new CaptureParseError("unsupported-rich-content", errorText(error));
    }
  };
  const rows = $(questionSection).find(".chakra-stack").filter((_, row) => {
    const children = $(row).children();
    return children.length === 2 && /^[A-Z]\.$/.test(children.first().text().trim());
  }).toArray();
  check(!rows.some((row) => $(row).parents().toArray().some((ancestor) => rows.includes(ancestor))),
    "choice-layout", "Nested labeled options are ambiguous");
  const labels = rows.map((row) => $(row).children().first().text().trim().slice(0, -1));
  const styles = new Map(raw.choiceStyles.map((style) => [style.label, style]));
  check(new Set(labels).size === labels.length && styles.size === raw.choiceStyles.length &&
    [...styles.keys()].sort().join() === [...labels].sort().join(),
  "choice-styles", "Captured choice styles must match every DOM option label exactly once");
  const prompt = rich(questionSection.children, "prompt", new Set(rows));
  check(plainText(prompt).trim() || richAssetIds(prompt).length, "empty-prompt", "Required prompt is empty");
  const options = rows.map((row, index) => {
    const content = rich($(row).children().eq(1).contents().toArray(), `option ${labels[index]}`);
    check(plainText(content).trim() || richAssetIds(content).length, "empty-option", "Required option is empty");
    check(displayText(plainText(withoutImages(content))) === displayText(styles.get(labels[index]!)!.text),
      "choice-style-text", `Captured style text differs from option ${labels[index]}`);
    return { id: sc900OptionId(content), content };
  });
  check(new Set(options.map((option) => option.id)).size === options.length,
    "ambiguous-options", "Identical option content cannot be assigned distinct canonical IDs without manual conversion");
  occurrence.sourceOptionOrder = labels;
  occurrence.sourceLabelToOptionId = Object.fromEntries(options.map((option, index) => [labels[index]!, option.id]));
  let readableStyles = true;
  const selectedLabels = labels.filter((label) => {
    const style = styles.get(label)!;
    const state = sourceBorder(style.borderColor, style.borderWidth);
    if (!state) {
      readableStyles = false;
      report("unknown-answer-style", context, `Option ${label} has unrecognized computed border ${style.borderColor} / ${style.borderWidth}; no key inferred`);
    }
    return state === "selected";
  });
  occurrence.selectedSourceLabels = selectedLabels;
  const manual = !options.length || manualFormat.test(plainText(prompt));
  const kind = manual ? "manual" : multiFormat.test(plainText(prompt)) || selectedLabels.length > 1 ? "multi-select" : "single-select";
  const parenthesizedReference = [prompt, ...options.map((option) => option.content)]
    .some((content) => /\(\s*[A-Z]\s*\)/.test(plainText(content)));
  const shuffle = { allowed: !manual && !parenthesizedReference && shufflePolicy(prompt, options.map((option) => ({
    ...option, contentHash: sc900Hash("option", option.content),
  }))).allowed };
  const fixedOptionOrder = options.map((option) => option.id);
  occurrence.fixedOptionOrder = fixedOptionOrder;
  if (shuffle.allowed) options.sort((a, b) => a.id.localeCompare(b.id));
  const questionId = sc900QuestionId({ kind, prompt, options });
  const allComments = $(commentSelector).toArray();
  check(allComments.length === raw.commentCount, "comment-count",
    `Captured DOM count ${raw.commentCount} differs from actual comment elements ${allComments.length}`);
  const explanation: RichContent = [];
  let markedAnswer = false;
  for (const section of sections.slice(2)) {
    const markers = $(section).find("b,strong,p").filter((_, node) =>
      $(node).text().trim() === "Correct answer:" && !$(node).parents(commentSelector).length).toArray();
    if ($(section).is(commentSelector) || $(section).find(commentSelector).length) {
      check(markers.length === 0, "mixed-discussion", "Mixed author answer and discussion needs explicit parsing");
      const clone = $(section).clone();
      clone.find(commentSelector).remove();
      if (!$(section).is(commentSelector)) {
        check(!clone.text().replaceAll("[-]", "").trim(), "unparsed-discussion", "Unrecognized content outside comment threads");
      }
      continue;
    }
    if (!$(section).find("img").length &&
      /^(?:no comments(?: yet)?|no discussions?(?: yet)?|be the first to comment)[.!]?$/i.test($(section).text().trim())) continue;
    check(markers.length || !$(section).text().trim() && !$(section).find("img").length,
      "unknown-answer-section", "Unrecognized content after the answer controls requires explicit parsing");
    markedAnswer ||= markers.length > 0;
    explanation.push(...rich([section], "source answer", new Set(markers)));
  }
  check(allComments.every((element) => sections.slice(2).some((section) =>
    section === element || $(element).parents().toArray().includes(section))),
  "comment-scope", "Comment found outside the discussion sections");
  const comments: Sc900Comment[] = [];
  const visited = new Set<Element>();
  const parseComment = (element: Element, treePath: number[], parentId: string | null, rootId: string | null): string => {
    check(!visited.has(element) && treePath.length <= 64, "comment-ancestry", "Repeated comment or excessive thread depth");
    visited.add(element);
    const children = $(element).children();
    check(children.length === 3, "comment-layout", "Expected comment header/body/replies children");
    const header = children.eq(0);
    const authorNodes = header.children("b");
    const timeNodes = header.children("span").not(".chakra-avatar");
    check(authorNodes.length === 2 && timeNodes.length === 1, "comment-header", "Ambiguous author/vote/displayed-timestamp header");
    const headerRemainder = header.clone();
    headerRemainder.children("b,span").remove();
    check(!headerRemainder.text().trim(), "comment-header", "Unrecognized comment header content or controls");
    const author = authorNodes.eq(0).text().trim();
    const voteText = authorNodes.eq(1).text().trim();
    const displayedTimestamp = timeNodes.text().trim();
    const match = voteText.match(/^([+-]?\d[\d,]*)\s+points?$/);
    const votes = match ? Number(match[1]!.replaceAll(",", "")) : NaN;
    check(author && displayedTimestamp && Number.isSafeInteger(votes), "comment-header", "Unreadable author, timestamp or vote count");
    const bodyNodes = children.eq(1).contents().toArray();
    const nested = children.eq(2).find(commentSelector).filter((_, reply) =>
      $(reply).parents(commentSelector).first()[0] === element).toArray();
    const repliesRemainder = children.eq(2).clone();
    repliesRemainder.find(commentSelector).remove();
    check(!repliesRemainder.text().replaceAll("[-]", "").trim() && !repliesRemainder.find("img").length,
      "comment-loss", "Unrecognized content outside parsed replies");
    const invalidChildren = children.eq(1).find(commentSelector).length + header.find(commentSelector).length;
    check(!invalidChildren, "comment-ancestry", "Nested thread outside the replies container");
    const body = rich(bodyNodes, `comment ${treePath.join(".")}`);
    const bodyTextContent = textContent(bodyNodes);
    const id = `c_${sc900Hash("comment", { sourceOccurrenceId: occurrence.id, treePath, author, body })}`;
    const comment = Sc900CommentSchema.parse({
      schemaVersion: 1, examId: SC900_EXAM_ID, id, questionId, sourceOccurrenceId: occurrence.id,
      sourceRevision: sc900Hash("comment-source", {
        id, rawSha256: page.rawSha256, body, bodyTextContent, voteText, votes, displayedTimestamp,
      }),
      sourceCommentId: null, sourceCreatedAt: null, author, votes, voteText, displayedTimestamp,
      capturedAt: page.capture.capturedAt, bodyText: plainText(body), bodyTextContent, body,
      parentId, rootId: rootId ?? id, childIds: [], treePath, trust: "untrusted-source-content",
    });
    comments.push(comment);
    nested.forEach((reply, index) => comment.childIds.push(parseComment(reply, [...treePath, index], id, comment.rootId)));
    return id;
  };
  const roots = allComments.filter((element) => $(element).parents(commentSelector).length === 0);
  roots.forEach((element, index) => parseComment(element, [index], null, null));
  check(visited.size === allComments.length && comments.length === raw.commentCount,
    "comment-loss", "Parsed discussion did not retain every captured comment");
  check(usedImages.size === imageElements.length, "unassigned-image", "A required DOM image was not assigned a content role");
  const answerAssetIds = sortedUnique(richAssetIds(explanation));
  let value: AnswerValue = { kind: "manual", reason: "no-readable-key", sourceAnswerAssetIds: answerAssetIds };
  if (occurrence.answerRevealed && readableStyles) {
    if (selectedLabels.length) {
      value = { kind: "option-selection", optionIds: selectedLabels.map((label) => occurrence.sourceLabelToOptionId[label]!).sort() };
      occurrence.answerEvidence = "green-border";
    } else if (markedAnswer && (answerAssetIds.length || plainText(explanation).trim())) {
      value = { kind: "manual", reason: answerAssetIds.length ? "image-only" : "non-choice-format", sourceAnswerAssetIds: answerAssetIds };
      occurrence.answerEvidence = "marked-manual-answer";
    }
  }
  if (occurrence.answerEvidence === "unreadable") report("no-readable-key", context, "No revealed, supported original answer evidence; manual draft only");
  occurrence.questionId = questionId;
  occurrence.parsedCommentCount = comments.length;
  occurrence.commentIds = comments.map((comment) => comment.id);
  occurrence.discussionVerified = loaded;
  occurrence.confirmedCommentCount = loaded ? comments.length : null;
  occurrence.assetIds = sortedUnique([...imageMap.values()].map((image) => image.id));
  return {
    kind, prompt, options, fixedOptionOrder, shuffle, comments, occurrence,
    originalAnswer: {
      sourceOccurrenceId: occurrence.id, value, explanation, answerAssetIds,
      provenance: { source: "examprepper", url: page.capture.url },
    },
  };
}

/** Normalize private UI captures only. Even complete acquisition remains provisional until independent review. */
export function normalizeSc900Captures(
  inputs: Sc900CaptureInput[], options: Sc900NormalizationOptions = {},
): Sc900NormalizationResult {
  if (inputs.length > 10000 || inputs.reduce((sum, input) => sum + Buffer.byteLength(input.content), 0) > MAX_INPUT_BYTES) {
    throw new Error("SC900 capture inputs exceed the bounded 10000-page / 256 MiB input limit");
  }
  if (options.expected && (![options.expected.pages, options.expected.occurrences].every((n) =>
    Number.isSafeInteger(n) && n > 0 && n <= 999999) ||
    Math.ceil(options.expected.occurrences / PAGE_SIZE) !== options.expected.pages)) {
    throw new Error("Observed SC900 totals must be positive integers consistent with the five-question page layout");
  }
  const issues: Sc900NormalizationIssue[] = [];
  const report: Report = (code, context, message, severity = "error") =>
    issues.push({ examId: SC900_EXAM_ID, severity, code, context, message });
  if (!options.expected) report("unobserved-totals", "coverage", "Explicit observed total pages and occurrences are required for a verified ledger");
  if (!inputs.length) report("empty-input", "coverage", "No rendered captures were supplied");
  const pages: Page[] = [];
  const seenPages = new Set<number>();
  for (const input of [...inputs].sort((a, b) => a.path.localeCompare(b.path))) {
    if (Buffer.byteLength(input.content) > MAX_PAGE_BYTES) {
      report("page-size", input.path, "Capture exceeds the 32 MiB per-page safety limit");
      continue;
    }
    let json: unknown;
    try { json = JSON.parse(input.content) as unknown; }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      report("invalid-json", input.path, error.message);
      continue;
    }
    const parsed = RawSc900CaptureSchema.safeParse(json);
    if (!parsed.success) { report("capture-schema", input.path, parsed.error.message); continue; }
    const capture = parsed.data;
    const match = capture.url.match(/^https:\/\/www\.examprepper\.co\/exam\/128\/([1-9]\d*)\/?$/);
    const pageNumber = match ? Number(match[1]) : NaN;
    if (!Number.isSafeInteger(pageNumber) || pageNumber > 999999) {
      report("source-url", input.path, `Expected the rendered SC900 exam/128 page URL, received ${capture.url}`);
      continue;
    }
    if (basename(input.path) !== `page-${String(pageNumber).padStart(3, "0")}.json`) {
      report("page-filename", input.path, "Filename does not agree with the captured page URL");
    }
    if (seenPages.has(pageNumber)) {
      report("duplicate-page", input.path, `Repeated source page ${pageNumber}`);
      continue;
    }
    seenPages.add(pageNumber);
    const questionNumbers = capture.questions.map((question) => Number(question.heading.slice("Question ".length)));
    if (questionNumbers.some((number) => !Number.isSafeInteger(number) || number < 1 || number > 999999)) {
      report("source-number", input.path, "Question number is outside the SC900 occurrence namespace");
      continue;
    }
    const first = (pageNumber - 1) * PAGE_SIZE + 1;
    const expectedCount = options.expected
      ? Math.min(PAGE_SIZE, options.expected.occurrences - first + 1) : capture.questions.length;
    if (questionNumbers.some((number, index) => number !== first + index) || questionNumbers.length !== expectedCount) {
      report("page-sequence", input.path, `Expected sequential questions starting at ${first}, observed ${questionNumbers.join(", ")}`);
    }
    if (capture.completion && capture.completion.status !== "complete") {
      report("capture-incomplete", input.path, `Capture explicitly declares completion.status=${capture.completion.status}`);
    }
    pages.push({ capture, input, pageNumber, rawSha256: byteSha256(input.content), questionNumbers });
  }
  pages.sort((a, b) => a.pageNumber - b.pageNumber);
  const numbers = pages.flatMap((page) => page.questionNumbers);
  if (options.expected && (pages.length !== options.expected.pages ||
    pages.some((page, index) => page.pageNumber !== index + 1) ||
    numbers.length !== options.expected.occurrences || numbers.some((number, index) => number !== index + 1))) {
    report("incomplete-coverage", "coverage", "All observed source pages and question numbers must be captured sequentially and exactly once");
  }
  const registry = new Map<string, Sc900DraftAsset>();
  const draftOccurrences: Sc900DraftOccurrence[] = [];
  const parsedQuestions: ParsedQuestion[] = [];
  const seenOccurrences = new Set<string>();
  for (const page of pages) {
    for (const raw of page.capture.questions) {
      const questionNumber = Number(raw.heading.slice("Question ".length));
      const occurrence: Sc900DraftOccurrence = {
        examId: SC900_EXAM_ID, id: sc900OccurrenceId(questionNumber), questionNumber, pageNumber: page.pageNumber,
        url: page.capture.url, rawPath: page.input.path, rawSha256: page.rawSha256,
        htmlSha256: byteSha256(raw.html), renderedTextSha256: byteSha256(raw.renderedText),
        questionId: null, answerRevealed: false, answerEvidence: "unreadable",
        sourceLabelToOptionId: {}, sourceOptionOrder: [], fixedOptionOrder: [], selectedSourceLabels: [], choiceStyles: raw.choiceStyles,
        discussionState: raw.discussionLoad?.status ?? "unobserved",
        discussionHttpStatus: raw.discussionLoad?.httpStatus ?? null, discussionVerified: false,
        discussionDetail: raw.discussionLoad?.error ?? raw.discussionLoad?.reason ?? null,
        capturedDomCommentCount: raw.commentCount, parsedCommentCount: null, confirmedCommentCount: null,
        commentIds: [], assetIds: [], skippedAvatarCount: 0,
      };
      draftOccurrences.push(occurrence);
      if (seenOccurrences.has(occurrence.id)) {
        report("duplicate-occurrence", page.input.path, `Repeated source occurrence ${occurrence.id}`);
        continue;
      }
      seenOccurrences.add(occurrence.id);
      try { parsedQuestions.push(parseQuestion(page, raw, occurrence, registry, report)); }
      catch (error) {
        if (!(error instanceof CaptureParseError)) throw error;
        report(error.code, `${page.input.path} / ${raw.heading}`, error.message);
      }
    }
  }
  const referencedAssets = new Set(parsedQuestions.flatMap((question) => question.occurrence.assetIds));
  const draftAssets = [...registry.values()].filter((asset) => referencedAssets.has(asset.id)).sort((a, b) => a.id.localeCompare(b.id));
  let verifiedCaptureLedger: Sc900CaptureLedger | null = null;
  if (options.expected && !issues.some((issue) => issue.severity === "error")) {
    const ledger = Sc900CaptureLedgerSchema.safeParse({
      schemaVersion: 1, examId: SC900_EXAM_ID, sourceExamId: "128",
      captureMethod: "rendered-browser-ui", verified: true,
      sourceUrl: "https://www.examprepper.co/exam/128/1",
      capturedAt: pages.map((page) => page.capture.capturedAt).sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1),
      reported: { questions: options.expected.occurrences, pages: options.expected.pages },
      pages: pages.map((page) => ({
        pageNumber: page.pageNumber, url: page.capture.url, rawSha256: page.rawSha256, questionNumbers: page.questionNumbers,
      })),
      occurrences: draftOccurrences.map((occurrence) => ({
        id: occurrence.id, questionNumber: occurrence.questionNumber, pageNumber: occurrence.pageNumber,
        answerRevealed: occurrence.answerRevealed, discussionState: occurrence.discussionState,
        expectedCommentCount: occurrence.capturedDomCommentCount, parsedCommentCount: occurrence.parsedCommentCount,
        commentIds: occurrence.commentIds, assetIds: occurrence.assetIds,
      })),
      assets: draftAssets.map(({ id, contentType, byteLength, width, height }) => ({ id, contentType, byteLength, width, height })),
    });
    if (ledger.success) verifiedCaptureLedger = ledger.data;
    else report("capture-ledger", "coverage", ledger.error.message);
  }
  const draftSourceRevision = verifiedCaptureLedger ? sc900SourceRevision(verifiedCaptureLedger) :
    sc900Hash("draft-source", {
      normalizerVersion: NORMALIZER_VERSION, expected: options.expected ?? null,
      rawPages: inputs.map((input) => ({ sha256: byteSha256(input.content) })).sort((a, b) => a.sha256.localeCompare(b.sha256)),
    });
  const draftReleaseId = `r_${sc900Hash("draft-release", { normalizerVersion: NORMALIZER_VERSION, sourceRevision: draftSourceRevision })}`;
  const groups = new Map<string, ParsedQuestion[]>();
  for (const question of parsedQuestions) {
    const id = question.occurrence.questionId!;
    const group = groups.get(id) ?? [];
    group.push(question);
    groups.set(id, group);
  }
  const draftDocuments: Sc900Document[] = [];
  const draftDiscussions: Sc900Discussion[] = [];
  for (const [id, group] of groups) {
    const first = group[0]!;
    const comments = group.flatMap((question) => question.comments);
    const originalAnswers = group.map((question) => question.originalAnswer);
    const assetIds = sortedUnique(group.flatMap((question) => question.occurrence.assetIds));
    let value = first.originalAnswer.value;
    if (new Set(originalAnswers.map((answer) => canonicalJson(answer.value))).size > 1) {
      value = { kind: "manual", reason: "conflicting-source-keys", sourceAnswerAssetIds: sortedUnique(originalAnswers.flatMap((answer) => answer.answerAssetIds)) };
      report("conflicting-source-keys", id, "Exact duplicate occurrences retain differing original answers; automatic grading disabled", "warning");
    } else if (first.kind === "manual" && value.kind === "option-selection") {
      value = { kind: "manual", reason: "conversion-pending", sourceAnswerAssetIds: sortedUnique(originalAnswers.flatMap((answer) => answer.answerAssetIds)) };
    }
    draftDocuments.push(Sc900DocumentSchema.parse({
      schemaVersion: 1, examId: SC900_EXAM_ID, releaseId: draftReleaseId,
      question: {
        schemaVersion: 1, examId: SC900_EXAM_ID, id, sourceRevision: draftSourceRevision,
        kind: first.kind, prompt: first.prompt, options: first.options, shuffle: first.shuffle,
        fixedOptionOrder: first.fixedOptionOrder, sourceOccurrenceIds: group.map((question) => question.occurrence.id),
        assetIds, commentCount: comments.length, readiness: { grading: value.kind === "option-selection" ? "automatic" : "manual" },
        media: draftAssets.filter((asset) => assetIds.includes(asset.id)).map(({ base64: _base64, examId: _examId, sourceResponses: _responses, ...asset }) => ({
          ...asset, objectPath: `published/sc900/${draftReleaseId}/assets/${asset.id}.${mediaExtension(asset.contentType)}`,
        })),
        sources: group.map(({ occurrence }) => ({
          questionNumber: occurrence.questionNumber, pageNumber: occurrence.pageNumber, url: occurrence.url,
        })),
      },
      answers: {
        schemaVersion: 1, examId: SC900_EXAM_ID, id, questionId: id, sourceRevision: draftSourceRevision,
        originalAnswers, effectiveAnswer: { value }, provisional: true,
      },
      discussionEnabled: comments.length > 0,
    }));
    draftDiscussions.push(Sc900DiscussionSchema.parse({
      schemaVersion: 1, examId: SC900_EXAM_ID, releaseId: draftReleaseId, questionId: id, comments,
    }));
  }
  const result: Sc900NormalizationResult = {
    schemaVersion: 1, examId: SC900_EXAM_ID, normalizerVersion: NORMALIZER_VERSION,
    publicationState: "blocked-independent-review", observedSourceTotals: options.expected ?? null,
    draftSourceRevision, draftReleaseId,
    draftDocuments, draftDiscussions, draftOccurrences, draftAssets, issues, verifiedCaptureLedger,
    counts: {
      observedPages: pages.length, observedOccurrences: draftOccurrences.length,
      normalizedOccurrences: parsedQuestions.length, canonicalQuestions: draftDocuments.length,
      duplicatesGrouped: parsedQuestions.length - draftDocuments.length,
      parsedComments: parsedQuestions.reduce((sum, question) => sum + question.comments.length, 0),
      confirmedComments: draftOccurrences.length > 0 && draftOccurrences.every((occurrence) => occurrence.discussionVerified)
        ? draftOccurrences.reduce((sum, occurrence) => sum + occurrence.confirmedCommentCount!, 0) : null,
    },
  };
  if (!options.draft && !verifiedCaptureLedger) throw new Sc900NormalizationError(result);
  return result;
}

export interface Sc900NormalizeDirectoryOptions extends Sc900NormalizationOptions {
  workspaceRoot?: string;
  inputDirectory?: string;
  outputDirectory?: string;
}
function privatePath(workspace: string, path: string): string {
  if (path.includes("\\") || path.split("/").some((part) => part === ".." || part === "." || part === "")) {
    throw new Error(`Expected a strict private workspace-relative path: ${path}`);
  }
  const absolute = resolve(workspace, path);
  const local = relative(workspace, absolute).split(sep).join("/");
  if (!local.startsWith(".data/sc900/") || local !== path) throw new Error(`SC900 normalization is restricted to .data/sc900/: ${path}`);
  return absolute;
}
async function noSymlinks(workspace: string, path: string): Promise<void> {
  let current = workspace;
  for (const component of relative(workspace, path).split(sep)) {
    current = resolve(current, component);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`Refusing symbolic link: ${current}`);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
  }
}
async function writeImmutable(path: string, content: string | Buffer): Promise<void> {
  try { await writeFile(path, content, { flag: "wx" }); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || !(await readFile(path)).equals(Buffer.from(content))) {
      throw new Error(`Refusing to overwrite differing or non-regular normalized artifact: ${path}`);
    }
  }
}
export async function normalizeSc900Directory(options: Sc900NormalizeDirectoryOptions = {}): Promise<Sc900NormalizationResult> {
  const workspace = resolve(options.workspaceRoot ?? process.cwd());
  const inputPath = options.inputDirectory ?? ".data/sc900/raw/pages";
  const outputPath = options.outputDirectory ?? ".data/sc900/normalized";
  const input = privatePath(workspace, inputPath);
  const output = privatePath(workspace, outputPath);
  const raw = resolve(workspace, ".data/sc900/raw");
  const overlaps = (a: string, b: string) => a === b || a.startsWith(`${b}${sep}`) || b.startsWith(`${a}${sep}`);
  if (overlaps(input, output) || overlaps(raw, output)) throw new Error("Normalized output must not overlap source captures");
  await noSymlinks(workspace, input);
  await noSymlinks(workspace, output);
  const inputs: Sc900CaptureInput[] = [];
  const entries = await readdir(input, { withFileTypes: true });
  if (entries.length > 10000) throw new Error("SC900 capture directory exceeds the 10000-page safety limit");
  let totalBytes = 0;
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !/^page-\d{3,6}\.json$/.test(entry.name)) throw new Error(`Unexpected capture directory entry: ${entry.name}`);
    const file = resolve(input, entry.name);
    const stat = await lstat(file);
    if (!stat.isFile() || stat.size > MAX_PAGE_BYTES) throw new Error(`Invalid or oversized capture file: ${file}`);
    totalBytes += stat.size;
    if (totalBytes > MAX_INPUT_BYTES) throw new Error("SC900 capture directory exceeds the 256 MiB input safety limit");
    const bytes = await readFile(file);
    const content = bytes.toString("utf8");
    if (!Buffer.from(content).equals(bytes)) throw new Error(`Capture is not valid UTF-8: ${file}`);
    inputs.push({ path: `${inputPath}/${entry.name}`, content });
  }
  const result = normalizeSc900Captures(inputs, options);
  const directory = resolve(output, result.draftReleaseId);
  await noSymlinks(workspace, directory);
  await mkdir(directory, { recursive: true });
  const assets = resolve(directory, "assets");
  await noSymlinks(workspace, assets);
  await mkdir(assets, { recursive: true });
  for (const asset of result.draftAssets) {
    await writeImmutable(resolve(assets, `${asset.id}.${mediaExtension(asset.contentType)}`), Buffer.from(asset.base64, "base64"));
  }
  await writeImmutable(resolve(directory, "draft.json"), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

export function parseSc900NormalizeArgs(args: string[]): Sc900NormalizeDirectoryOptions & { help?: boolean } {
  const options: Sc900NormalizeDirectoryOptions & { help?: boolean } = {};
  let pages: number | undefined;
  let occurrences: number | undefined;
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (seen.has(argument)) throw new Error(`Repeated argument: ${argument}`);
    seen.add(argument);
    if (argument === "--draft") { options.draft = true; continue; }
    if (argument === "--help") { options.help = true; continue; }
    if (!["--input", "--output", "--expected-pages", "--expected-occurrences"].includes(argument)) throw new Error(`Unknown argument: ${argument}`);
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    if (argument === "--input") options.inputDirectory = value;
    else if (argument === "--output") options.outputDirectory = value;
    else {
      if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`${argument} requires a positive integer`);
      if (argument === "--expected-pages") pages = Number(value);
      else occurrences = Number(value);
    }
  }
  if ((pages === undefined) !== (occurrences === undefined)) throw new Error("Both observed page and occurrence totals are required");
  if (pages !== undefined && occurrences !== undefined) options.expected = { pages, occurrences };
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseSc900NormalizeArgs(process.argv.slice(2));
    if (options.help) {
      console.log("Usage: node --import tsx tools/sc900/normalize.ts [--input .data/sc900/raw/pages] [--output .data/sc900/normalized] [--draft] [--expected-pages N --expected-occurrences N]\nOnly observed source totals permit a verified acquisition ledger. All documents remain provisional; no publication or network access.");
    } else {
      const result = await normalizeSc900Directory(options);
      console.log(JSON.stringify({
        examId: result.examId, draftReleaseId: result.draftReleaseId,
        observedSourceTotals: result.observedSourceTotals, counts: result.counts,
        verifiedCaptureLedger: result.verifiedCaptureLedger !== null, issues: result.issues,
        publicationState: result.publicationState,
      }, null, 2));
      if (result.issues.some((issue) => issue.severity === "error")) process.exitCode = 2;
    }
  } catch (error) {
    console.error(errorText(error));
    process.exitCode = 1;
  }
}
