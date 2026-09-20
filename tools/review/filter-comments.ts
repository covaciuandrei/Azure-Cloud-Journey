import { type Comment, type RichContent } from "../../src/domain/index.js";
import { digest, plainText } from "../ingest/normalize-shared.js";
import { type MaterializeInput } from "./materialize.js";

export const COMMENT_FILTER_VERSION = "conservative-comment-relevance-1";
export type CommentDecision = {
  id: string;
  questionId: string;
  sourceOccurrenceId: string;
  retained: boolean;
  reason: "substantive-or-uncertain" | "reference-or-rich-content" | "disagreement-or-question" |
    "redundant-answer-confirmation" | "courtesy-only" | "exam-attendance-only" |
    "duplicate-sibling" | "thread-context" | "empty" | "not-disputed-question" | "unsupported-comment";
};

const words = (text: string) => text.normalize("NFKC").toLowerCase()
  .replace(/[’']/g, "").match(/[a-z]+|\d+/g) ?? [];
const sorted = (values: string[]) => [...new Set(values)].sort().join(",");
const normalize = (text: string) => text.normalize("NFKC").replace(/\s+/g, " ").trim();
const agreementWords = new Set([
  "selected", "answer", "answers", "ans", "option", "options", "choice", "choices",
  "correct", "right", "valid", "agree", "agreed", "agreement", "absolutely", "definitely",
  "certainly", "indeed", "obviously", "the", "a", "an", "is", "are", "was", "were",
  "given", "provided", "supplied", "official", "this", "that", "it", "its", "as", "and",
  "i", "think", "believe", "vote", "voting", "for", "would", "should", "be",
  "only", "all", "of", "them", "good", "one", "seems", "looks", "to", "me", "same",
  "sequence", "order",
  "yes", "no", "y", "n", "true", "false",
]);
const courtesyWords = new Set([
  "thank", "thanks", "you", "very", "much", "so", "a", "lot", "for", "the", "explanation",
  "clarification", "help", "helpful", "useful", "great", "good", "nice", "clear", "guys",
  "mate", "bro", "sir", "indeed", "understood", "now", "makes", "sense", "got", "it",
]);
const attendanceWords = new Set([
  "this", "these", "that", "the", "a", "an", "question", "questions", "q", "was", "were",
  "is", "in", "on", "my", "i", "it", "came", "come", "appear", "appeared", "got", "had",
  "received", "asked", "seen", "saw", "taken", "took", "today", "yesterday", "tomorrow",
  "exam", "exams", "test", "passed", "pass", "cleared", "clear", "scored", "score",
  "with", "and", "of", "from", "here", "all", "almost", "most", "percent", "points",
  "same", "thanks", "thank", "you", "to", "everyone", "guys", "examtopics", "examtopic",
  "examprepper",   "at", "for", "just", "but", "ok", "ans", "answer", "answers",
  "there", "part", "todays", "today", "answered", "as", "found", "qn", "exactly",
  "around", "also", "out", "date", "dated", "yay", "review", "buddies", "came",
  "correct", "right", "valid", "given", "good", "luck", "st", "nd", "rd", "th",
  "january", "jan", "february", "feb", "march", "mar", "april", "apr", "may", "june",
  "jun", "july", "jul", "august", "aug", "september", "sept", "sep", "october", "oct",
  "november", "nov", "december", "dec",
]);

function hasReferenceOrRichContent(content: RichContent, text: string): boolean {
  if (/\bhttps?:\/\/|\bwww\.|\b(?:learn|docs)\.microsoft\.com/i.test(text)) return true;
  return content.some((block) => {
    if (["code", "image", "table", "list", "quote"].includes(block.type)) return true;
    return (block.type === "text" || block.type === "heading") &&
      block.spans.some((span) => span.type === "link" || span.type === "code");
  });
}

function selectedDeclarations(text: string): { text: string; labels: string[] } {
  const labels: string[] = [];
  const remaining = text.replace(
    /^[ \t]*selected[ \t]+answers?:[ \t]*([A-Z](?:[A-Z,; &/+\t]*[A-Z])?)[ \t]*$/gm,
    (_, selection: string) => {
      labels.push(...selection.replace(/[^A-Z]/g, "").split(""));
      return "";
    },
  );
  return { text: remaining.trim(), labels };
}

function isRedundantConfirmation(
  text: string,
  declaredLabels: string[],
  context: { labels: string[] | null; acceptedWords: string[]; sourceChanged: boolean },
): boolean {
  const tokens = words(text);
  if (tokens.length > 28 || text.includes("?")) return false;
  const labels = [...declaredLabels];
  const semanticBooleans: string[] = [];
  for (const token of tokens) {
    if (/^[a-f]$/.test(token)) {
      labels.push(token.toUpperCase());
    } else if (/^[a-f]{2,6}$/.test(token) && !agreementWords.has(token)) {
      labels.push(...token.toUpperCase().split(""));
    } else if (["yes", "true", "y", "no", "false", "n"].includes(token)) {
      semanticBooleans.push(["yes", "true", "y"].includes(token) ? "yes" : "no");
    } else if (!agreementWords.has(token)) {
      return false;
    }
  }
  if (labels.length) {
    if (!context.labels || sorted(labels) !== sorted(context.labels)) return false;
  }
  if (semanticBooleans.length) {
    if (semanticBooleans.join(",") !== context.acceptedWords.join(",")) return false;
  }
  if (!labels.length && !semanticBooleans.length) {
    if (context.sourceChanged) return false;
    return /\b(correct|right|valid|agree|agreed)\b/i.test(text);
  }
  return true;
}

export function decideComment(
  comment: Comment,
  input: MaterializeInput,
): CommentDecision {
  const decision = (retained: boolean, reason: CommentDecision["reason"]): CommentDecision => ({
    id: comment.id, questionId: comment.questionId, sourceOccurrenceId: comment.sourceOccurrenceId,
    retained, reason,
  });
  const text = comment.bodyText.trim();
  if (!text) return decision(false, "empty");
  if (hasReferenceOrRichContent(comment.body, text)) return decision(true, "reference-or-rich-content");
  if (/\?|\b(?:not|wrong|incorrect|disagree|however|because|why|tested|test(?:ing)?\s+it|tried)\b/i.test(text)) {
    return decision(true, "disagreement-or-question");
  }
  const source = input.sources.find(({ occurrence }) => occurrence.id === comment.sourceOccurrenceId);
  if (!source) throw new Error(`${comment.id}: source occurrence is missing from its question review.`);
  const original = input.answers.originalAnswers.find((answer) => answer.sourceOccurrenceId === source.occurrence.id);
  if (!original) throw new Error(`${comment.id}: original source key is missing.`);
  const selection = selectedDeclarations(text);
  const tokens = words(selection.text);
  if (selection.labels.length === 0 && tokens.length > 0 &&
      tokens.length <= 20 && tokens.every((token) => courtesyWords.has(token))) {
    return decision(false, "courtesy-only");
  }
  const sourceLabels = source.review.effectiveSourceLabels;
  const sourceChanged = source.review.answerStatus === "corrected" ||
    (sourceLabels !== null && sorted(sourceLabels) !== sorted(original.sourceLabels));
  const expectedTexts = sourceLabels?.map((label) => {
    const id = source.occurrence.sourceLabelToOptionId[label];
    const option = input.question.options.find((candidate) => candidate.id === id);
    return option ? plainText(option.content).trim().toLowerCase() : "";
  }) ?? [];
  const summary = source.review.effectiveImageAnswerSummary ?? source.review.sourceImageAnswerSummary;
  const imageTokens = summary ? words(summary) : [];
  const acceptedWords = expectedTexts.length === 1 && /^(yes|no|true|false)$/.test(expectedTexts[0] ?? "")
    ? [expectedTexts[0] === "true" ? "yes" : expectedTexts[0] === "false" ? "no" : expectedTexts[0]!]
    : imageTokens.length > 0 && imageTokens.every((token) => ["yes", "no", "y", "n"].includes(token))
      ? imageTokens.map((token) => ["yes", "y"].includes(token) ? "yes" : "no") : [];
  if (["unresolved", "outdated-or-defective"].includes(source.review.answerStatus)) {
    return decision(true, "substantive-or-uncertain");
  }
  if (isRedundantConfirmation(selection.text, selection.labels, {
    labels: sourceLabels, acceptedWords, sourceChanged,
  })) {
    return decision(false, "redundant-answer-confirmation");
  }
  const plainAnswer = normalize(selection.text)
    .replace(/^(?:(?:the\s+)?(?:correct\s+)?(?:answer|ans|option|choice)\s*(?:is\s+|:\s*)?)/i, "")
    .replace(/\s+(?:is|are)\s+(?:the\s+)?(?:correct|right)(?:\s+answer)?[.!]*$/i, "")
    .replace(/[.!]+$/, "").toLowerCase();
  if (sourceLabels?.length === 1 && expectedTexts.length === 1 &&
      plainAnswer === normalize(expectedTexts[0]!).replace(/[.!]+$/, "").toLowerCase() &&
      (!selection.labels.length || sorted(selection.labels) === sorted(sourceLabels))) {
    return decision(false, "redundant-answer-confirmation");
  }
  if (text.length <= 260 && tokens.some((token) => ["exam", "exams", "passed", "scored"].includes(token)) &&
      tokens.every((token) => attendanceWords.has(token) || /^\d+$/.test(token)) &&
      (!selection.labels.length || (sourceLabels && sorted(selection.labels) === sorted(sourceLabels)))) {
    return decision(false, "exam-attendance-only");
  }
  return decision(true, "substantive-or-uncertain");
}

export function filterQuestionComments(
  input: MaterializeInput, comments: Comment[],
): { comments: Comment[]; decisions: CommentDecision[] } {
  const expectedIds = new Set(input.sources.flatMap(({ occurrence }) => occurrence.commentIds));
  if (comments.length !== expectedIds.size || new Set(comments.map((comment) => comment.id)).size !== comments.length ||
      comments.some((comment) => !expectedIds.has(comment.id) || comment.questionId !== input.question.id)) {
    throw new Error(`${input.question.id}: relevance filtering requires the complete original discussion.`);
  }
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const decisions = new Map(comments.map((comment) => [comment.id, decideComment(comment, input)]));
  const seen = new Map<string, string>();
  for (const comment of [...comments].sort((a, b) => a.treePath.join(".").localeCompare(b.treePath.join(".")))) {
    if (comment.childIds.length || !decisions.get(comment.id)?.retained) continue;
    const signature = digest({
      parent: comment.parentId, occurrence: comment.sourceOccurrenceId,
      text: normalize(comment.bodyText), content: comment.body,
    });
    if (seen.has(signature)) {
      decisions.set(comment.id, { ...decisions.get(comment.id)!, retained: false, reason: "duplicate-sibling" });
    } else seen.set(signature, comment.id);
  }
  for (const comment of comments) {
    if (!decisions.get(comment.id)?.retained) continue;
    let parentId = comment.parentId;
    const visited = new Set<string>([comment.id]);
    while (parentId) {
      if (visited.has(parentId)) throw new Error(`${comment.id}: cyclic comment ancestry.`);
      visited.add(parentId);
      const parent = byId.get(parentId);
      const decision = decisions.get(parentId);
      if (!parent || !decision) throw new Error(`${comment.id}: missing parent ${parentId}.`);
      if (!decision.retained) decisions.set(parentId, { ...decision, retained: true, reason: "thread-context" });
      parentId = parent.parentId;
    }
  }
  const retained = new Set([...decisions.values()].filter((decision) => decision.retained).map((decision) => decision.id));
  return {
    comments: comments.filter((comment) => retained.has(comment.id)).map((comment) => ({
      ...comment, childIds: comment.childIds.filter((id) => retained.has(id)),
    })),
    decisions: [...decisions.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
}
